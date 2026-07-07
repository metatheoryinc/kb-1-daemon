import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { DocumentSessionManager } from '@kb-1/doc-session';
import { createVaultService, type VaultChangeEvent, type VaultService } from '@kb-1/vault-service';
import { normalizeFolderMetadataColor, type VaultActor } from '@kb-1/vault-core';
import { slug as githubSlug } from 'github-slugger';

import { seedVaultFromStarterKit } from './starter-kit.js';

const VAULT_IDENTITY_DIR = '.kb2';
const VAULT_IDENTITY_FILE = 'vault.json';

/** Home-level directory that holds soft-deleted vault folders (reversible). */
export const VAULT_TRASH_DIRNAME = '.trash';

/** Durable identity for a single vault, stored at `<vault>/.kb2/vault.json`. */
export interface VaultIdentity {
  /** Stable unique slug for the vault within this daemon. */
  id: string;
  /** Human-facing name; defaults to the folder name on first sight. */
  displayName: string;
  /** Presentation metadata for the vault root. */
  metadata?: VaultMetadata;
}

export interface VaultMetadata {
  color?: string;
}

export interface VaultMetadataInput {
  color?: string | null;
}

/** A vault the daemon knows about: identity plus its on-disk root. */
export interface VaultRegistryEntry {
  slug: string;
  displayName: string;
  root: string;
  metadata?: VaultMetadata;
}

/** A live, root-scoped instance serving one vault. */
export interface VaultInstance {
  entry: VaultRegistryEntry;
  service: VaultService;
  manager: DocumentSessionManager;
}

export interface VaultRegistryChangeEvent {
  vaultSlug: string;
  event: VaultChangeEvent;
}

export type VaultRegistryChangeEventHandler = (event: VaultRegistryChangeEvent) => void;

export interface VaultRegistryOptions {
  historyCoalesceWindowMs?: number;
}

/**
 * Normalize a string into a vault slug using github-slugger (battle-tested, not
 * hand-rolled). Used to derive a slug from a folder name when minting identity,
 * and as the basis for {@link isWellFormedSlug}. Stateless: it does not dedupe
 * across calls, so the same input always yields the same output.
 */
export function slugify(value: string): string {
  return githubSlug(value);
}

/**
 * Whether a caller-supplied slug is well-formed: non-empty AND already
 * normalized (idempotent under {@link slugify} — slugging it again leaves it
 * unchanged). Server and client share this exact definition so a slug the UI
 * suggests is accepted verbatim by the server.
 */
export function isWellFormedSlug(slug: string): boolean {
  return slug.length > 0 && slugify(slug) === slug;
}

function identityPath(vaultRoot: string): string {
  return join(vaultRoot, VAULT_IDENTITY_DIR, VAULT_IDENTITY_FILE);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Read a vault's identity, minting and persisting one if absent. The minted
 * slug and display name both default from the folder name.
 */
export async function readOrMintVaultIdentity(vaultRoot: string, folderName: string): Promise<VaultIdentity> {
  const file = identityPath(vaultRoot);

  let raw: string | undefined;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (!isNodeErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }

  if (raw !== undefined) {
    const parsed = parseVaultIdentity(raw, file);
    return parsed;
  }

  const identity: VaultIdentity = {
    id: slugify(folderName),
    displayName: folderName
  };
  await writeVaultIdentity(vaultRoot, identity);
  return identity;
}

/** Persist a vault's identity to `<vault>/.kb2/vault.json`, creating `.kb2` if needed. */
export async function writeVaultIdentity(vaultRoot: string, identity: VaultIdentity): Promise<void> {
  const payload: VaultIdentity = {
    id: identity.id,
    displayName: identity.displayName,
    ...(identity.metadata && !isEmptyVaultMetadata(identity.metadata)
      ? { metadata: cloneVaultMetadata(identity.metadata) }
      : {})
  };
  await mkdir(join(vaultRoot, VAULT_IDENTITY_DIR), { recursive: true });
  await writeFile(identityPath(vaultRoot), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseVaultIdentity(raw: string, file: string): VaultIdentity {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Malformed vault identity at ${file}: not valid JSON.`);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed vault identity at ${file}: expected a JSON object.`);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim().length === 0) {
    throw new Error(`Malformed vault identity at ${file}: "id" must be a non-empty string.`);
  }

  const displayName = typeof record.displayName === 'string' && record.displayName.trim().length > 0
    ? record.displayName
    : record.id;
  const metadata = parseVaultMetadata(record.metadata, file);

  return { id: record.id, displayName, ...(metadata ? { metadata } : {}) };
}

function parseVaultMetadata(value: unknown, file: string): VaultMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed vault identity at ${file}: "metadata" must be a JSON object.`);
  }

  const record = value as Record<string, unknown>;
  const metadata: VaultMetadata = {};
  if (Object.prototype.hasOwnProperty.call(record, 'color')) {
    if (typeof record.color !== 'string') {
      throw new Error(`Malformed vault identity at ${file}: "metadata.color" must be a string.`);
    }
    const color = normalizeFolderMetadataColor(record.color);
    if (!color) {
      throw new Error(`Malformed vault identity at ${file}: "metadata.color" must be "inherit" or a hex color.`);
    }
    metadata.color = color;
  }

  return isEmptyVaultMetadata(metadata) ? undefined : metadata;
}

/**
 * Migrate the legacy single-vault layout (`<home>/<legacyDirname>/`) into the
 * registry layout (`<home>/vaults/<legacyDirname>/`) using copy -> verify ->
 * cleanup so an interrupted run never loses the original. Idempotent: a no-op
 * once `<home>/vaults/` exists or the legacy directory is gone.
 */
export async function migrateLegacyVaultLayout(options: {
  legacyVaultDir: string;
  vaultsHome: string;
  targetSlug: string;
}): Promise<{ migrated: boolean }> {
  const { legacyVaultDir, vaultsHome, targetSlug } = options;

  if (await pathExists(vaultsHome)) {
    return { migrated: false };
  }

  if (!(await isDirectory(legacyVaultDir))) {
    return { migrated: false };
  }

  const target = join(vaultsHome, targetSlug);
  await mkdir(vaultsHome, { recursive: true });

  // COPY: copy-not-move so the original survives an interrupted run.
  await cp(legacyVaultDir, target, { recursive: true });

  // VERIFY: file set + sizes must match before we delete anything.
  await verifyCopy(legacyVaultDir, target);

  // CLEANUP: only after a verified copy.
  await rm(legacyVaultDir, { recursive: true, force: true });

  return { migrated: true };
}

async function verifyCopy(source: string, target: string): Promise<void> {
  const sourceFiles = await listFilesWithSizes(source);
  const targetFiles = await listFilesWithSizes(target);

  for (const [relPath, size] of sourceFiles) {
    const copiedSize = targetFiles.get(relPath);
    if (copiedSize === undefined) {
      throw new Error(`Vault migration verification failed: ${relPath} missing from copy.`);
    }
    if (copiedSize !== size) {
      throw new Error(
        `Vault migration verification failed: ${relPath} size mismatch (source ${size}, copy ${copiedSize}).`
      );
    }
  }
}

async function listFilesWithSizes(root: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const info = await stat(abs);
        sizes.set(relative(root, abs), info.size);
      }
    }
  }

  await walk(root);
  return sizes;
}

/**
 * Discover every vault directory under `vaultsHome`, mint identities as needed,
 * and return registry entries. Throws if two vaults resolve to the same slug.
 */
export async function discoverVaults(vaultsHome: string): Promise<VaultRegistryEntry[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(vaultsHome, { withFileTypes: true });
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }

  const bySlug = new Map<string, VaultRegistryEntry>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const root = join(vaultsHome, entry.name);
    const identity = await readOrMintVaultIdentity(root, entry.name);

    const existing = bySlug.get(identity.id);
    if (existing) {
      throw new Error(
        `Duplicate vault slug "${identity.id}" found in ${existing.root} and ${root}. ` +
          'Vault slugs must be unique within a daemon.'
      );
    }

    bySlug.set(identity.id, {
      slug: identity.id,
      displayName: identity.displayName,
      root,
      ...(identity.metadata ? { metadata: cloneVaultMetadata(identity.metadata) } : {})
    });
  }

  return [...bySlug.values()];
}

/** Build a root-scoped service + document manager per discovered vault. */
export function buildVaultInstances(entries: VaultRegistryEntry[], options: VaultRegistryOptions = {}): Map<string, VaultInstance> {
  const instances = new Map<string, VaultInstance>();
  for (const entry of entries) {
    instances.set(entry.slug, buildVaultInstance(entry, options));
  }
  return instances;
}

/** A summary of a vault for listing: stable slug as `id` plus its display name. */
export interface VaultSummary {
  id: string;
  displayName: string;
  metadata?: VaultMetadata;
}

/** Error codes the registry can return for vault-management operations. */
export type VaultRegistryErrorCode = 'invalid_request' | 'already_exists' | 'not_found';

export type VaultRegistryResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: VaultRegistryErrorCode; message: string };

/**
 * Live, mutable registry of the vaults a daemon serves. Built from a disk scan
 * at boot and kept in sync as vaults are created, renamed, and soft-deleted at
 * runtime — no restart required. The filesystem stays the source of truth; the
 * registry mirrors it (identity always lands in `.kb2/vault.json` first).
 */
export class VaultRegistry {
  private readonly instances: Map<string, VaultInstance>;
  private readonly eventHandlers = new Set<VaultRegistryChangeEventHandler>();
  private readonly eventUnsubscribers = new Map<string, () => void>();

  private constructor(
    private readonly vaultsHome: string,
    private readonly trashHome: string,
    private readonly options: VaultRegistryOptions,
    instances: Map<string, VaultInstance>
  ) {
    this.instances = instances;
  }

  /** Scan `vaultsHome`, mint identities as needed, and build one instance per vault. */
  static async load(vaultsHome: string, trashHome: string, options: VaultRegistryOptions = {}): Promise<VaultRegistry> {
    const entries = await discoverVaults(vaultsHome);
    const instances = buildVaultInstances(entries, options);
    return new VaultRegistry(vaultsHome, trashHome, options, instances);
  }

  /** Every registered vault as `{ id, displayName }`, ordered by slug. */
  list(): VaultSummary[] {
    return [...this.instances.values()]
      .map((instance) => this.summaryFor(instance))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async storageUsageBytes(): Promise<number> {
    return (
      await directorySizeBytes(this.vaultsHome) +
      await directorySizeBytes(this.trashHome)
    );
  }

  /** Resolve a vault's live instance by slug, or `undefined` when unknown. */
  get(id: string): VaultInstance | undefined {
    return this.instances.get(id);
  }

  onVaultEvent(handler: VaultRegistryChangeEventHandler): () => void {
    this.eventHandlers.add(handler);
    if (this.eventHandlers.size === 1) {
      for (const instance of this.instances.values()) {
        this.subscribeInstance(instance);
      }
    }

    return () => {
      this.eventHandlers.delete(handler);
      if (this.eventHandlers.size === 0) {
        this.unsubscribeAllInstances();
      }
    };
  }

  /**
   * Create a fresh, essentially-empty vault in the primary `vaultsHome`. The
   * caller supplies BOTH the display name and the slug; the daemon never infers
   * the slug from the display name. The slug must be well-formed (non-empty and
   * already normalized) and unique within the daemon — a bad slug is a clean
   * `invalid_request`, a collision a clean `already_exists`, never a crash. The
   * folder is still owned by the daemon (placed at `vaultsHome/<slug>/`). The
   * vault registers live and is immediately servable.
   */
  async create(input: { displayName: string; slug: string }): Promise<VaultRegistryResult<{ vault: VaultSummary }>> {
    const displayName = input.displayName.trim();
    if (displayName.length === 0) {
      return { ok: false, error: 'invalid_request', message: 'displayName must be a non-empty string' };
    }

    const slug = input.slug;
    if (!isWellFormedSlug(slug)) {
      return {
        ok: false,
        error: 'invalid_request',
        message: 'slug must be non-empty and already normalized (lowercase, hyphen-separated).'
      };
    }
    if (this.instances.has(slug)) {
      return { ok: false, error: 'already_exists', message: `A vault with id "${slug}" already exists.` };
    }

    const root = join(this.vaultsHome, slug);
    // Disk first: a directory already sitting here means another vault owns the
    // slot even if it is not loaded; refuse rather than clobber user data.
    if (await pathExists(root)) {
      return { ok: false, error: 'already_exists', message: `A vault folder already exists at id "${slug}".` };
    }

    await mkdir(root, { recursive: true });
    const identity: VaultIdentity = { id: slug, displayName };
    await writeVaultIdentity(root, identity);

    // Every newly created vault starts from the bundled starter kit. The seeder
    // is a no-op on a vault that already has user content, so this is safe even
    // though identity was just written above (`.kb2` does not count as content).
    await seedVaultFromStarterKit(root);

    const entry: VaultRegistryEntry = { slug, displayName, root };
    const instance = buildVaultInstance(entry, this.options);
    this.instances.set(slug, instance);
    this.subscribeInstance(instance);

    return { ok: true, vault: { id: slug, displayName } };
  }

  /**
   * Rename a vault: change its display name only. The slug/id and on-disk
   * folder are immutable, so identity in `.kb2/vault.json` is rewritten but the
   * folder never moves.
   */
  async rename(id: string, input: { displayName: string }): Promise<VaultRegistryResult<{ vault: VaultSummary }>> {
    const displayName = input.displayName.trim();
    if (displayName.length === 0) {
      return { ok: false, error: 'invalid_request', message: 'displayName must be a non-empty string' };
    }

    const instance = this.instances.get(id);
    if (!instance) {
      return { ok: false, error: 'not_found', message: `No vault with id "${id}".` };
    }

    const identity: VaultIdentity = {
      id: instance.entry.slug,
      displayName,
      ...(instance.entry.metadata ? { metadata: cloneVaultMetadata(instance.entry.metadata) } : {})
    };
    await writeVaultIdentity(instance.entry.root, identity);
    instance.entry.displayName = displayName;

    return { ok: true, vault: this.summaryFor(instance) };
  }

  async setMetadata(
    id: string,
    input: VaultMetadataInput,
    actor: VaultActor
  ): Promise<VaultRegistryResult<{ vault: VaultSummary }>> {
    const instance = this.instances.get(id);
    if (!instance) {
      return { ok: false, error: 'not_found', message: `No vault with id "${id}".` };
    }

    const normalized = normalizeVaultMetadataInput(input);
    if (!normalized.ok) return normalized;

    const nextMetadata = applyVaultMetadataInput(instance.entry.metadata ?? {}, normalized.value);
    const identity: VaultIdentity = {
      id: instance.entry.slug,
      displayName: instance.entry.displayName,
      ...(isEmptyVaultMetadata(nextMetadata) ? {} : { metadata: nextMetadata })
    };
    await writeVaultIdentity(instance.entry.root, identity);

    if (isEmptyVaultMetadata(nextMetadata)) {
      delete instance.entry.metadata;
    } else {
      instance.entry.metadata = cloneVaultMetadata(nextMetadata);
    }

    this.emitVaultEvent(instance.entry.slug, {
      kind: 'vault_metadata_changed',
      path: '',
      actor,
      ts: new Date().toISOString()
    });

    return { ok: true, vault: this.summaryFor(instance) };
  }

  /**
   * Soft-delete a vault: move its folder to the home-level trash (reversible,
   * never a hard delete of user data) and drop it from the live registry. The
   * vault's document sessions are closed first so nothing keeps writing into a
   * folder that is being moved out from under it.
   */
  async softDelete(id: string): Promise<VaultRegistryResult<{ trashedTo: string }>> {
    const instance = this.instances.get(id);
    if (!instance) {
      return { ok: false, error: 'not_found', message: `No vault with id "${id}".` };
    }

    this.unsubscribeInstance(id);
    await instance.manager.close();

    await mkdir(this.trashHome, { recursive: true });
    const destination = await uniqueTrashDestination(this.trashHome, id);
    await rename(instance.entry.root, destination);

    this.instances.delete(id);

    return { ok: true, trashedTo: destination };
  }

  /** Close every vault's document session manager (used on daemon shutdown). */
  async close(): Promise<void> {
    this.unsubscribeAllInstances();
    await Promise.all([...this.instances.values()].map((instance) => instance.manager.close()));
  }

  private subscribeInstance(instance: VaultInstance): void {
    if (this.eventHandlers.size === 0 || this.eventUnsubscribers.has(instance.entry.slug)) return;

    const unsubscribe = instance.service.onEvent((event) => {
      const registryEvent = { vaultSlug: instance.entry.slug, event };
      for (const handler of this.eventHandlers) {
        try {
          handler(registryEvent);
        } catch (error) {
          console.warn('KB-1 vault registry event handler failed.', error);
        }
      }
    });
    this.eventUnsubscribers.set(instance.entry.slug, unsubscribe);
  }

  private emitVaultEvent(vaultSlug: string, event: VaultChangeEvent): void {
    const registryEvent = { vaultSlug, event };
    for (const handler of this.eventHandlers) {
      try {
        handler(registryEvent);
      } catch (error) {
        console.warn('KB-1 vault registry event handler failed.', error);
      }
    }
  }

  private summaryFor(instance: VaultInstance): VaultSummary {
    return {
      id: instance.entry.slug,
      displayName: instance.entry.displayName,
      ...(instance.entry.metadata && !isEmptyVaultMetadata(instance.entry.metadata)
        ? { metadata: cloneVaultMetadata(instance.entry.metadata) }
        : {})
    };
  }

  private unsubscribeInstance(slug: string): void {
    const unsubscribe = this.eventUnsubscribers.get(slug);
    if (!unsubscribe) return;

    this.eventUnsubscribers.delete(slug);
    unsubscribe();
  }

  private unsubscribeAllInstances(): void {
    for (const slug of [...this.eventUnsubscribers.keys()]) {
      this.unsubscribeInstance(slug);
    }
  }
}

function cloneVaultMetadata(metadata: VaultMetadata): VaultMetadata {
  return { ...(metadata.color === undefined ? {} : { color: metadata.color }) };
}

function isEmptyVaultMetadata(metadata: VaultMetadata): boolean {
  return metadata.color === undefined;
}

function normalizeVaultMetadataInput(
  input: VaultMetadataInput
): VaultRegistryResult<{ value: VaultMetadataInput }> {
  const normalized: VaultMetadataInput = {};
  if (Object.prototype.hasOwnProperty.call(input, 'color')) {
    if (input.color === null) {
      normalized.color = null;
    } else if (typeof input.color === 'string') {
      const color = normalizeFolderMetadataColor(input.color);
      if (!color) {
        return {
          ok: false,
          error: 'invalid_request',
          message: 'metadata.color must be "inherit" or a hex color'
        };
      }
      normalized.color = color;
    } else {
      return {
        ok: false,
        error: 'invalid_request',
        message: 'metadata.color must be a string or null'
      };
    }
  }
  return { ok: true, value: normalized };
}

function applyVaultMetadataInput(
  current: VaultMetadata,
  input: VaultMetadataInput
): VaultMetadata {
  const next = cloneVaultMetadata(current);
  if (Object.prototype.hasOwnProperty.call(input, 'color')) {
    if (input.color === null) {
      delete next.color;
    } else if (input.color !== undefined) {
      next.color = input.color;
    }
  }
  return next;
}

/** Build a single root-scoped service + document manager for one vault entry. */
function buildVaultInstance(entry: VaultRegistryEntry, options: VaultRegistryOptions = {}): VaultInstance {
  const manager = new DocumentSessionManager({ root: entry.root });
  const service = createVaultService({
    vaultRoot: entry.root,
    documentSessions: manager,
    historyCoalesceWindowMs: options.historyCoalesceWindowMs
  });
  return { entry, service, manager };
}

/**
 * Pick a collision-free path under the trash home for a soft-deleted vault.
 * Re-deleting a slug that was already trashed (and never restored) appends a
 * numeric suffix so an earlier trashed copy is never overwritten.
 */
async function uniqueTrashDestination(trashHome: string, id: string): Promise<string> {
  const base = join(trashHome, id);
  if (!(await pathExists(base))) {
    return base;
  }

  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

async function directorySizeBytes(path: string): Promise<number> {
  const entries = await readDirectoryEntries(path);
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(child);
      continue;
    }
    const info = await stat(child);
    if (info.isFile()) total += info.size;
  }
  return total;
}

async function readDirectoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
}
