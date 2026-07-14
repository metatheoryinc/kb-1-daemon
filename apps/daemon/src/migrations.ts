import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir
} from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

interface DirectoryMigrationInput {
  source: string;
  target: string;
  sourceIdentityScope?: MigrationSourceIdentityScope;
  validateExistingTarget?: (source: string, target: string) => Promise<void>;
}

interface DirectoryMigrationResult {
  migrated: boolean;
}

export const MIGRATION_COMPLETION_FILENAME = '.kb1-migration-complete-v1.json';
export const MIGRATION_STAGING_DIRECTORY_PREFIX = '.kb1-migration-staging-';
export const MIGRATION_LOCK_PREFIX = '.kb1-migration-lock-';
const MIGRATION_STAGING_MANIFEST_FILENAME = '.kb1-migration-stage-v1.json';
const MIGRATION_COMPLETION_TEMP_PREFIX = `${MIGRATION_COMPLETION_FILENAME}.tmp-`;
const MIGRATION_COPY_TEMP_PREFIX = '.kb1-migration-copy-';
const MIGRATION_MOVE_MANIFEST_PREFIX = `${MIGRATION_COPY_TEMP_PREFIX}moves-`;
const MAX_WINDOWS_MOVE_OPERATIONS = 1_000_000;
const MAX_WINDOWS_MOVE_LINE_BYTES = 65_536;
const MAX_COMPLETION_MARKER_BYTES = 16_384;
const UUID_SUFFIX_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const execFileAsync = promisify(execFile);

interface MigrationCompletionMarker {
  schemaVersion: 1;
  sourceName: string;
  targetName: string;
  verification: 'sha256-tree';
  pathPairFingerprint: string;
  sourceVaultId: string | null;
  migrationSourceDigest: string;
}

interface WindowsMoveOperation {
  source: string;
  target: string;
  replaceExisting?: boolean;
}

export interface MigrationLockHandle {
  path: string;
  release: () => Promise<void>;
}

export type MigrationSourceIdentityScope = 'none' | 'metadata-directory' | 'vault-root';

export function isReservedMigrationControlName(name: string): boolean {
  const canonical = canonicalFilesystemSegment(name);
  return canonical === canonicalFilesystemSegment(MIGRATION_COMPLETION_FILENAME)
    || canonical.startsWith(MIGRATION_COMPLETION_TEMP_PREFIX)
    || canonical.startsWith(MIGRATION_COPY_TEMP_PREFIX)
    || canonical.startsWith(MIGRATION_STAGING_DIRECTORY_PREFIX)
    || canonical.startsWith(MIGRATION_LOCK_PREFIX);
}

export function copyModeWithoutSpecialBits(sourceMode: number): number {
  return sourceMode & 0o777;
}

export async function migrateDirectoryCopyVerifyPreserve(
  input: DirectoryMigrationInput
): Promise<DirectoryMigrationResult> {
  const {
    source,
    target,
    sourceIdentityScope = 'none',
    validateExistingTarget
  } = input;
  const initialSourceInfo = await lstatIfExists(source);
  if (!initialSourceInfo) {
    return { migrated: false };
  }
  if (!initialSourceInfo.isDirectory()) {
    throw new Error(
      `Migration verification failed: legacy source ${source} has an unsupported filesystem type; source preserved.`
    );
  }

  const migrationLock = await acquireMigrationLock(source, target);
  try {
    const sourceInfo = await lstatIfExists(source);
    if (!sourceInfo?.isDirectory()) {
      throw new Error(
        `Migration verification failed: legacy source ${source} disappeared or changed filesystem type while acquiring its exclusive lock; recover manually.`
      );
    }
    return await migrateDirectoryCopyVerifyPreserveLocked(
      source,
      target,
      sourceInfo,
      sourceIdentityScope,
      validateExistingTarget
    );
  } finally {
    await migrationLock.release();
  }
}

async function migrateDirectoryCopyVerifyPreserveLocked(
  source: string,
  target: string,
  sourceInfo: import('node:fs').Stats,
  sourceIdentityScope: MigrationSourceIdentityScope,
  validateExistingTarget?: (source: string, target: string) => Promise<void>
): Promise<DirectoryMigrationResult> {
  await cleanupMigrationStagingDirectories(source, target);

  if (await isMigrationCompletionRecorded(source, target, sourceIdentityScope)) {
    return { migrated: false };
  }

  const targetInfo = await lstatIfExists(target);
  if (targetInfo) {
    if (!targetInfo.isDirectory()) {
      throw new Error(
        `Migration verification failed: target ${target} has an unsupported filesystem type; source preserved.`
      );
    }

    await validateExistingTarget?.(source, target);

    // Docker volume mounts materialize the target as an empty directory, while
    // a prior interrupted run may leave a verified subset. Reconciliation only
    // fills missing entries, never overwrites existing data, and rejects any
    // mismatch before recording completion.
    await reconcileDirectoryCopy(source, target);
    await recordMigrationCompletion(source, target, target, sourceIdentityScope);
    return { migrated: false };
  }

  // Reserve the complete control namespace and reject unsupported source
  // entries before any target path is made visible.
  await validateMigrationSourceTree(source);

  const publicationStagingRoot = process.platform === 'win32'
    ? await createMigrationStagingDirectory(source, target)
    : undefined;
  try {
    // mkdir/MoveFileExW reserve the destination without replacing a raced path.
    // Reconciliation then publishes only missing entries with no-clobber
    // primitives, leaving any interrupted partial target safe to verify/retry.
    await createPublishedDirectory(target, publicationStagingRoot, sourceInfo.mode);
    await reconcileValidatedDirectoryCopy(source, target);
    await recordMigrationCompletion(source, target, target, sourceIdentityScope);
    return { migrated: true };
  } finally {
    if (publicationStagingRoot) {
      await rm(publicationStagingRoot, { recursive: true, force: true });
    }
  }
}

export async function acquireMigrationLock(
  source: string,
  target: string
): Promise<MigrationLockHandle> {
  const [resolvedSource, resolvedTargetParent] = await Promise.all([
    realpath(source),
    realpath(dirname(target))
  ]);
  const canonicalSource = process.platform === 'win32'
    ? resolvedSource.toLowerCase()
    : resolvedSource;
  const resolvedTarget = join(resolvedTargetParent, basename(target));
  const canonicalTarget = process.platform === 'win32'
    ? resolvedTarget.toLowerCase()
    : resolvedTarget;
  const pairDigest = createHash('sha256')
    .update(JSON.stringify([canonicalSource, canonicalTarget]))
    .digest('hex')
    .slice(0, 32);
  const lockPath = join(dirname(target), `${MIGRATION_LOCK_PREFIX}${pairDigest}.json`);
  const token = randomBytes(32).toString('hex');
  const payload = `${JSON.stringify({
    schemaVersion: 1,
    source: canonicalSource,
    target: canonicalTarget,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token
  }, null, 2)}\n`;

  let lockHandle: Awaited<ReturnType<typeof open>>;
  try {
    lockHandle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (isNodeErrorCode(error, 'EEXIST')) {
      throw new Error(
        `Migration verification failed: exclusive migration lock ${lockPath} already exists. `
          + 'Another migration may be running, or an interrupted migration may have left state behind. '
          + 'Confirm no migration is running, inspect the retained source and any staging directory, then remove the lock manually before retrying.'
      );
    }
    throw error;
  }

  let originalStats: import('node:fs').BigIntStats;
  try {
    await lockHandle.writeFile(payload, 'utf8');
    await lockHandle.sync();
    originalStats = await lockHandle.stat({ bigint: true });
  } finally {
    await lockHandle.close();
  }
  if (process.platform !== 'win32') {
    await syncDirectory(dirname(lockPath));
  }

  let released = false;
  return {
    path: lockPath,
    release: async () => {
      if (released) {
        return;
      }

      let currentHandle: Awaited<ReturnType<typeof open>>;
      try {
        currentHandle = await open(lockPath, 'r');
      } catch (error) {
        throw new Error(
          `Migration verification failed: exclusive migration lock ${lockPath} disappeared before its owner could release it; recover manually.`,
          { cause: error }
        );
      }

      let currentPayload: string;
      let currentStats: import('node:fs').BigIntStats;
      try {
        [currentPayload, currentStats] = await Promise.all([
          currentHandle.readFile('utf8'),
          currentHandle.stat({ bigint: true })
        ]);
      } finally {
        await currentHandle.close();
      }
      const pathStats = await lstat(lockPath, { bigint: true });
      if (
        !currentStats.isFile()
        || !pathStats.isFile()
        || currentStats.dev !== originalStats.dev
        || currentStats.ino !== originalStats.ino
        || pathStats.dev !== originalStats.dev
        || pathStats.ino !== originalStats.ino
        || currentPayload !== payload
      ) {
        throw new Error(
          `Migration verification failed: exclusive migration lock ${lockPath} no longer matches its owner token and inode; it was preserved for manual recovery.`
        );
      }

      await rm(lockPath);
      if (process.platform !== 'win32') {
        await syncDirectory(dirname(lockPath));
      }
      released = true;
    }
  };
}

export async function isMigrationCompletionRecorded(
  source: string,
  target: string,
  sourceIdentityScope: MigrationSourceIdentityScope = 'none'
): Promise<boolean> {
  const targetInfo = await lstatIfExists(target);
  if (!targetInfo) {
    return false;
  }
  if (!targetInfo.isDirectory()) {
    throw new Error(
      `Migration verification failed: target ${target} has an unsupported filesystem type; source preserved.`
    );
  }

  await cleanupTemporaryCompletionMarkers(target);
  await cleanupTemporaryMoveManifests(target);

  const markerPath = join(target, MIGRATION_COMPLETION_FILENAME);
  const markerInfo = await lstatIfExists(markerPath);
  if (!markerInfo) {
    return false;
  }
  if (!markerInfo.isFile()) {
    throw new Error(
      `Migration verification failed: completion marker ${markerPath} is not a regular file; source preserved.`
    );
  }
  assertTrustedCompletionMarker(markerPath, markerInfo);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    throw new Error(
      `Migration verification failed: completion marker ${markerPath} is invalid; source preserved.`
    );
  }

  if (!isMigrationCompletionMarkerForPaths(parsed, source, target)) {
    throw new Error(
      `Migration verification failed: completion marker ${markerPath} is invalid; source preserved.`
    );
  }
  const currentBinding = await captureMigrationBinding(source, target, sourceIdentityScope);
  if (parsed.sourceVaultId !== currentBinding.sourceVaultId) {
    throw new Error(
      `Migration verification failed: completion marker ${markerPath} does not match the stable vault identity; source preserved. Restore the matching retained source or recover manually.`
    );
  }
  if (parsed.pathPairFingerprint !== currentBinding.pathPairFingerprint) {
    const stableSourceBefore = await captureSourceTreeManifest(source);
    const currentSourceDigest = await capturePortableSourceTreeDigest(source);
    const stableSourceAfter = await captureSourceTreeManifest(source);
    if (stableSourceBefore !== stableSourceAfter) {
      throw new Error(
        `Migration verification failed: relocated retained source changed during marker rebind; source preserved. Stop its writer and retry.`
      );
    }
    if (parsed.migrationSourceDigest !== currentSourceDigest) {
      throw new Error(
        `Migration verification failed: relocated completion marker ${markerPath} cannot be safely rebound because the retained source does not match its migration-time digest; source preserved. Restore the matching source or recover manually.`
      );
    }
    const rebound: MigrationCompletionMarker = {
      ...parsed,
      sourceName: basename(source),
      targetName: basename(target),
      pathPairFingerprint: currentBinding.pathPairFingerprint
    };
    await replaceMigrationCompletionMarker(target, rebound);
  }

  return true;
}

export async function recordMigrationCompletion(
  source: string,
  target: string,
  copiedTarget = target,
  sourceIdentityScope: MigrationSourceIdentityScope = 'none'
): Promise<void> {
  const targetInfo = await lstatIfExists(target);
  if (!targetInfo?.isDirectory()) {
    throw new Error(
      `Migration verification failed: target ${target} is not a regular directory; source preserved.`
    );
  }

  await cleanupTemporaryCompletionMarkers(target);
  await cleanupTemporaryMoveManifests(target);

  const markerPath = join(target, MIGRATION_COMPLETION_FILENAME);
  const markerInfo = await lstatIfExists(markerPath);
  if (markerInfo) {
    if (await isMigrationCompletionRecorded(source, target, sourceIdentityScope)) {
      return;
    }
  }

  const temporaryMarkerPath = `${markerPath}.tmp-${randomUUID()}`;
  let temporaryMarkerOwnership: import('node:fs').BigIntStats | undefined;
  let publishedMarkerOwnership: import('node:fs').BigIntStats | undefined;
  try {
    // Flush the verified tree before the completion marker. Node exposes the
    // standard fsync barrier on Darwin, not F_FULLFSYNC; the retained legacy
    // source remains the recovery authority for sudden-power-loss edge cases.
    const sourceManifestBefore = await captureSourceTreeManifest(source);
    const migrationSourceDigest = await capturePortableSourceTreeDigest(source);
    const payload = `${JSON.stringify(
      await migrationCompletionMarker(source, target, migrationSourceDigest, sourceIdentityScope),
      null,
      2
    )}\n`;
    await syncDirectoryTree(copiedTarget);
    if (process.platform !== 'win32') {
      for (const directory of new Set([dirname(copiedTarget), dirname(target)])) {
        await syncDirectory(directory);
      }
    }
    const targetManifestBefore = await captureTargetTreeManifest(copiedTarget);
    await verifyCopy(source, copiedTarget);
    const [sourceManifestAfter, targetManifestAfter] = await Promise.all([
      captureSourceTreeManifest(source),
      captureTargetTreeManifest(copiedTarget)
    ]);
    if (sourceManifestBefore !== sourceManifestAfter) {
      throw new Error(
        'Migration verification failed: legacy source changed during final verification; source preserved.'
      );
    }
    if (targetManifestBefore !== targetManifestAfter) {
      throw new Error(
        'Migration verification failed: target changed during final verification; source preserved.'
      );
    }

    const restoreTargetMode = await temporarilyGrantOwnerWrite(target, targetInfo.mode);
    try {
      const markerHandle = await open(temporaryMarkerPath, process.platform === 'win32' ? 'wx+' : 'wx');
      try {
        temporaryMarkerOwnership = await markerHandle.stat({ bigint: true });
        if (process.platform !== 'win32') {
          await markerHandle.chmod(0o600);
        }
        await markerHandle.writeFile(payload, 'utf8');
        await markerHandle.sync();
      } finally {
        await markerHandle.close();
      }
      publishedMarkerOwnership = await publishMigrationPath(
        temporaryMarkerPath,
        markerPath,
        false,
        (ownership) => {
          // Publication can commit before a post-publication identity check
          // fails. Capture the target inode at that commit point so the catch
          // path can authenticate rollback even when the publisher rejects.
          publishedMarkerOwnership = ownership;
        }
      );
    } finally {
      await restoreTargetMode();
    }
    if (process.platform !== 'win32') {
      await syncDirectory(target);
    }
    const [sourceManifestFinal, targetManifestFinal] = await Promise.all([
      captureSourceTreeManifest(source),
      captureTargetTreeManifest(copiedTarget)
    ]);
    if (sourceManifestBefore !== sourceManifestFinal) {
      throw new Error(
        'Migration verification failed: legacy source changed while completion was published; source preserved.'
      );
    }
    if (targetManifestBefore !== targetManifestFinal) {
      throw new Error(
        'Migration verification failed: target changed while completion was published; source preserved.'
      );
    }
  } catch (error) {
    if (publishedMarkerOwnership) {
      const currentTargetInfo = await lstat(target);
      const restoreTargetMode = await temporarilyGrantOwnerWrite(target, currentTargetInfo.mode);
      try {
        await removeOwnedRegularFileIfPresent(
          markerPath,
          publishedMarkerOwnership,
          'published completion marker'
        );
      } finally {
        await restoreTargetMode();
      }
      if (process.platform !== 'win32') {
        await syncDirectory(target);
      }
    }
    throw error;
  } finally {
    if (temporaryMarkerOwnership) {
      await removeOwnedRegularFileIfPresent(
        temporaryMarkerPath,
        temporaryMarkerOwnership,
        'temporary completion marker'
      );
    }
    await cleanupTemporaryCompletionMarkers(target);
    await cleanupTemporaryMoveManifests(target);
  }
}

async function replaceMigrationCompletionMarker(
  target: string,
  marker: MigrationCompletionMarker
): Promise<void> {
  const targetInfo = await lstat(target);
  if (!targetInfo.isDirectory()) {
    throw new Error(
      `Migration verification failed: target ${target} is not a regular directory; source preserved.`
    );
  }
  const markerPath = join(target, MIGRATION_COMPLETION_FILENAME);
  const temporaryMarkerPath = `${markerPath}.tmp-${randomUUID()}`;
  const payload = `${JSON.stringify(marker, null, 2)}\n`;
  const restoreTargetMode = await temporarilyGrantOwnerWrite(target, targetInfo.mode);
  let temporaryMarkerOwnership: import('node:fs').BigIntStats | undefined;
  try {
    const markerHandle = await open(temporaryMarkerPath, process.platform === 'win32' ? 'wx+' : 'wx');
    try {
      temporaryMarkerOwnership = await markerHandle.stat({ bigint: true });
      if (process.platform !== 'win32') {
        await markerHandle.chmod(0o600);
      }
      await markerHandle.writeFile(payload, 'utf8');
      await markerHandle.sync();
    } finally {
      await markerHandle.close();
    }
    // Once replacement commits, it is the only completion proof. Retain that
    // fully authenticated marker even if a subsequent parent identity check or
    // directory fsync rejects this boot; deleting it would also erase the old
    // marker and make an independently evolved target look unmigrated.
    await publishMigrationPath(temporaryMarkerPath, markerPath, true);
    if (process.platform !== 'win32') {
      await syncDirectory(target);
    }
  } finally {
    if (temporaryMarkerOwnership) {
      await removeOwnedRegularFileIfPresent(
        temporaryMarkerPath,
        temporaryMarkerOwnership,
        'temporary completion marker'
      );
    }
    await restoreTargetMode();
  }
}

async function cleanupTemporaryCompletionMarkers(target: string): Promise<void> {
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (!isTemporaryCompletionMarkerLookalikeName(entry.name)) {
      continue;
    }
    const path = join(target, entry.name);
    const info = await lstat(path);
    const filesystemType = info.isFile()
      ? 'regular file'
      : info.isSymbolicLink()
        ? 'symbolic link'
        : 'unsupported filesystem entry';
    throw new Error(
      `Migration verification failed: unverified temporary completion marker ${path} is a ${filesystemType}; `
        + 'it was preserved because filename shape alone does not prove ownership. '
        + 'Confirm no migration is running, inspect the retained source and target, then remove it manually before retrying.'
    );
  }
}

function isTemporaryCompletionMarkerLookalikeName(name: string): boolean {
  const canonical = canonicalFilesystemSegment(name);
  if (!canonical.startsWith(MIGRATION_COMPLETION_TEMP_PREFIX)) {
    return false;
  }
  return UUID_SUFFIX_PATTERN.test(canonical.slice(MIGRATION_COMPLETION_TEMP_PREFIX.length));
}

export async function cleanupMigrationStagingDirectories(source: string, target: string): Promise<void> {
  await cleanupOwnedStagingDirectories(dirname(target), source, target);
}

async function cleanupTemporaryMoveManifests(directory: string): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!isTemporaryMoveManifestLookalikeName(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    const info = await lstat(path);
    const filesystemType = info.isFile()
      ? 'regular file'
      : info.isSymbolicLink()
        ? 'symbolic link'
        : 'unsupported filesystem entry';
    throw new Error(
      `Migration verification failed: unverified Windows move manifest ${path} is a ${filesystemType}; `
        + 'it was preserved because filename shape alone does not prove ownership. '
        + 'Confirm no migration is running, inspect the retained source and target, then remove it manually before retrying.'
    );
  }
}

function isTemporaryMoveManifestLookalikeName(name: string): boolean {
  const canonical = canonicalFilesystemSegment(name);
  if (!canonical.startsWith(MIGRATION_MOVE_MANIFEST_PREFIX) || !canonical.endsWith('.ndjson')) {
    return false;
  }
  const uuid = canonical.slice(MIGRATION_MOVE_MANIFEST_PREFIX.length, -'.ndjson'.length);
  return UUID_SUFFIX_PATTERN.test(uuid);
}

async function cleanupOwnedStagingDirectories(
  parent: string,
  source: string,
  target: string
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!isOwnedStagingDirectoryName(entry.name, source, target)) {
      continue;
    }

    const stagingPath = join(parent, entry.name);
    const stagingInfo = await lstat(stagingPath);
    if (!stagingInfo.isDirectory()) {
      throw new Error(
        `Migration verification failed: reserved staging path ${stagingPath} is not a regular directory; it was preserved for manual recovery.`
      );
    }
    const stagingEntries = await readdir(stagingPath);
    if (stagingEntries.length !== 0) {
      throw new Error(
        `Migration verification failed: interrupted staging directory ${stagingPath} is non-empty and cannot be proven safe to delete; inspect and remove it manually before retrying.`
      );
    }

    // The exclusive pair lock prevents a cooperating migration from filling
    // this directory between the empty check and rmdir. rmdir itself fails if
    // any entry appears, so cleanup never recursively erases abandoned data.
    await rmdir(stagingPath);
  }
}

function migrationStagingOwnershipPrefix(source: string, target: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(migrationStagingManifest(source, target)))
    .digest('hex')
    .slice(0, 32);
  return `${MIGRATION_STAGING_DIRECTORY_PREFIX}${digest}-`;
}

function isOwnedStagingDirectoryName(name: string, source: string, target: string): boolean {
  const canonical = canonicalFilesystemSegment(name);
  const ownershipPrefix = migrationStagingOwnershipPrefix(source, target);
  if (!canonical.startsWith(ownershipPrefix)) {
    return false;
  }
  return UUID_SUFFIX_PATTERN.test(canonical.slice(ownershipPrefix.length));
}

export async function createMigrationStagingDirectory(source: string, target: string): Promise<string> {
  return createOwnedStagingDirectory(dirname(target), source, target);
}

async function createOwnedStagingDirectory(
  parent: string,
  source: string,
  target: string
): Promise<string> {
  const stagingPath = join(
    parent,
    `${migrationStagingOwnershipPrefix(source, target)}${randomUUID()}`
  );
  await mkdir(stagingPath, { mode: 0o700 });
  try {
    const payload = `${JSON.stringify(migrationStagingManifest(source, target), null, 2)}\n`;
    const manifestHandle = await open(join(stagingPath, MIGRATION_STAGING_MANIFEST_FILENAME), 'wx');
    try {
      await manifestHandle.writeFile(payload, 'utf8');
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    if (process.platform !== 'win32') {
      await syncDirectory(stagingPath);
      await syncDirectory(dirname(stagingPath));
    }
    return stagingPath;
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

export async function reconcileDirectoryCopy(source: string, target: string): Promise<void> {
  await validateMigrationSourceTree(source);
  await reconcileValidatedDirectoryCopy(source, target);
}

async function reconcileValidatedDirectoryCopy(source: string, target: string): Promise<void> {
  const [sourceInfo, targetInfo] = await Promise.all([
    lstatIfExists(source),
    lstatIfExists(target)
  ]);
  if (!sourceInfo?.isDirectory()) {
    throw new Error(
      `Migration verification failed: legacy source ${source} is not a regular directory; source preserved.`
    );
  }
  if (!targetInfo?.isDirectory()) {
    throw new Error(
      `Migration verification failed: target ${target} is not a regular directory; source preserved.`
    );
  }

  const originalTargetMode = targetInfo.mode & 0o7777;
  assertTargetPermissionsNoBroader(sourceInfo.mode, originalTargetMode, '.', 'directory');
  const restoreTargetMode = await temporarilyGrantOwnerWrite(target, originalTargetMode);
  try {
    await cleanupOwnedStagingDirectories(target, source, target);
    // Reject target symlinks, hard links, and portable-name aliases before
    // filling any missing source entries into an existing directory.
    await assertRegularDirectoryTree(target, target);
    await validateCrossTreePortableAliases(source, target, source);
    const stagingPath = await createOwnedStagingDirectory(target, source, target);
    try {
      if (process.platform === 'win32') {
        await reconcileWindowsDirectoryCopy(source, target, stagingPath);
      } else {
        await reconcileDirectory(source, target, source, stagingPath, originalTargetMode);
      }
    } finally {
      await rm(stagingPath, { recursive: true, force: true });
    }
  } finally {
    await restoreTargetMode();
  }
  await verifyCopy(source, target);
}

/**
 * Validate the entire source namespace before migration publishes any target
 * entry. The later hash verification remains authoritative for file contents;
 * this pass prevents a reserved name discovered late in traversal from leaving
 * an earlier partial copy behind.
 */
export async function validateMigrationSourceTree(source: string): Promise<void> {
  const sourceInfo = await lstatIfExists(source);
  if (!sourceInfo?.isDirectory()) {
    throw new Error(
      `Migration verification failed: legacy source ${source} is not a regular directory; source preserved.`
    );
  }
  await validateMigrationSourceDirectory(source, source);
}

async function reconcileWindowsDirectoryCopy(
  source: string,
  target: string,
  stagingPath: string
): Promise<void> {
  const directoryMoves: WindowsMoveOperation[] = [];
  const fileMoves: WindowsMoveOperation[] = [];
  await planWindowsDirectoryReconciliation(
    source,
    target,
    source,
    stagingPath,
    true,
    directoryMoves,
    fileMoves
  );
  await publishWindowsMoveBatch([...directoryMoves, ...fileMoves], stagingPath);
}

async function planWindowsDirectoryReconciliation(
  source: string,
  target: string,
  sourceRoot: string,
  stagingPath: string,
  targetDirectoryExists: boolean,
  directoryMoves: WindowsMoveOperation[],
  fileMoves: WindowsMoveOperation[]
): Promise<void> {
  const relDirectory = relative(sourceRoot, source) || '.';
  const sourceInfo = await lstatIfExists(source);
  if (!sourceInfo?.isDirectory()) {
    throw new Error(
      `Migration verification failed: ${relDirectory} is not a regular source directory; source preserved.`
    );
  }
  if (targetDirectoryExists) {
    const targetInfo = await lstatIfExists(target);
    if (!targetInfo?.isDirectory()) {
      throw new Error(
        `Migration verification failed: ${relDirectory} is not a directory in the copy; source preserved.`
      );
    }
  }

  const entries = await readdir(source, { withFileTypes: true });
  assertNoPortableNameCollisions(entries, relDirectory, 'source');
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const relPath = relative(sourceRoot, sourcePath);
    if (isReservedMigrationControlName(entry.name)) {
      throw new Error(
        `Migration verification failed: ${relPath} is reserved for migration control state; source preserved.`
      );
    }

    const existingTarget = targetDirectoryExists ? await lstatIfExists(targetPath) : undefined;
    if (entry.isDirectory()) {
      if (existingTarget && !existingTarget.isDirectory()) {
        throw new Error(
          `Migration verification failed: ${relPath} is not a directory in the copy; source preserved.`
        );
      }
      if (!existingTarget) {
        const sourceDirectoryInfo = await lstat(sourcePath);
        if (!sourceDirectoryInfo.isDirectory()) {
          throw new Error(
            `Migration verification failed: ${relPath} is not a regular source directory; source preserved.`
          );
        }
        const temporaryDirectory = join(stagingPath, `${MIGRATION_COPY_TEMP_PREFIX}${randomUUID()}`);
        await mkdir(temporaryDirectory);
        await chmod(temporaryDirectory, copyModeWithoutSpecialBits(sourceDirectoryInfo.mode));
        directoryMoves.push({ source: temporaryDirectory, target: targetPath });
      }
      await planWindowsDirectoryReconciliation(
        sourcePath,
        targetPath,
        sourceRoot,
        stagingPath,
        existingTarget?.isDirectory() ?? false,
        directoryMoves,
        fileMoves
      );
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Migration verification failed: ${relPath} has an unsupported filesystem type; source preserved.`
      );
    }

    if (existingTarget) {
      if (!existingTarget.isFile()) {
        throw new Error(
          `Migration verification failed: ${relPath} is not a regular file in the copy; source preserved.`
        );
      }
      await verifyFileContents(sourcePath, targetPath, relPath);
      continue;
    }

    const temporaryFile = join(stagingPath, `${MIGRATION_COPY_TEMP_PREFIX}${randomUUID()}`);
    await copyFile(sourcePath, temporaryFile, constants.COPYFILE_EXCL);
    await verifyFileContents(sourcePath, temporaryFile, relPath);
    await syncRegularFile(temporaryFile);
    fileMoves.push({ source: temporaryFile, target: targetPath });
  }
}

async function validateMigrationSourceDirectory(root: string, current: string): Promise<void> {
  const relDirectory = relative(root, current) || '.';
  const currentInfo = await lstat(current);
  if (!currentInfo.isDirectory()) {
    throw new Error(
      `Migration verification failed: ${relDirectory} is not a regular source directory; source preserved.`
    );
  }

  const entries = await readdir(current, { withFileTypes: true });
  assertNoPortableNameCollisions(entries, relDirectory, 'source');
  for (const entry of entries) {
    const path = join(current, entry.name);
    const relPath = relative(root, path);
    if (isReservedMigrationControlName(entry.name)) {
      throw new Error(
        `Migration verification failed: ${relPath} is reserved for migration control state; source preserved.`
      );
    }

    const info = await lstat(path);
    if (info.isDirectory()) {
      await validateMigrationSourceDirectory(root, path);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(
        `Migration verification failed: ${relPath} has an unsupported filesystem type; source preserved.`
      );
    }
    if (info.nlink !== 1) {
      throw new Error(
        `Migration verification failed: ${relPath} is a hard-linked source file; source preserved.`
      );
    }
  }
}

async function validateCrossTreePortableAliases(
  source: string,
  target: string,
  sourceRoot: string
): Promise<void> {
  const relDirectory = relative(sourceRoot, source) || '.';
  const [sourceEntries, targetEntries] = await Promise.all([
    readdir(source, { withFileTypes: true }),
    readdir(target, { withFileTypes: true })
  ]);
  assertNoPortableNameCollisions(sourceEntries, relDirectory, 'source');
  assertNoPortableNameCollisions(targetEntries, relDirectory, 'copy');

  const targetNames = new Map(
    targetEntries.map((entry) => [canonicalFilesystemSegment(entry.name), entry.name])
  );
  for (const sourceEntry of sourceEntries) {
    const targetName = targetNames.get(canonicalFilesystemSegment(sourceEntry.name));
    if (targetName !== undefined && targetName !== sourceEntry.name) {
      throw new Error(
        `Migration verification failed: ${relDirectory} contains cross-tree portable-name alias `
          + `"${sourceEntry.name}" / "${targetName}"; source preserved.`
      );
    }

    if (!sourceEntry.isDirectory() || targetName === undefined) {
      continue;
    }
    const targetInfo = await lstat(join(target, targetName));
    if (targetInfo.isDirectory()) {
      await validateCrossTreePortableAliases(
        join(source, sourceEntry.name),
        join(target, targetName),
        sourceRoot
      );
    }
  }
}

async function reconcileDirectory(
  source: string,
  target: string,
  sourceRoot: string,
  stagingPath: string,
  targetModeOverride?: number
): Promise<void> {
  const relDirectory = relative(sourceRoot, source) || '.';
  const [sourceInfo, targetInfo] = await Promise.all([
    lstatIfExists(source),
    lstatIfExists(target)
  ]);
  if (!sourceInfo?.isDirectory() || !targetInfo?.isDirectory()) {
    throw new Error(
      `Migration verification failed: ${relDirectory} is not a regular directory in the source and copy; source preserved.`
    );
  }
  assertTargetPermissionsNoBroader(
    sourceInfo.mode,
    targetModeOverride ?? targetInfo.mode,
    relDirectory,
    'directory'
  );

  const originalTargetMode = targetInfo.mode & 0o7777;
  const workingTargetMode = originalTargetMode | 0o200;
  const restoreTargetMode = process.platform !== 'win32' && workingTargetMode !== originalTargetMode;
  if (restoreTargetMode) {
    // The source can legitimately be read-only (for example 0500). Add only
    // owner access while populating the copy, then restore the exact target
    // mode even when a later child fails verification.
    await chmod(target, workingTargetMode);
  }
  try {
    const entries = await readdir(source, { withFileTypes: true });
    assertNoPortableNameCollisions(entries, relDirectory, 'source');
    for (const entry of entries) {
      const sourcePath = join(source, entry.name);
      const targetPath = join(target, entry.name);
      const relPath = relative(sourceRoot, sourcePath);
      if (isReservedMigrationControlName(entry.name)) {
        throw new Error(
          `Migration verification failed: ${relPath} is reserved for migration control state; source preserved.`
        );
      }

      const existingTarget = await lstatIfExists(targetPath);
      if (entry.isDirectory()) {
        if (!existingTarget) {
          const sourceDirectoryInfo = await lstat(sourcePath);
          if (!sourceDirectoryInfo.isDirectory()) {
            throw new Error(
              `Migration verification failed: ${relPath} is not a regular source directory; source preserved.`
            );
          }
          await createPublishedDirectory(targetPath, stagingPath, sourceDirectoryInfo.mode);
        } else if (!existingTarget.isDirectory()) {
          throw new Error(
            `Migration verification failed: ${relPath} is not a directory in the copy; source preserved.`
          );
        }
        await reconcileDirectory(sourcePath, targetPath, sourceRoot, stagingPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `Migration verification failed: ${relPath} has an unsupported filesystem type; source preserved.`
        );
      }

      if (!existingTarget) {
        await copyMissingFile(sourcePath, targetPath, relPath, stagingPath);
      } else if (!existingTarget.isFile()) {
        throw new Error(
          `Migration verification failed: ${relPath} is not a regular file in the copy; source preserved.`
        );
      }
      await verifyFileContents(sourcePath, targetPath, relPath);
    }
  } finally {
    if (restoreTargetMode) {
      await chmod(target, originalTargetMode);
    }
  }
}

async function copyMissingFile(
  source: string,
  target: string,
  relativePath: string,
  stagingPath: string
): Promise<void> {
  const temporaryPath = join(stagingPath, `${MIGRATION_COPY_TEMP_PREFIX}${randomUUID()}`);
  let temporaryOwnership: import('node:fs').BigIntStats | undefined;
  try {
    await copyFile(source, temporaryPath, constants.COPYFILE_EXCL);
    temporaryOwnership = await lstat(temporaryPath, { bigint: true });
    if (process.platform !== 'win32') {
      const sourceInfo = await lstat(source);
      await chmod(temporaryPath, copyModeWithoutSpecialBits(sourceInfo.mode));
    }
    await verifyFileContents(source, temporaryPath, relativePath);
    await syncRegularFile(temporaryPath);
    await publishMigrationPath(temporaryPath, target);
    if (process.platform !== 'win32') {
      await syncDirectory(dirname(target));
    }
  } finally {
    if (temporaryOwnership) {
      await removeOwnedRegularFileIfPresent(
        temporaryPath,
        temporaryOwnership,
        'temporary copy'
      );
    }
  }
}

export async function createPublishedDirectory(
  target: string,
  stagingRoot?: string,
  sourceMode?: number
): Promise<void> {
  if (process.platform !== 'win32') {
    const parent = dirname(target);
    const parentIdentity = await captureDirectoryIdentity(parent);
    await mkdir(
      target,
      sourceMode === undefined ? undefined : { mode: copyModeWithoutSpecialBits(sourceMode) }
    );
    if (sourceMode !== undefined) {
      await chmod(target, copyModeWithoutSpecialBits(sourceMode));
    }
    await assertDirectoryIdentityUnchanged(parent, parentIdentity);
    return;
  }

  const temporaryDirectory = stagingRoot
    ? join(stagingRoot, `${MIGRATION_COPY_TEMP_PREFIX}${randomUUID()}`)
    : undefined;
  if (!temporaryDirectory) {
    throw new Error(
      `Migration verification failed: Windows directory publication for ${target} requires pair-owned staging; source preserved.`
    );
  }
  await mkdir(temporaryDirectory);
  try {
    if (sourceMode !== undefined) {
      await chmod(temporaryDirectory, copyModeWithoutSpecialBits(sourceMode));
    }
    await publishMigrationPath(temporaryDirectory, target);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function publishMigrationPath(
  source: string,
  target: string,
  replaceExisting = false,
  onPublished?: (ownership: import('node:fs').BigIntStats) => void
): Promise<import('node:fs').BigIntStats> {
  const targetParent = dirname(target);
  const targetParentIdentity = await captureDirectoryIdentity(targetParent);
  const sourceOwnership = await lstat(source, { bigint: true });
  let publishedOwnership: import('node:fs').BigIntStats | undefined;
  const recordPublication = (ownership: import('node:fs').BigIntStats): void => {
    // This deliberately runs at the filesystem commit point, before any
    // post-publication checks that can still reject the operation.
    publishedOwnership = ownership;
    onPublished?.(ownership);
  };

  const rollbackRegularFileAfterFailure = async (): Promise<void> => {
    if (publishedOwnership?.isFile()) {
      await removeOwnedRegularFileIfPresent(
        target,
        publishedOwnership,
        'failed publication target'
      );
    }
  };

  if (process.platform !== 'win32') {
    if (replaceExisting) {
      await rename(source, target);
      recordPublication(sourceOwnership);
      await assertDirectoryIdentityUnchanged(targetParent, targetParentIdentity);
      return sourceOwnership;
    }

    if (!sourceOwnership.isFile()) {
      throw new Error(
        `Migration verification failed: no-replace POSIX publication only supports regular files (${source}); source preserved.`
      );
    }
    try {
      await link(source, target);
    } catch (error) {
      if (!isHardLinkUnavailable(error)) {
        throw error;
      }
      try {
        const targetOwnership = await publishMigrationFileByExclusiveCopy(
          source,
          target,
          sourceOwnership,
          recordPublication
        );
        await assertDirectoryIdentityUnchanged(targetParent, targetParentIdentity);
        return targetOwnership;
      } catch (fallbackError) {
        await rollbackRegularFileAfterFailure();
        throw fallbackError;
      }
    }
    try {
      recordPublication(sourceOwnership);
      await assertDirectoryIdentityUnchanged(targetParent, targetParentIdentity);
      await removeOwnedRegularFileIfPresent(source, sourceOwnership, 'published temporary file');
      return sourceOwnership;
    } catch (error) {
      await rollbackRegularFileAfterFailure();
      throw error;
    }
  }

  try {
    await publishWindowsMoveBatch(
      [{ source, target, replaceExisting }],
      dirname(source),
      () => recordPublication(sourceOwnership)
    );
    await assertDirectoryIdentityUnchanged(targetParent, targetParentIdentity);
    return sourceOwnership;
  } catch (error) {
    // A helper process can report failure after MoveFileExW committed. If the
    // source disappeared and the target still has its inode, authenticate that
    // publication before attempting rollback.
    if (!publishedOwnership) {
      const [sourceAfter, targetAfter] = await Promise.all([
        lstatBigIntIfExists(source),
        lstatBigIntIfExists(target)
      ]);
      if (
        !sourceAfter
        && targetAfter
        && targetAfter.dev === sourceOwnership.dev
        && targetAfter.ino === sourceOwnership.ino
      ) {
        publishedOwnership = targetAfter;
        onPublished?.(targetAfter);
      }
    }
    if (!replaceExisting) {
      await rollbackRegularFileAfterFailure();
    }
    throw error;
  }
}

export async function publishMigrationFileByExclusiveCopy(
  source: string,
  target: string,
  sourceOwnership?: import('node:fs').BigIntStats,
  onPublished?: (ownership: import('node:fs').BigIntStats) => void
): Promise<import('node:fs').BigIntStats> {
  const ownedSource = sourceOwnership ?? await lstat(source, { bigint: true });
  if (!ownedSource.isFile()) {
    throw new Error(
      `Migration verification failed: fallback publication source ${source} is not a regular file; source preserved.`
    );
  }

  const targetParent = dirname(target);
  const targetParentIdentity = await captureDirectoryIdentity(targetParent);

  const targetHandle = await open(
    target,
    'wx',
    copyModeWithoutSpecialBits(Number(ownedSource.mode))
  );
  let targetOwnership: import('node:fs').BigIntStats | undefined;
  let copyError: unknown;
  try {
    targetOwnership = await targetHandle.stat({ bigint: true });
    onPublished?.(targetOwnership);
    for await (const chunk of createReadStream(source)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await targetHandle.write(
          buffer,
          offset,
          buffer.length - offset
        );
        if (bytesWritten === 0) {
          throw new Error(
            `Migration verification failed: fallback publication made no progress writing ${target}; source preserved.`
          );
        }
        offset += bytesWritten;
      }
    }
    await targetHandle.chmod(copyModeWithoutSpecialBits(Number(ownedSource.mode)));
    await targetHandle.sync();
  } catch (error) {
    copyError = error;
  } finally {
    await targetHandle.close();
  }

  if (copyError !== undefined) {
    if (targetOwnership) {
      await removeOwnedRegularFileIfPresent(
        target,
        targetOwnership,
        'fallback publication target'
      );
    }
    throw copyError;
  }

  if (!targetOwnership) {
    throw new Error(
      `Migration verification failed: fallback publication did not capture ownership for ${target}; source preserved.`
    );
  }
  try {
    await assertDirectoryIdentityUnchanged(targetParent, targetParentIdentity);
    await verifyFileContents(source, target, basename(target));
    await removeOwnedRegularFileIfPresent(source, ownedSource, 'published temporary file');
    return targetOwnership;
  } catch (error) {
    await removeOwnedRegularFileIfPresent(
      target,
      targetOwnership,
      'fallback publication target'
    );
    throw error;
  }
}

function isHardLinkUnavailable(error: unknown): boolean {
  return ['EMLINK', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']
    .some((code) => isNodeErrorCode(error, code));
}

async function publishWindowsMoveBatch(
  operations: WindowsMoveOperation[],
  manifestDirectory: string,
  onMoved?: () => void
): Promise<void> {
  if (operations.length === 0) {
    return;
  }
  if (operations.length > MAX_WINDOWS_MOVE_OPERATIONS) {
    throw new Error(
      `Migration verification failed: Windows publication requires ${operations.length} moves, `
        + `exceeding the safety limit of ${MAX_WINDOWS_MOVE_OPERATIONS}; source preserved.`
    );
  }

  const existingTargetParentIdentities = new Map<string, import('node:fs').BigIntStats>();
  for (const operation of operations) {
    const parent = dirname(operation.target);
    if (existingTargetParentIdentities.has(parent)) {
      continue;
    }
    try {
      existingTargetParentIdentities.set(parent, await captureDirectoryIdentity(parent));
    } catch (error) {
      if (!isNodeErrorCode(error, 'ENOENT')) {
        throw error;
      }
      // A parent absent during planning must be an earlier directory move in
      // this authenticated batch; the final regular-tree verification covers it.
    }
  }

  const manifestPath = join(
    manifestDirectory,
    `${MIGRATION_MOVE_MANIFEST_PREFIX}${randomUUID()}.ndjson`
  );
  const hmacKey = randomBytes(32);
  const manifestHandle = await open(manifestPath, 'wx');
  let manifestOwnership: import('node:fs').BigIntStats | undefined;
  try {
    try {
      manifestOwnership = await manifestHandle.stat({ bigint: true });
      for (const [id, operation] of operations.entries()) {
        const mac = windowsMoveOperationMac(hmacKey, id, operation);
        const line = JSON.stringify({
          id,
          source: operation.source,
          target: operation.target,
          replaceExisting: operation.replaceExisting ?? false,
          mac
        });
        if (Buffer.byteLength(line, 'utf8') > MAX_WINDOWS_MOVE_LINE_BYTES) {
          throw new Error(
            `Migration verification failed: Windows move ${id} exceeds the bounded manifest line size; source preserved.`
          );
        }
        await manifestHandle.writeFile(`${line}\n`, 'utf8');
      }
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
  } catch (error) {
    if (manifestOwnership) {
      await removeOwnedRegularFileIfPresent(
        manifestPath,
        manifestOwnership,
        'Windows move manifest'
      );
    }
    throw error;
  }

  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$signature = @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class Kb1NativeMove {',
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern bool MoveFileExW(string existingName, string newName, uint flags);',
    '}',
    "'@",
    'Add-Type -TypeDefinition $signature',
    '$expected = [int]$env:KB1_MOVE_COUNT',
    '$hmacKey = [Convert]::FromBase64String($env:KB1_MOVE_HMAC_KEY)',
    '$index = 0',
    'Get-Content -LiteralPath $env:KB1_MOVE_MANIFEST -Encoding UTF8 -ReadCount 1 | ForEach-Object {',
    '  $line = [string]$_',
    `  if ([Text.Encoding]::UTF8.GetByteCount($line) -gt ${MAX_WINDOWS_MOVE_LINE_BYTES}) {`,
    '    throw "Move manifest line $index exceeds the bounded line size"',
    '  }',
    '  $operation = ConvertFrom-Json -InputObject $line -ErrorAction Stop',
    '  if ($operation.id -ne $index) { throw "Move manifest id mismatch at operation $index" }',
    '  if ([string]::IsNullOrWhiteSpace([string]$operation.source)) {',
    '    throw "Move manifest source missing at operation $index"',
    '  }',
    '  if ([string]::IsNullOrWhiteSpace([string]$operation.target)) {',
    '    throw "Move manifest target missing at operation $index"',
    '  }',
    '  if ([string]$operation.mac -notmatch "^[0-9a-f]{64}$") {',
    '    throw "Move manifest MAC missing at operation $index"',
    '  }',
    '  $sourceBytes = [Text.Encoding]::UTF8.GetBytes([string]$operation.source)',
    '  $targetBytes = [Text.Encoding]::UTF8.GetBytes([string]$operation.target)',
    '  if ($operation.PSObject.Properties.Name -notcontains "replaceExisting") {',
    '    throw "Move manifest replace flag missing at operation $index"',
    '  }',
    '  $replaceExisting = [bool]$operation.replaceExisting',
    '  $payload = [byte[]]::new((13 + $sourceBytes.Length + $targetBytes.Length))',
    '  [BitConverter]::GetBytes([int]$operation.id).CopyTo($payload, 0)',
    '  [BitConverter]::GetBytes([int]$sourceBytes.Length).CopyTo($payload, 4)',
    '  [BitConverter]::GetBytes([int]$targetBytes.Length).CopyTo($payload, 8)',
    '  $payload[12] = if ($replaceExisting) { 1 } else { 0 }',
    '  [Array]::Copy($sourceBytes, 0, $payload, 13, $sourceBytes.Length)',
    '  [Array]::Copy($targetBytes, 0, $payload, (13 + $sourceBytes.Length), $targetBytes.Length)',
    '  $hmac = [System.Security.Cryptography.HMACSHA256]::new($hmacKey)',
    '  try {',
    "    $actualMac = -join ($hmac.ComputeHash($payload) | ForEach-Object { $_.ToString('x2') })",
    '  } finally {',
    '    $hmac.Dispose()',
    '  }',
    '  if ($actualMac -cne [string]$operation.mac) {',
    '    throw "Move manifest authentication failed at operation $index"',
    '  }',
    '  $moveFlags = if ($replaceExisting) { 9 } else { 8 }',
    '  if (-not [Kb1NativeMove]::MoveFileExW($operation.source, $operation.target, $moveFlags)) {',
    '    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()',
    '    throw "MoveFileExW failed at operation $index with Win32 error $code"',
    '  }',
    '  $index += 1',
    '}',
    'if ($index -ne $expected) {',
    '  throw "Move manifest count mismatch: expected $expected, processed $index"',
    '}'
  ].join('\n');
  try {
    await execFileAsync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: {
          ...process.env,
          KB1_MOVE_COUNT: String(operations.length),
          KB1_MOVE_MANIFEST: manifestPath,
          KB1_MOVE_HMAC_KEY: hmacKey.toString('base64')
        },
        windowsHide: true
      }
    );
    onMoved?.();
    for (const [parent, identity] of existingTargetParentIdentities) {
      await assertDirectoryIdentityUnchanged(parent, identity);
    }
  } finally {
    if (manifestOwnership) {
      await removeOwnedRegularFileIfPresent(
        manifestPath,
        manifestOwnership,
        'Windows move manifest'
      );
    }
  }
}

function windowsMoveOperationMac(
  key: Buffer,
  id: number,
  operation: WindowsMoveOperation
): string {
  const source = Buffer.from(operation.source, 'utf8');
  const target = Buffer.from(operation.target, 'utf8');
  const header = Buffer.allocUnsafe(13);
  header.writeUInt32LE(id, 0);
  header.writeUInt32LE(source.length, 4);
  header.writeUInt32LE(target.length, 8);
  header.writeUInt8(operation.replaceExisting ? 1 : 0, 12);
  return createHmac('sha256', key)
    .update(header)
    .update(source)
    .update(target)
    .digest('hex');
}

export async function verifyCopy(source: string, target: string): Promise<void> {
  await verifyDirectory(source, target, source);
  await assertRegularDirectoryTree(target, target);
}

export async function verifyFileContents(
  sourceFile: string,
  targetFile: string,
  relativePath = relative(sourceFile, targetFile)
): Promise<void> {
  const [sourceInfo, targetInfo] = await Promise.all([
    lstat(sourceFile),
    lstatIfExists(targetFile)
  ]);

  if (!sourceInfo.isFile()) {
    throw new Error(`Migration verification failed: ${relativePath} is not a regular source file.`);
  }
  if (sourceInfo.nlink !== 1) {
    throw new Error(
      `Migration verification failed: ${relativePath} is a hard-linked source file; source preserved.`
    );
  }
  if (!targetInfo) {
    throw new Error(`Migration verification failed: ${relativePath} missing from copy.`);
  }
  if (!targetInfo.isFile()) {
    throw new Error(`Migration verification failed: ${relativePath} is not a regular file in the copy.`);
  }
  assertTargetPermissionsNoBroader(sourceInfo.mode, targetInfo.mode, relativePath, 'file');
  if (
    targetInfo.nlink !== 1
    || (sourceInfo.dev === targetInfo.dev && sourceInfo.ino === targetInfo.ino)
  ) {
    throw new Error(
      `Migration verification failed: ${relativePath} is not an independent copy (multiple hard links); source preserved.`
    );
  }
  if (sourceInfo.size !== targetInfo.size) {
    throw new Error(
      `Migration verification failed: ${relativePath} size mismatch (source ${sourceInfo.size}, copy ${targetInfo.size}).`
    );
  }

  const [sourceDigest, targetDigest] = await Promise.all([
    sha256File(sourceFile),
    sha256File(targetFile)
  ]);
  if (sourceDigest !== targetDigest) {
    throw new Error(`Migration verification failed: ${relativePath} content mismatch.`);
  }
}

async function verifyDirectory(source: string, target: string, sourceRoot: string): Promise<void> {
  const relPath = relative(sourceRoot, source) || '.';
  const [sourceInfo, targetInfo] = await Promise.all([
    lstatIfExists(source),
    lstatIfExists(target)
  ]);
  if (!sourceInfo?.isDirectory()) {
    throw new Error(
      `Migration verification failed: ${relPath} is not a regular source directory; source preserved.`
    );
  }
  if (!targetInfo) {
    throw new Error(`Migration verification failed: ${relPath} directory missing from copy.`);
  }
  if (!targetInfo.isDirectory()) {
    throw new Error(`Migration verification failed: ${relPath} is not a directory in the copy.`);
  }
  assertTargetPermissionsNoBroader(sourceInfo.mode, targetInfo.mode, relPath, 'directory');

  const entries = await readdir(source, { withFileTypes: true });
  assertNoPortableNameCollisions(entries, relPath, 'source');
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const entryPath = relative(sourceRoot, sourcePath);

    if (isReservedMigrationControlName(entry.name)) {
      throw new Error(
        `Migration verification failed: ${entryPath} is reserved for migration completion state; source preserved.`
      );
    }
    if (entry.isDirectory()) {
      await verifyDirectory(sourcePath, targetPath, sourceRoot);
      continue;
    }
    if (entry.isFile()) {
      await verifyFileContents(sourcePath, targetPath, entryPath);
      continue;
    }

    throw new Error(
      `Migration verification failed: ${entryPath} has an unsupported filesystem type; source preserved.`
    );
  }
}

async function assertRegularDirectoryTree(root: string, current: string): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  assertNoPortableNameCollisions(entries, relative(root, current) || '.', 'copy');
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (isReservedMigrationControlName(entry.name)) {
      throw new Error(
        `Migration verification failed: ${relative(root, path)} is reserved for migration control state in the copy; source preserved.`
      );
    }
    if (entry.isDirectory()) {
      await assertRegularDirectoryTree(root, path);
      continue;
    }
    if (entry.isFile()) {
      const info = await lstat(path);
      if (info.nlink !== 1) {
        throw new Error(
          `Migration verification failed: ${relative(root, path)} is not an independent copy (multiple hard links); source preserved.`
        );
      }
      continue;
    }

    throw new Error(
      `Migration verification failed: ${relative(root, path)} is not a regular file in the copy; source preserved.`
    );
  }
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

async function captureSourceTreeManifest(root: string): Promise<string> {
  const manifest = createHash('sha256');
  await appendSourceDirectoryManifest(root, root, manifest);
  return manifest.digest('hex');
}

async function capturePortableSourceTreeDigest(root: string): Promise<string> {
  const digest = createHash('sha256');
  await appendPortableSourceDirectoryDigest(root, root, digest, []);
  return digest.digest('hex');
}

export function portableMigrationDigestPath(pathSegments: string[]): string {
  return pathSegments.length === 0 ? '.' : pathSegments.join('/');
}

async function appendPortableSourceDirectoryDigest(
  root: string,
  current: string,
  digest: ReturnType<typeof createHash>,
  pathSegments: string[]
): Promise<void> {
  const relDirectory = portableMigrationDigestPath(pathSegments);
  const before = await lstat(current, { bigint: true });
  if (!before.isDirectory()) {
    throw new Error(
      `Migration verification failed: ${relDirectory} is not a regular source directory; source preserved.`
    );
  }
  const entries = await readdir(current, { withFileTypes: true });
  assertNoPortableNameCollisions(entries, relDirectory, 'source');
  entries.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  digest.update(JSON.stringify(['directory', relDirectory, entries.map((entry) => entry.name)]));

  for (const entry of entries) {
    const path = join(current, entry.name);
    const entryPathSegments = [...pathSegments, entry.name];
    const relPath = portableMigrationDigestPath(entryPathSegments);
    if (isReservedMigrationControlName(entry.name)) {
      throw new Error(
        `Migration verification failed: ${relPath} is reserved for migration control state; source preserved.`
      );
    }
    if (entry.isDirectory()) {
      await appendPortableSourceDirectoryDigest(root, path, digest, entryPathSegments);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Migration verification failed: ${relPath} has an unsupported filesystem type; source preserved.`
      );
    }

    const fileBefore = await lstat(path, { bigint: true });
    if (!fileBefore.isFile() || fileBefore.nlink !== 1n) {
      throw new Error(
        `Migration verification failed: ${relPath} is a hard-linked or unsupported source file; source preserved.`
      );
    }
    const fileDigest = await sha256File(path);
    const fileAfter = await lstat(path, { bigint: true });
    if (!sameStableStats(fileBefore, fileAfter)) {
      throw new Error(
        `Migration verification failed: ${relPath} changed while it was being read; source preserved.`
      );
    }
    digest.update(JSON.stringify(['file', relPath, fileDigest, fileAfter.size.toString()]));
  }

  const after = await lstat(current, { bigint: true });
  if (!sameStableStats(before, after)) {
    throw new Error(
      `Migration verification failed: ${relDirectory} changed while it was being read; source preserved.`
    );
  }
}

async function captureTargetTreeManifest(root: string): Promise<string> {
  const manifest = createHash('sha256');
  await appendTargetDirectoryManifest(root, root, manifest);
  return manifest.digest('hex');
}

async function appendTargetDirectoryManifest(
  root: string,
  current: string,
  manifest: ReturnType<typeof createHash>
): Promise<void> {
  const before = await lstat(current, { bigint: true });
  if (!before.isDirectory()) {
    throw new Error(
      `Migration verification failed: ${relative(root, current) || '.'} is not a regular directory in the copy; source preserved.`
    );
  }

  const entries = await readdir(current, { withFileTypes: true });
  const relDirectory = relative(root, current) || '.';
  assertNoPortableNameCollisions(entries, relDirectory, 'copy');
  entries.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  const dataEntries = entries.filter(
    (entry) => current !== root || entry.name !== MIGRATION_COMPLETION_FILENAME
  );
  manifest.update(JSON.stringify([
    'directory',
    relDirectory,
    dataEntries.map((entry) => entry.name),
    before.mode.toString(),
    before.dev.toString(),
    before.ino.toString(),
    // APFS increments the root directory's link count when the intentionally
    // excluded completion marker is published. Nested directory link counts
    // remain part of the manifest because marker publication cannot touch them.
    current === root ? null : before.nlink.toString()
  ]));

  for (const entry of dataEntries) {
    const path = join(current, entry.name);
    const relPath = relative(root, path);
    if (isReservedMigrationControlName(entry.name)) {
      throw new Error(
        `Migration verification failed: ${relPath} is reserved for migration control state in the copy; source preserved.`
      );
    }
    if (entry.isDirectory()) {
      await appendTargetDirectoryManifest(root, path, manifest);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Migration verification failed: ${relPath} is not a regular file in the copy; source preserved.`
      );
    }

    const fileBefore = await lstat(path, { bigint: true });
    if (!fileBefore.isFile() || fileBefore.nlink !== 1n) {
      throw new Error(
        `Migration verification failed: ${relPath} is not an independent regular file in the copy; source preserved.`
      );
    }
    const fileDigest = await sha256File(path);
    const fileAfter = await lstat(path, { bigint: true });
    if (!sameStableStats(fileBefore, fileAfter)) {
      throw new Error(
        `Migration verification failed: ${relPath} changed while the copy was being read; source preserved.`
      );
    }
    manifest.update(JSON.stringify([
      'file',
      relPath,
      fileDigest,
      fileAfter.size.toString(),
      fileAfter.mode.toString(),
      fileAfter.dev.toString(),
      fileAfter.ino.toString(),
      fileAfter.mtimeNs.toString(),
      fileAfter.ctimeNs.toString()
    ]));
  }

  const after = await lstat(current, { bigint: true });
  if (!sameStableStats(before, after)) {
    throw new Error(
      `Migration verification failed: ${relDirectory} changed while the copy was being read; source preserved.`
    );
  }
}

async function appendSourceDirectoryManifest(
  root: string,
  current: string,
  manifest: ReturnType<typeof createHash>
): Promise<void> {
  const before = await lstat(current, { bigint: true });
  if (!before.isDirectory()) {
    throw new Error(
      `Migration verification failed: ${relative(root, current) || '.'} is not a regular source directory; source preserved.`
    );
  }

  const entries = await readdir(current, { withFileTypes: true });
  const relDirectory = relative(root, current) || '.';
  assertNoPortableNameCollisions(entries, relDirectory, 'source');
  entries.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  manifest.update(JSON.stringify([
    'directory',
    relDirectory,
    entries.map((entry) => entry.name),
    before.mode.toString(),
    before.dev.toString(),
    before.ino.toString(),
    before.nlink.toString(),
    before.mtimeNs.toString(),
    before.ctimeNs.toString()
  ]));

  for (const entry of entries) {
    const path = join(current, entry.name);
    const relPath = relative(root, path);
    if (isReservedMigrationControlName(entry.name)) {
      throw new Error(
        `Migration verification failed: ${relPath} is reserved for migration completion state; source preserved.`
      );
    }
    if (entry.isDirectory()) {
      await appendSourceDirectoryManifest(root, path, manifest);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Migration verification failed: ${relPath} has an unsupported filesystem type; source preserved.`
      );
    }

    const fileBefore = await lstat(path, { bigint: true });
    if (!fileBefore.isFile() || fileBefore.nlink !== 1n) {
      throw new Error(
        `Migration verification failed: ${relPath} is a hard-linked or unsupported source file; source preserved.`
      );
    }
    const fileDigest = await sha256File(path);
    const fileAfter = await lstat(path, { bigint: true });
    if (!sameStableStats(fileBefore, fileAfter)) {
      throw new Error(
        `Migration verification failed: ${relPath} changed while it was being read; source preserved.`
      );
    }
    manifest.update(JSON.stringify([
      'file',
      relPath,
      fileDigest,
      fileAfter.size.toString(),
      fileAfter.mode.toString(),
      fileAfter.dev.toString(),
      fileAfter.ino.toString(),
      fileAfter.mtimeNs.toString(),
      fileAfter.ctimeNs.toString()
    ]));
  }

  const after = await lstat(current, { bigint: true });
  if (!sameStableStats(before, after)) {
    throw new Error(
      `Migration verification failed: ${relDirectory} changed while it was being read; source preserved.`
    );
  }
}

function sameStableStats(
  left: import('node:fs').BigIntStats,
  right: import('node:fs').BigIntStats
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function captureDirectoryIdentity(path: string): Promise<import('node:fs').BigIntStats> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory()) {
    throw new Error(
      `Migration verification failed: publication parent ${path} is not a regular directory; source preserved.`
    );
  }
  return info;
}

async function assertDirectoryIdentityUnchanged(
  path: string,
  expected: import('node:fs').BigIntStats
): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (
    !current.isDirectory()
    || current.dev !== expected.dev
    || current.ino !== expected.ino
  ) {
    throw new Error(
      `Migration verification failed: publication parent ${path} changed filesystem identity during migration; source preserved. Stop all writers and recover manually.`
    );
  }
}

function assertTargetPermissionsNoBroader(
  sourceMode: number,
  targetMode: number,
  relativePath: string,
  kind: 'file' | 'directory'
): void {
  if (process.platform === 'win32') {
    return;
  }

  const sourcePermissions = sourceMode & 0o7777;
  const targetPermissions = targetMode & 0o7777;
  const targetAddsAccess = (targetPermissions & 0o777) & ~(sourcePermissions & 0o777);
  const targetHasSpecialBits = (targetPermissions & 0o7000) !== 0;
  if (targetAddsAccess !== 0 || targetHasSpecialBits) {
    throw new Error(
      `Migration verification failed: ${relativePath} ${kind} permissions are broader than the source `
        + `(source ${formatMode(sourcePermissions)}, copy ${formatMode(targetPermissions)}); source preserved.`
    );
  }
}

async function temporarilyGrantOwnerWrite(
  path: string,
  originalMode: number
): Promise<() => Promise<void>> {
  const normalizedMode = originalMode & 0o7777;
  if (process.platform === 'win32' || (normalizedMode & 0o200) !== 0) {
    return async () => undefined;
  }

  await chmod(path, normalizedMode | 0o200);
  let restored = false;
  return async () => {
    if (restored) {
      return;
    }
    await chmod(path, normalizedMode);
    restored = true;
  };
}

function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

function assertNoPortableNameCollisions(
  entries: import('node:fs').Dirent[],
  directoryPath: string,
  side: 'source' | 'copy'
): void {
  const names = new Map<string, string>();
  for (const entry of entries) {
    const canonical = canonicalFilesystemSegment(entry.name);
    const previous = names.get(canonical);
    if (previous !== undefined && previous !== entry.name) {
      throw new Error(
        `Migration verification failed: ${directoryPath} contains portable-name collision "${previous}" / "${entry.name}" in the ${side}; source preserved.`
      );
    }
    names.set(canonical, entry.name);
  }
}

async function syncDirectoryTree(root: string): Promise<void> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error(
      `Migration verification failed: target ${root} is not a regular directory; source preserved.`
    );
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await syncDirectoryTree(path);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Migration verification failed: ${relative(root, path)} has an unsupported filesystem type in the copy; source preserved.`
      );
    }

    await syncRegularFile(path);
  }

  if (process.platform !== 'win32') {
    await syncDirectory(root);
  }
}

async function syncRegularFile(path: string): Promise<void> {
  if (process.platform !== 'win32') {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }

  // FlushFileBuffers requires write access on Windows. Temporarily clear the
  // read-only mode bit when necessary, then restore it before completion.
  const info = await lstat(path);
  const needsWritableMode = (info.mode & 0o200) === 0;
  if (needsWritableMode) {
    await chmod(path, info.mode | 0o200);
  }
  try {
    const handle = await open(path, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    if (needsWritableMode) {
      await chmod(path, info.mode);
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function migrationCompletionMarker(
  source: string,
  target: string,
  migrationSourceDigest: string,
  sourceIdentityScope: MigrationSourceIdentityScope
): Promise<MigrationCompletionMarker> {
  const binding = await captureMigrationBinding(source, target, sourceIdentityScope);
  return {
    schemaVersion: 1,
    sourceName: basename(source),
    targetName: basename(target),
    verification: 'sha256-tree',
    pathPairFingerprint: binding.pathPairFingerprint,
    sourceVaultId: binding.sourceVaultId,
    migrationSourceDigest
  };
}

function isMigrationCompletionMarkerForPaths(
  value: unknown,
  source: string,
  target: string
): value is MigrationCompletionMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 7
    && record.schemaVersion === 1
    && typeof record.sourceName === 'string'
    && typeof record.targetName === 'string'
    && migrationEndpointNamesMatch(
      record.sourceName,
      record.targetName,
      basename(source),
      basename(target)
    )
    && record.verification === 'sha256-tree'
    && typeof record.pathPairFingerprint === 'string'
    && /^[0-9a-f]{64}$/u.test(record.pathPairFingerprint)
    && (record.sourceVaultId === null || (
      typeof record.sourceVaultId === 'string' && record.sourceVaultId.length > 0
    ))
    && typeof record.migrationSourceDigest === 'string'
    && /^[0-9a-f]{64}$/u.test(record.migrationSourceDigest);
}

function migrationEndpointNamesMatch(
  recordedSource: string,
  recordedTarget: string,
  currentSource: string,
  currentTarget: string
): boolean {
  if (recordedSource === currentSource && recordedTarget === currentTarget) {
    return true;
  }

  const isSupportedDaemonHomePair = (sourceName: string, targetName: string): boolean => (
    (sourceName === '.kb2' && targetName === '.kb1')
    || (sourceName === 'kb2' && targetName === 'kb1')
  );
  return isSupportedDaemonHomePair(recordedSource, recordedTarget)
    && isSupportedDaemonHomePair(currentSource, currentTarget);
}

function assertTrustedCompletionMarker(
  markerPath: string,
  markerInfo: import('node:fs').Stats
): void {
  if (markerInfo.nlink !== 1 || markerInfo.size > MAX_COMPLETION_MARKER_BYTES) {
    throw new Error(
      `Migration verification failed: completion marker ${markerPath} has untrusted link count or size; source preserved.`
    );
  }
  if (process.platform === 'win32') {
    return;
  }

  const effectiveUid = process.geteuid?.();
  if (
    (effectiveUid !== undefined && markerInfo.uid !== effectiveUid)
    || (markerInfo.mode & 0o022) !== 0
  ) {
    throw new Error(
      `Migration verification failed: completion marker ${markerPath} has untrusted owner or writable group/other permissions; source preserved.`
    );
  }
}

async function captureMigrationBinding(
  source: string,
  target: string,
  sourceIdentityScope: MigrationSourceIdentityScope
): Promise<{ pathPairFingerprint: string; sourceVaultId: string | null }> {
  const [resolvedSource, resolvedTarget, sourceVaultId] = await Promise.all([
    realpath(source),
    realpath(target),
    readMigrationSourceVaultId(source, sourceIdentityScope)
  ]);
  const canonicalSource = process.platform === 'win32'
    ? resolvedSource.toLowerCase()
    : resolvedSource;
  const canonicalTarget = process.platform === 'win32'
    ? resolvedTarget.toLowerCase()
    : resolvedTarget;
  const pathPairFingerprint = createHash('sha256')
    .update(JSON.stringify([canonicalSource, canonicalTarget]))
    .digest('hex');
  return { pathPairFingerprint, sourceVaultId };
}

async function readMigrationSourceVaultId(
  source: string,
  sourceIdentityScope: MigrationSourceIdentityScope
): Promise<string | null> {
  if (sourceIdentityScope === 'none') {
    return null;
  }
  const candidates = sourceIdentityScope === 'metadata-directory'
    ? [join(source, 'vault.json')]
    : [join(source, '.kb2', 'vault.json'), join(source, '.kb1', 'vault.json')];
  for (const candidate of candidates) {
    const info = await lstatIfExists(candidate);
    if (!info) {
      continue;
    }
    if (!info.isFile()) {
      throw new Error(
        `Migration verification failed: vault identity ${candidate} is not a regular file; source preserved.`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(candidate, 'utf8'));
    } catch {
      throw new Error(
        `Migration verification failed: vault identity ${candidate} is invalid; source preserved.`
      );
    }
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || typeof (parsed as Record<string, unknown>).id !== 'string'
      || ((parsed as Record<string, unknown>).id as string).length === 0
    ) {
      throw new Error(
        `Migration verification failed: vault identity ${candidate} is invalid; source preserved.`
      );
    }
    return (parsed as Record<string, string>).id;
  }
  return null;
}

interface MigrationStagingManifest {
  schemaVersion: 1;
  source: string;
  target: string;
}

function migrationStagingManifest(source: string, target: string): MigrationStagingManifest {
  return { schemaVersion: 1, source, target };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function canonicalFilesystemSegment(segment: string): string {
  return segment.normalize('NFC').replace(/[ .]+$/u, '').toLowerCase();
}

async function lstatIfExists(path: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

async function lstatBigIntIfExists(
  path: string
): Promise<import('node:fs').BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

async function removeOwnedRegularFileIfPresent(
  path: string,
  ownership: import('node:fs').BigIntStats,
  description: string
): Promise<void> {
  let current: import('node:fs').BigIntStats;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  if (
    !current.isFile()
    || !ownership.isFile()
    || current.dev !== ownership.dev
    || current.ino !== ownership.ino
  ) {
    throw new Error(
      `Migration verification failed: ${description} ${path} no longer matches the inode created by this migration; it was preserved for manual recovery.`
    );
  }
  await rm(path);
}
