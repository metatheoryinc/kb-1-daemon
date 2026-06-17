import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { DocumentSessionManager } from '@kb-2/doc-session';
import { createVaultService, type VaultService } from '@kb-2/vault-service';

const VAULT_IDENTITY_DIR = '.kb2';
const VAULT_IDENTITY_FILE = 'vault.json';

/** Durable identity for a single vault, stored at `<vault>/.kb2/vault.json`. */
export interface VaultIdentity {
  /** Stable unique slug for the vault within this daemon. */
  id: string;
  /** Human-facing name; defaults to the folder name on first sight. */
  displayName: string;
}

/** A vault the daemon knows about: identity plus its on-disk root. */
export interface VaultRegistryEntry {
  slug: string;
  displayName: string;
  root: string;
}

/** A live, root-scoped instance serving one vault. */
export interface VaultInstance {
  entry: VaultRegistryEntry;
  service: VaultService;
  manager: DocumentSessionManager;
}

/**
 * Derive a slug from a folder name. Lowercases, replaces runs of
 * non-alphanumeric characters with a single hyphen, and trims hyphens.
 * Falls back to `vault` when nothing usable remains.
 */
export function slugFromFolderName(folderName: string): string {
  const slug = folderName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug.length > 0 ? slug : 'vault';
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
    id: slugFromFolderName(folderName),
    displayName: folderName
  };
  await mkdir(join(vaultRoot, VAULT_IDENTITY_DIR), { recursive: true });
  await writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
  return identity;
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

  return { id: record.id, displayName };
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

    bySlug.set(identity.id, { slug: identity.id, displayName: identity.displayName, root });
  }

  return [...bySlug.values()];
}

/** Build a root-scoped service + document manager per discovered vault. */
export function buildVaultInstances(entries: VaultRegistryEntry[]): Map<string, VaultInstance> {
  const instances = new Map<string, VaultInstance>();
  for (const entry of entries) {
    const manager = new DocumentSessionManager({ root: entry.root });
    const service = createVaultService({ vaultRoot: entry.root, documentSessions: manager });
    instances.set(entry.slug, { entry, service, manager });
  }
  return instances;
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
