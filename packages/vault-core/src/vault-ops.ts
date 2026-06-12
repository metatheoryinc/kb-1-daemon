import {
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { emitVaultAudit, type AuditEntry, type VaultActor } from './audit.js';
import {
  folderMetadataColorNames,
  folderMetadataIconNames,
  type FolderMetadataColor,
  type FolderMetadataIcon
} from './folder-metadata-options.js';
import { isNodeError, statOrNull } from './fs.js';
import {
  InvalidPathError,
  relativeDescendantPath,
  resolveVaultPath,
  validateOptionalVaultPath,
  validateVaultPath
} from './path.js';

export { emitVaultAudit, InvalidPathError, validateVaultPath };
export type { AuditEntry, VaultActor };

export type VaultErrorCode =
  | 'invalid_path'
  | 'invalid_metadata'
  | 'not_found'
  | 'already_exists'
  | 'path_collision'
  | 'folder_not_empty'
  | 'entry_cap_exceeded'
  | 'metadata_parse_failed';

export type VaultResult<T> = { ok: true; value: T } | { ok: false; error: VaultErrorCode; message: string };

export interface VaultContext {
  root: string;
  actor?: VaultActor;
}

export interface VaultEntry {
  path: string;
  kind: 'file' | 'folder';
  size: number;
  mtimeMs: number;
  metadata?: FolderMetadata;
}

export interface VaultInfo {
  rootName: string;
  fileCount: number;
  folderCount: number;
}

export interface ReadFileValue {
  path: string;
  content: string;
  size: number;
  mtimeMs: number;
}

export interface WriteFileValue {
  path: string;
  size: number;
  mtimeMs: number;
  audit: AuditEntry;
}

export interface DeleteValue {
  path: string;
  trashPath?: string;
  permanent: boolean;
  audit: AuditEntry;
}

export interface MoveValue {
  fromPath: string;
  toPath: string;
  kind: 'file' | 'folder';
  audit: AuditEntry;
}

export interface FolderMetadata {
  color?: FolderMetadataColor;
  icon?: FolderMetadataIcon;
}

export interface FolderMetadataInput {
  color?: string | null;
  icon?: string | null;
}

export interface FolderMetadataValue {
  path: string;
  metadata: FolderMetadata;
  audit?: AuditEntry;
}

export type FolderMetadataMap = Record<string, FolderMetadata>;

const DEFAULT_DEPTH = 10;
const DEFAULT_ENTRY_CAP = 5000;
const FOLDER_METADATA_RELATIVE_PATH = path.posix.join('.kb2', 'folders.yml');
const folderMetadataColorSet = new Set<string>(folderMetadataColorNames);
const folderMetadataIconSet = new Set<string>(folderMetadataIconNames);
const folderMetadataMutationQueues = new Map<string, Promise<void>>();

function ignoreMutationQueueResult(): void {
  return undefined;
}

class EntryCapExceededError extends Error {
  constructor() {
    super('entry_cap_exceeded');
    this.name = 'EntryCapExceededError';
  }
}

function fail(error: VaultErrorCode, message: string): VaultResult<never> {
  return { ok: false, error, message };
}

function metadataFileFailure(message = 'folder metadata file is malformed'): VaultResult<never> {
  return fail('metadata_parse_failed', message);
}

function classifyPathError(err: unknown): VaultResult<never> | null {
  if (err instanceof InvalidPathError) return fail('invalid_path', err.message);
  return null;
}

function classifyFsCollision(err: unknown): VaultResult<never> | null {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err.code === 'ENOTDIR' || err.code === 'EEXIST')
  ) {
    return fail('path_collision', 'path collides with an existing file or folder');
  }
  return null;
}

async function exists(absPath: string): Promise<boolean> {
  return await statOrNull(absPath) !== null;
}

function vaultPath(root: string, relPath: string): string {
  return resolveVaultPath(root, relPath);
}

function folderMetadataPath(root: string): string {
  return resolveVaultPath(root, FOLDER_METADATA_RELATIVE_PATH);
}

function trashRelativePath(originalPath: string): string {
  return path.posix.join('.kb2', 'trash', new Date().toISOString(), originalPath);
}

function isHiddenMetadataPath(relPath: string): boolean {
  return relPath === '.kb2' || relPath.startsWith('.kb2/');
}

async function walkEntries(
  root: string,
  relDir: string,
  currentDepth: number,
  maxDepth: number,
  cap: number,
  entries: VaultEntry[]
): Promise<void> {
  if (entries.length >= cap) throw new EntryCapExceededError();
  if (currentDepth > maxDepth) return;
  const absDir = relDir.length === 0 ? root : vaultPath(root, relDir);
  const dirents = await readdir(absDir, { withFileTypes: true });
  for (const dirent of dirents) {
    const rel = relDir.length === 0 ? dirent.name : path.posix.join(relDir, dirent.name);
    if (isHiddenMetadataPath(rel)) continue;
    const abs = vaultPath(root, rel);
    const s = await stat(abs);
    if (dirent.isDirectory()) {
      entries.push({ path: rel, kind: 'folder', size: 0, mtimeMs: s.mtimeMs });
      if (entries.length >= cap) throw new EntryCapExceededError();
      await walkEntries(root, rel, currentDepth + 1, maxDepth, cap, entries);
    } else if (dirent.isFile()) {
      entries.push({ path: rel, kind: 'file', size: s.size, mtimeMs: s.mtimeMs });
      if (entries.length >= cap) throw new EntryCapExceededError();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneMetadata(metadata: FolderMetadata): FolderMetadata {
  return {
    ...(metadata.color !== undefined ? { color: metadata.color } : {}),
    ...(metadata.icon !== undefined ? { icon: metadata.icon } : {})
  };
}

function isEmptyMetadata(metadata: FolderMetadata): boolean {
  return metadata.color === undefined && metadata.icon === undefined;
}

function normalizeFolderMetadataEntry(value: unknown): VaultResult<FolderMetadata> {
  if (!isRecord(value)) return metadataFileFailure();

  const metadata: FolderMetadata = {};
  if (value.color !== undefined) {
    if (typeof value.color !== 'string' || !folderMetadataColorSet.has(value.color)) {
      return metadataFileFailure();
    }
    metadata.color = value.color as FolderMetadataColor;
  }

  if (value.icon !== undefined && value.icon !== null) {
    if (typeof value.icon !== 'string' || !folderMetadataIconSet.has(value.icon)) {
      return metadataFileFailure();
    }
    metadata.icon = value.icon as FolderMetadataIcon;
  }

  return { ok: true, value: metadata };
}

function normalizeFolderMetadataInput(input: FolderMetadataInput): VaultResult<FolderMetadataInput> {
  const metadata: FolderMetadataInput = {};

  if (Object.prototype.hasOwnProperty.call(input, 'color')) {
    if (input.color !== null && (typeof input.color !== 'string' || !folderMetadataColorSet.has(input.color))) {
      return fail('invalid_metadata', 'color must be one of the supported accent names or null');
    }
    metadata.color = input.color;
  }

  if (Object.prototype.hasOwnProperty.call(input, 'icon')) {
    if (input.icon !== null && (typeof input.icon !== 'string' || !folderMetadataIconSet.has(input.icon))) {
      return fail('invalid_metadata', 'icon must be one of the supported icon names or null');
    }
    metadata.icon = input.icon;
  }

  return { ok: true, value: metadata };
}

async function readFolderMetadataMap(root: string): Promise<VaultResult<FolderMetadataMap>> {
  let content: string;
  try {
    content = await readFile(folderMetadataPath(root), 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { ok: true, value: {} };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return metadataFileFailure();
  }

  if (!isRecord(parsed) || !isRecord(parsed.folders)) return metadataFileFailure();

  const map: FolderMetadataMap = {};
  for (const [folderPath, rawMetadata] of Object.entries(parsed.folders)) {
    try {
      validateVaultPath(folderPath, 'folder');
    } catch {
      return metadataFileFailure();
    }
    const normalized = normalizeFolderMetadataEntry(rawMetadata);
    if (!normalized.ok) return normalized;
    if (!isEmptyMetadata(normalized.value)) {
      map[folderPath] = normalized.value;
    }
  }

  return { ok: true, value: map };
}

async function writeFolderMetadataMap(root: string, metadata: FolderMetadataMap): Promise<void> {
  const filePath = folderMetadataPath(root);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });

  const sortedFolders = Object.fromEntries(
    Object.entries(metadata)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([folderPath, folderMetadata]) => [folderPath, cloneMetadata(folderMetadata)])
  );
  const content = stringifyYaml({ folders: sortedFolders });
  const temporaryPath = path.join(directory, `.${process.pid}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    /* v8 ignore start -- Cleanup runs only after an atomic-write filesystem failure; success-path durability is covered by raw folders.yml assertions. */
    await rm(temporaryPath, { force: true });
    throw error;
    /* v8 ignore stop */
  }
}

async function withFolderMetadataMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const previous = folderMetadataMutationQueues.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const next = run.then(ignoreMutationQueueResult, ignoreMutationQueueResult);
  folderMetadataMutationQueues.set(key, next);

  try {
    return await run;
  } finally {
    if (folderMetadataMutationQueues.get(key) === next) {
      folderMetadataMutationQueues.delete(key);
    }
  }
}

function applyFolderMetadataInput(current: FolderMetadata, input: FolderMetadataInput): FolderMetadata {
  const next = cloneMetadata(current);

  if (Object.prototype.hasOwnProperty.call(input, 'color')) {
    if (input.color === null) {
      delete next.color;
    } else if (input.color !== undefined) {
      next.color = input.color as FolderMetadataColor;
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'icon')) {
    if (input.icon === null) {
      delete next.icon;
    } else if (input.icon !== undefined) {
      next.icon = input.icon as FolderMetadataIcon;
    }
  }

  return next;
}

function removeFolderMetadataSubtree(metadata: FolderMetadataMap, deletedPath: string): FolderMetadataMap {
  return Object.fromEntries(
    Object.entries(metadata).filter(([folderPath]) => {
      return folderPath !== deletedPath && relativeDescendantPath(deletedPath, folderPath) === null;
    })
  );
}

function moveFolderMetadataSubtree(metadata: FolderMetadataMap, fromPath: string, toPath: string): FolderMetadataMap {
  const next: FolderMetadataMap = {};
  for (const [folderPath, folderMetadata] of Object.entries(metadata)) {
    const fromDescendant = relativeDescendantPath(fromPath, folderPath);
    if (fromDescendant !== null) {
      const movedPath = fromDescendant.length === 0 ? toPath : path.posix.join(toPath, fromDescendant);
      next[movedPath] = folderMetadata;
      continue;
    }

    if (folderPath === toPath || relativeDescendantPath(toPath, folderPath) !== null) {
      continue;
    }

    next[folderPath] = folderMetadata;
  }
  return next;
}

function attachFolderMetadata(entries: VaultEntry[], metadata: FolderMetadataMap): VaultEntry[] {
  return entries.map((entry) => {
    if (entry.kind !== 'folder' || metadata[entry.path] === undefined) return entry;
    return { ...entry, metadata: cloneMetadata(metadata[entry.path]) };
  });
}

export async function getVaultInfo(ctx: VaultContext): Promise<VaultResult<VaultInfo>> {
  try {
    await mkdir(ctx.root, { recursive: true });
    const entries: VaultEntry[] = [];
    await walkEntries(ctx.root, '', 0, Number.MAX_SAFE_INTEGER, DEFAULT_ENTRY_CAP, entries);
    return {
      ok: true,
      value: {
        rootName: path.basename(path.resolve(ctx.root)),
        fileCount: entries.filter((entry) => entry.kind === 'file').length,
        folderCount: entries.filter((entry) => entry.kind === 'folder').length
      }
    };
  } catch (err) {
    if (err instanceof EntryCapExceededError) {
      return fail('entry_cap_exceeded', `vault exceeds ${DEFAULT_ENTRY_CAP} entries`);
    }
    /* v8 ignore next -- Defensive rethrow for unexpected vault-info walk failures outside the classified entry-cap path. */
    throw err;
  }
}

export async function listVaultTree(
  ctx: VaultContext,
  input: { under?: string; depth?: number; entryCap?: number } = {}
): Promise<VaultResult<{ entries: VaultEntry[] }>> {
  try {
    const under = validateOptionalVaultPath(input.under, 'folder') ?? '';
    const absUnder = under.length === 0 ? ctx.root : vaultPath(ctx.root, under);
    const underStat = await statOrNull(absUnder);
    if (!underStat || !underStat.isDirectory()) return fail('not_found', 'folder not found');

    const entries: VaultEntry[] = [];
    await walkEntries(ctx.root, under, 0, input.depth ?? DEFAULT_DEPTH, input.entryCap ?? DEFAULT_ENTRY_CAP, entries);
    const metadata = await readFolderMetadataMap(ctx.root);
    if (!metadata.ok) return metadata;
    return { ok: true, value: { entries: attachFolderMetadata(entries, metadata.value) } };
  } catch (err) {
    const pathResult = classifyPathError(err);
    /* v8 ignore next -- Defensive false branch rethrows unexpected read errors; invalid-path classification is covered. */
    if (pathResult) return pathResult;
    if (err instanceof EntryCapExceededError) {
      return fail('entry_cap_exceeded', `tree exceeds ${input.entryCap ?? DEFAULT_ENTRY_CAP} entries`);
    }
    /* v8 ignore next -- Defensive rethrow for unexpected tree failures outside classified path/cap errors. */
    throw err;
  }
}

export async function getFolderMetadata(ctx: VaultContext, folderPath: string): Promise<VaultResult<FolderMetadataValue>> {
  try {
    const rel = validateVaultPath(folderPath, 'folder');
    const abs = vaultPath(ctx.root, rel);
    const s = await statOrNull(abs);
    if (!s || !s.isDirectory()) return fail('not_found', 'folder not found');
    const metadata = await readFolderMetadataMap(ctx.root);
    if (!metadata.ok) return metadata;
    return { ok: true, value: { path: rel, metadata: cloneMetadata(metadata.value[rel] ?? {}) } };
  } catch (err) {
    const pathResult = classifyPathError(err);
    /* v8 ignore next -- Defensive false branch rethrows unexpected folder metadata read errors; invalid-path classification is covered. */
    if (pathResult) return pathResult;
    /* v8 ignore next -- Defensive rethrow for unexpected metadata read failures outside classified path/not-found/parse errors. */
    throw err;
  }
}

export async function setFolderMetadata(
  ctx: VaultContext,
  folderPath: string,
  input: FolderMetadataInput
): Promise<VaultResult<FolderMetadataValue>> {
  try {
    const rel = validateVaultPath(folderPath, 'folder');
    const normalizedInput = normalizeFolderMetadataInput(input);
    if (!normalizedInput.ok) return normalizedInput;

    const abs = vaultPath(ctx.root, rel);
    const s = await statOrNull(abs);
    if (!s || !s.isDirectory()) return fail('not_found', 'folder not found');

    return await withFolderMetadataMutation(ctx.root, async () => {
      const metadata = await readFolderMetadataMap(ctx.root);
      if (!metadata.ok) return metadata;

      const nextMetadata = applyFolderMetadataInput(metadata.value[rel] ?? {}, normalizedInput.value);
      const nextMap = { ...metadata.value };
      if (isEmptyMetadata(nextMetadata)) {
        delete nextMap[rel];
      } else {
        nextMap[rel] = nextMetadata;
      }
      await writeFolderMetadataMap(ctx.root, nextMap);

      const audit = await emitVaultAudit({
        root: ctx.root,
        actor: ctx.actor,
        operation: 'write',
        entityKind: 'folder',
        path: rel,
        summary: `Updated folder metadata for ${rel}`
      });
      return { ok: true, value: { path: rel, metadata: nextMetadata, audit } };
    });
  } catch (err) {
    const pathResult = classifyPathError(err);
    /* v8 ignore next -- Defensive false branch rethrows unexpected folder metadata write errors; invalid-path classification is covered. */
    if (pathResult) return pathResult;
    /* v8 ignore next -- Defensive rethrow for unexpected metadata write failures outside classified path/not-found/parse errors. */
    throw err;
  }
}

export async function listFolderMetadata(ctx: VaultContext): Promise<VaultResult<{ folders: FolderMetadataMap }>> {
  const metadata = await readFolderMetadataMap(ctx.root);
  if (!metadata.ok) return metadata;
  return { ok: true, value: { folders: metadata.value } };
}

export async function readVaultFile(ctx: VaultContext, filePath: string): Promise<VaultResult<ReadFileValue>> {
  try {
    const rel = validateVaultPath(filePath, 'file');
    const abs = vaultPath(ctx.root, rel);
    const s = await statOrNull(abs);
    if (!s || !s.isFile()) return fail('not_found', 'file not found');
    return {
      ok: true,
      value: {
        path: rel,
        content: await readFile(abs, 'utf8'),
        size: s.size,
        mtimeMs: s.mtimeMs
      }
    };
  } catch (err) {
    const pathResult = classifyPathError(err);
    /* v8 ignore next -- Defensive false branch rethrows unexpected read errors; invalid-path classification is covered. */
    if (pathResult) return pathResult;
    /* v8 ignore next -- Defensive rethrow for unexpected read failures outside classified path/not-found errors. */
    throw err;
  }
}

export async function writeVaultFile(
  ctx: VaultContext,
  input: { path: string; content: string; overwrite?: boolean }
): Promise<VaultResult<WriteFileValue>> {
  try {
    const rel = validateVaultPath(input.path, 'file');
    const abs = vaultPath(ctx.root, rel);
    const existsAlready = await exists(abs);
    if (existsAlready && input.overwrite !== true) {
      return fail('already_exists', 'file already exists');
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, input.content, 'utf8');
    const s = await stat(abs);
    const audit = await emitVaultAudit({
      root: ctx.root,
      actor: ctx.actor,
      operation: existsAlready ? 'write' : 'create',
      entityKind: 'file',
      path: rel,
      summary: existsAlready ? `Wrote ${rel}` : `Created ${rel}`
    });
    return { ok: true, value: { path: rel, size: s.size, mtimeMs: s.mtimeMs, audit } };
  } catch (err) {
    const pathResult = classifyPathError(err);
    /* v8 ignore next -- Defensive false branch rethrows unexpected mkdir errors; invalid-path classification is covered. */
    if (pathResult) return pathResult;
    const collisionResult = classifyFsCollision(err);
    if (collisionResult) return collisionResult;
    /* v8 ignore next -- Defensive rethrow for unexpected write failures outside classified path/collision errors. */
    throw err;
  }
}

export async function makeVaultFolder(ctx: VaultContext, folderPath: string): Promise<VaultResult<{ path: string; audit?: AuditEntry }>> {
  try {
    const rel = validateVaultPath(folderPath, 'folder');
    const abs = vaultPath(ctx.root, rel);
    const existed = await exists(abs);
    await mkdir(abs, { recursive: true });
    if (existed) return { ok: true, value: { path: rel } };
    const audit = await emitVaultAudit({
      root: ctx.root,
      actor: ctx.actor,
      operation: 'mkdir',
      entityKind: 'folder',
      path: rel,
      summary: `Created folder ${rel}`
    });
    return { ok: true, value: { path: rel, audit } };
  } catch (err) {
    const pathResult = classifyPathError(err);
    /* v8 ignore next -- Defensive false branch rethrows unexpected mkdir errors; invalid-path classification is covered. */
    if (pathResult) return pathResult;
    const collisionResult = classifyFsCollision(err);
    if (collisionResult) return collisionResult;
    /* v8 ignore next -- Defensive rethrow for unexpected mkdir failures outside classified path errors. */
    throw err;
  }
}

export async function deleteVaultFile(
  ctx: VaultContext,
  input: { path: string; permanent?: boolean }
): Promise<VaultResult<DeleteValue>> {
  try {
    const rel = validateVaultPath(input.path, 'file');
    const abs = vaultPath(ctx.root, rel);
    const s = await statOrNull(abs);
    if (!s || !s.isFile()) return fail('not_found', 'file not found');

    let trashPath: string | undefined;
    if (input.permanent === true) {
      await rm(abs);
    } else {
      trashPath = trashRelativePath(rel);
      const trashAbs = vaultPath(ctx.root, trashPath);
      await mkdir(path.dirname(trashAbs), { recursive: true });
      await rename(abs, trashAbs);
    }

    const audit = await emitVaultAudit({
      root: ctx.root,
      actor: ctx.actor,
      operation: 'delete',
      entityKind: 'file',
      path: rel,
      summary: input.permanent === true ? `Deleted ${rel} permanently` : `Moved ${rel} to trash`
    });
    return { ok: true, value: { path: rel, ...(trashPath !== undefined ? { trashPath } : {}), permanent: input.permanent === true, audit } };
  } catch (err) {
    const pathResult = classifyPathError(err);
    /* v8 ignore next -- Defensive false branch rethrows unexpected file-delete errors; invalid-path classification is covered. */
    if (pathResult) return pathResult;
    /* v8 ignore next -- Defensive rethrow for unexpected delete failures outside classified path/not-found errors. */
    throw err;
  }
}

export async function deleteVaultFolder(
  ctx: VaultContext,
  input: { path: string; recursive?: boolean; permanent?: boolean }
): Promise<VaultResult<DeleteValue>> {
  try {
    const rel = validateVaultPath(input.path, 'folder');
    const abs = vaultPath(ctx.root, rel);
    const s = await statOrNull(abs);
    if (!s || !s.isDirectory()) return fail('not_found', 'folder not found');

    const children = await readdir(abs);
    if (children.length > 0 && input.recursive !== true) {
      return fail('folder_not_empty', 'folder is not empty');
    }
    return await withFolderMetadataMutation(ctx.root, async () => {
      const metadata = await readFolderMetadataMap(ctx.root);
      if (!metadata.ok) return metadata;

      let trashPath: string | undefined;
      if (input.permanent === true) {
        await rm(abs, { recursive: true });
      } else {
        trashPath = trashRelativePath(rel);
        const trashAbs = vaultPath(ctx.root, trashPath);
        await mkdir(path.dirname(trashAbs), { recursive: true });
        await rename(abs, trashAbs);
      }
      await writeFolderMetadataMap(ctx.root, removeFolderMetadataSubtree(metadata.value, rel));

      const audit = await emitVaultAudit({
        root: ctx.root,
        actor: ctx.actor,
        operation: 'delete',
        entityKind: 'folder',
        path: rel,
        summary: input.permanent === true ? `Deleted folder ${rel} permanently` : `Moved folder ${rel} to trash`
      });
      return { ok: true, value: { path: rel, ...(trashPath !== undefined ? { trashPath } : {}), permanent: input.permanent === true, audit } };
    });
  } catch (err) {
    const pathResult = classifyPathError(err);
    /* v8 ignore next -- Defensive false branch rethrows unexpected folder-delete errors; invalid-path classification is covered. */
    if (pathResult) return pathResult;
    /* v8 ignore next -- Defensive rethrow for unexpected folder delete failures outside classified path/not-empty/not-found errors. */
    throw err;
  }
}

export async function moveVaultPath(
  ctx: VaultContext,
  input: { fromPath: string; toPath: string; kind: 'file' | 'folder'; overwrite?: boolean }
): Promise<VaultResult<MoveValue>> {
  try {
    const from = validateVaultPath(input.fromPath, input.kind);
    const to = validateVaultPath(input.toPath, input.kind);
    if (input.kind === 'folder' && relativeDescendantPath(from, to) !== null) {
      return fail('invalid_path', 'folder cannot be moved into itself');
    }
    const fromAbs = vaultPath(ctx.root, from);
    const toAbs = vaultPath(ctx.root, to);
    const s = await statOrNull(fromAbs);
    if (!s || (input.kind === 'file' ? !s.isFile() : !s.isDirectory())) {
      return fail('not_found', `${input.kind} not found`);
    }
    const movePath = async (metadata?: FolderMetadataMap): Promise<VaultResult<MoveValue>> => {
      if ((await exists(toAbs)) && input.overwrite !== true) {
        return fail('path_collision', 'target path already exists');
      }
      await mkdir(path.dirname(toAbs), { recursive: true });
      if (input.overwrite === true && (await exists(toAbs))) {
        await rm(toAbs, { recursive: true });
      }
      try {
        await rename(fromAbs, toAbs);
      } catch (err) {
        /* v8 ignore start -- Cross-device rename fallback cannot be triggered deterministically inside one temp filesystem. */
        if (err && typeof err === 'object' && 'code' in err && err.code === 'EXDEV') {
          if (input.kind === 'folder') {
            await cp(fromAbs, toAbs, { recursive: true });
          } else {
            await copyFile(fromAbs, toAbs);
          }
          await rm(fromAbs, { recursive: true });
        } else {
          throw err;
        }
        /* v8 ignore stop */
      }
      if (metadata !== undefined) {
        await writeFolderMetadataMap(ctx.root, moveFolderMetadataSubtree(metadata, from, to));
      }
      const audit = await emitVaultAudit({
        root: ctx.root,
        actor: ctx.actor,
        operation: 'move',
        entityKind: input.kind,
        path: to,
        fromPath: from,
        toPath: to,
        summary: `Moved ${from} to ${to}`
      });
      return { ok: true, value: { fromPath: from, toPath: to, kind: input.kind, audit } };
    };

    if (input.kind === 'folder') {
      return await withFolderMetadataMutation(ctx.root, async () => {
        const metadata = await readFolderMetadataMap(ctx.root);
        if (!metadata.ok) return metadata;
        return movePath(metadata.value);
      });
    }

    return await movePath();
  } catch (err) {
    const pathResult = classifyPathError(err);
    /* v8 ignore next -- Defensive false branch rethrows unexpected move errors; invalid-path classification is covered. */
    if (pathResult) return pathResult;
    const collisionResult = classifyFsCollision(err);
    if (collisionResult) return collisionResult;
    /* v8 ignore next -- Defensive rethrow for unexpected move failures outside classified path/not-found/collision errors. */
    throw err;
  }
}
