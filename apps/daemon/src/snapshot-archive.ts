import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { Readable, Transform } from 'node:stream';

import { ZipFile } from 'yazl';

export const SNAPSHOT_ARCHIVE_SCHEMA_VERSION = 1;
export const SNAPSHOT_MANIFEST_PATH = 'kb1-snapshot.json';
export const SNAPSHOT_COMPLETION_PATH = 'kb1-snapshot.complete';

export interface SnapshotArchiveFile {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  mode: number;
  sha256: string;
}

export interface SnapshotArchiveManifest {
  schemaVersion: typeof SNAPSHOT_ARCHIVE_SCHEMA_VERSION;
  createdAt: string;
  durableAsOf: string;
  files: SnapshotArchiveFile[];
  totals: {
    files: number;
    bytes: number;
  };
}

export interface SnapshotArchive {
  stream: Readable;
  manifest: SnapshotArchiveManifest;
}

interface SnapshotRoot {
  archivePath: string;
  filesystemPath: string;
}

interface PlannedFile extends SnapshotArchiveFile {
  filesystemPath: string;
  device: number;
  inode: number;
  modifiedAtMs: number;
  changedAtMs: number;
}

interface PlannedDirectory {
  path: string;
  filesystemPath: string;
  modifiedAt: Date;
  device: number;
  inode: number;
  modifiedAtMs: number;
  changedAtMs: number;
  mode: number;
}

const LOCAL_KB1_DIRECTORY_NAMES = new Set(['cache', 'runtime', 'secrets', 'tmp']);
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const WINDOWS_INVALID_CHARACTER = /[<>:"\\|?*\u0000-\u001f]/;

/**
 * Build one portable ZIP containing every active vault plus the daemon trash.
 * Callers must flush live document sessions before invoking this function.
 *
 * Files are planned with lstat and reopened lazily as yazl consumes them. If a
 * file was replaced between planning and streaming, the stream fails instead
 * of silently producing a mixed snapshot. Hosted daemon writes are atomic
 * renames, so this detects the concurrent-write shape that matters there.
 */
export async function createSnapshotArchive(input: {
  roots: SnapshotRoot[];
  createdAt: Date;
  durableAsOf: Date;
  signal?: AbortSignal;
}): Promise<SnapshotArchive> {
  throwIfSnapshotAborted(input.signal);
  const plan = await planSnapshot(input.roots, input.signal);
  throwIfSnapshotAborted(input.signal);
  const manifest: SnapshotArchiveManifest = {
    schemaVersion: SNAPSHOT_ARCHIVE_SCHEMA_VERSION,
    createdAt: input.createdAt.toISOString(),
    durableAsOf: input.durableAsOf.toISOString(),
    files: plan.files.map((file) => manifestFile(file)),
    totals: {
      files: plan.files.length,
      bytes: plan.files.reduce((total, file) => total + file.sizeBytes, 0),
    },
  };

  const archive = new ZipFile();
  const outputStream = archive.outputStream as Readable;
  // Creation returns before the HTTP caller can attach pipeline listeners.
  // Keep cancellation or lazy ZIP failures in that gap from becoming an
  // uncaught process-level error; downstream consumers still receive the same
  // error event and reject normally.
  outputStream.on('error', () => undefined);
  const activeSources = new Set<Readable>();
  let stopped = false;
  archive.on('error', (error: Error) => {
    outputStream.destroy(error);
  });
  const abortHandler = () => {
    stopped = true;
    outputStream.destroy(snapshotAbortError(input.signal));
  };
  input.signal?.addEventListener('abort', abortHandler, { once: true });
  outputStream.once('close', () => {
    stopped = true;
    input.signal?.removeEventListener('abort', abortHandler);
    for (const source of activeSources) source.destroy();
    activeSources.clear();
  });
  archive.addBuffer(
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    SNAPSHOT_MANIFEST_PATH,
    { mtime: input.createdAt, mode: 0o100600 },
  );
  for (const directory of plan.directories) {
    archive.addEmptyDirectory(directory.path, {
      mtime: directory.modifiedAt,
      mode: directory.mode,
    });
  }
  for (const file of plan.files) {
    archive.addReadStreamLazy(
      file.path,
      {
        mtime: new Date(file.modifiedAt),
        mode: file.mode,
        size: file.sizeBytes,
        compress: true,
      },
      (callback) => {
        if (stopped || input.signal?.aborted) {
          callback(snapshotAbortError(input.signal), Readable.from([]));
          return;
        }
        void open(file.filesystemPath, 'r').then(async (handle) => {
          try {
            if (stopped || input.signal?.aborted) {
              await handle.close();
              callback(snapshotAbortError(input.signal), Readable.from([]));
              return;
            }
            const current = await handle.stat();
            if (stopped || input.signal?.aborted) {
              await handle.close();
              callback(snapshotAbortError(input.signal), Readable.from([]));
              return;
            }
            if (
              current.dev !== file.device
              || current.ino !== file.inode
              || current.size !== file.sizeBytes
              || current.mtimeMs !== file.modifiedAtMs
              || current.ctimeMs !== file.changedAtMs
              || current.mode !== file.mode
            ) {
              await handle.close();
              callback(new Error('Snapshot source changed while archiving.'), Readable.from([]));
              return;
            }
            const source = handle.createReadStream({ autoClose: true });
            const verifier = createHashVerifyingStream(file.sha256);
            // yazl's lazy stream API does not subscribe to source errors. Keep
            // one listener here so an EIO fails the HTTP body instead of
            // becoming an unhandled process error or a permanently open ZIP.
            source.once('error', (error) => archive.emit('error', error));
            verifier.once('error', (error) => archive.emit('error', error));
            activeSources.add(source);
            activeSources.add(verifier);
            source.once('close', () => activeSources.delete(source));
            verifier.once('close', () => activeSources.delete(verifier));
            source.pipe(verifier);
            callback(null, verifier);
          } catch (error) {
            await handle.close().catch(() => undefined);
            callback(error, Readable.from([]));
          }
        }, (error: unknown) => callback(error, Readable.from([])));
      },
    );
  }
  const completion = Buffer.from(`${input.createdAt.toISOString()}\n`, 'utf8');
  archive.addReadStreamLazy(
    SNAPSHOT_COMPLETION_PATH,
    {
      mtime: input.createdAt,
      mode: 0o100600,
      size: completion.byteLength,
      compress: false
    },
    (callback) => {
      if (stopped || input.signal?.aborted) {
        callback(snapshotAbortError(input.signal), Readable.from([]));
        return;
      }
      void validateSnapshotPlan(plan, input.signal).then(
        () => callback(null, Readable.from(completion)),
        (error: unknown) => callback(error, Readable.from([]))
      );
    }
  );
  archive.end();

  return {
    stream: outputStream,
    manifest,
  };
}

async function planSnapshot(roots: SnapshotRoot[], signal?: AbortSignal): Promise<{
  files: PlannedFile[];
  directories: PlannedDirectory[];
  missingRoots: SnapshotRoot[];
}> {
  const files: PlannedFile[] = [];
  const directories: PlannedDirectory[] = [];
  const missingRoots: SnapshotRoot[] = [];
  for (const root of roots) {
    throwIfSnapshotAborted(signal);
    const rootInfo = await lstatOrNull(root.filesystemPath);
    throwIfSnapshotAborted(signal);
    if (!rootInfo) {
      missingRoots.push(root);
      continue;
    }
    if (!rootInfo.isDirectory()) {
      throw new Error(`Snapshot root is not a directory: ${root.archivePath}`);
    }
    directories.push({
      path: archiveDirectoryPath(root.archivePath),
      filesystemPath: root.filesystemPath,
      modifiedAt: rootInfo.mtime,
      modifiedAtMs: rootInfo.mtimeMs,
      changedAtMs: rootInfo.ctimeMs,
      device: rootInfo.dev,
      inode: rootInfo.ino,
      mode: rootInfo.mode,
    });
    await walkSnapshotRoot(root.filesystemPath, root.archivePath, files, directories, signal);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort((left, right) => left.path.localeCompare(right.path));
  validatePortableArchivePaths(files, directories);
  return { files, directories, missingRoots };
}

async function walkSnapshotRoot(
  filesystemPath: string,
  archivePath: string,
  files: PlannedFile[],
  directories: PlannedDirectory[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfSnapshotAborted(signal);
  const entries = await readdir(filesystemPath, { withFileTypes: true });
  throwIfSnapshotAborted(signal);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    throwIfSnapshotAborted(signal);
    const childFilesystemPath = join(filesystemPath, entry.name);
    const childArchivePath = `${archivePath}/${entry.name}`;
    if (!isPortableSnapshotPath(childArchivePath)) continue;
    const info = await lstat(childFilesystemPath);
    throwIfSnapshotAborted(signal);
    if (info.isSymbolicLink()) {
      throw new Error('Snapshot source contains an unsupported symbolic link.');
    }
    if (info.isDirectory()) {
      directories.push({
        path: archiveDirectoryPath(childArchivePath),
        filesystemPath: childFilesystemPath,
        modifiedAt: info.mtime,
        modifiedAtMs: info.mtimeMs,
        changedAtMs: info.ctimeMs,
        device: info.dev,
        inode: info.ino,
        mode: info.mode,
      });
      await walkSnapshotRoot(childFilesystemPath, childArchivePath, files, directories, signal);
      continue;
    }
    if (!info.isFile()) {
      throw new Error('Snapshot source contains an unsupported filesystem entry.');
    }
    const plannedFile = {
      path: childArchivePath,
      filesystemPath: childFilesystemPath,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      modifiedAtMs: info.mtimeMs,
      changedAtMs: info.ctimeMs,
      mode: info.mode,
      device: info.dev,
      inode: info.ino,
    };
    files.push({
      ...plannedFile,
      sha256: await hashSnapshotFile(plannedFile, signal),
    });
  }
}

function validatePortableArchivePaths(
  files: PlannedFile[],
  directories: PlannedDirectory[],
): void {
  const paths = [
    SNAPSHOT_MANIFEST_PATH,
    SNAPSHOT_COMPLETION_PATH,
    ...directories.map((directory) => directory.path.replace(/\/$/, '')),
    ...files.map((file) => file.path),
  ];
  const canonicalPaths = new Map<string, string>();

  for (const path of paths) {
    const segments = path.split('/');
    for (const segment of segments) assertPortableArchiveSegment(segment);

    // Windows and common macOS installations compare names without case, and
    // macOS also normalizes canonically equivalent Unicode. Reject collisions
    // up front so extraction cannot silently merge two source entries.
    const canonicalPath = segments
      .map((segment) => segment.normalize('NFC').toLocaleLowerCase('en-US'))
      .join('/');
    const existing = canonicalPaths.get(canonicalPath);
    if (existing !== undefined) {
      throw new Error(`Snapshot source contains colliding portable paths: ${existing} and ${path}`);
    }
    canonicalPaths.set(canonicalPath, path);
  }
}

function assertPortableArchiveSegment(segment: string): void {
  if (
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || WINDOWS_INVALID_CHARACTER.test(segment)
    || /[. ]$/.test(segment)
    || WINDOWS_RESERVED_BASENAME.test(segment)
  ) {
    throw new Error(`Snapshot source contains a non-portable path segment: ${JSON.stringify(segment)}`);
  }
}

function isPortableSnapshotPath(path: string): boolean {
  const originalSegments = path.split('/');
  const segments = originalSegments.map((segment) => segment.toLocaleLowerCase('en-US'));
  const kb1Index = segments.lastIndexOf('.kb1');
  // `.kb1` is a reserved metadata directory whose canonical spelling is
  // lowercase. A distinct case-variant can exist on Linux but would collide
  // when the portable archive is restored on Windows or common macOS volumes.
  if (kb1Index >= 0 && originalSegments[kb1Index] !== '.kb1') return false;
  if (
    kb1Index >= 0
    && segments.length > kb1Index + 1
    && LOCAL_KB1_DIRECTORY_NAMES.has(segments[kb1Index + 1] ?? '')
  ) {
    return false;
  }

  const gitIndex = segments.lastIndexOf('.git');
  if (gitIndex < 0) return true;
  return false;
}

function manifestFile(file: PlannedFile): SnapshotArchiveFile {
  return {
    path: file.path,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    mode: file.mode,
    sha256: file.sha256,
  };
}

async function validateSnapshotPlan(plan: {
  files: PlannedFile[];
  directories: PlannedDirectory[];
  missingRoots: SnapshotRoot[];
}, signal?: AbortSignal): Promise<void> {
  for (const root of plan.missingRoots) {
    throwIfSnapshotAborted(signal);
    const current = await lstatOrNull(root.filesystemPath);
    throwIfSnapshotAborted(signal);
    if (current !== null) {
      throw new Error('Snapshot source changed while archiving.');
    }
  }
  for (const directory of plan.directories) {
    throwIfSnapshotAborted(signal);
    const current = await lstat(directory.filesystemPath);
    throwIfSnapshotAborted(signal);
    if (
      !current.isDirectory()
      || current.dev !== directory.device
      || current.ino !== directory.inode
      || current.mtimeMs !== directory.modifiedAtMs
      || current.ctimeMs !== directory.changedAtMs
      || current.mode !== directory.mode
    ) {
      throw new Error('Snapshot source changed while archiving.');
    }
  }
  for (const file of plan.files) {
    throwIfSnapshotAborted(signal);
    const current = await lstat(file.filesystemPath);
    throwIfSnapshotAborted(signal);
    if (
      !current.isFile()
      || current.dev !== file.device
      || current.ino !== file.inode
      || current.size !== file.sizeBytes
      || current.mtimeMs !== file.modifiedAtMs
      || current.ctimeMs !== file.changedAtMs
      || current.mode !== file.mode
    ) {
      throw new Error('Snapshot source changed while archiving.');
    }
  }
}

async function hashSnapshotFile(file: Omit<PlannedFile, 'sha256'>, signal?: AbortSignal): Promise<string> {
  throwIfSnapshotAborted(signal);
  const handle = await open(file.filesystemPath, 'r');
  try {
    const before = await handle.stat();
    if (!matchesPlannedFile(before, file)) {
      throw new Error('Snapshot source changed while archiving.');
    }
    const hash = createHash('sha256');
    const readBuffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    for (;;) {
      throwIfSnapshotAborted(signal);
      const { bytesRead } = await handle.read(
        readBuffer,
        0,
        readBuffer.byteLength,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(readBuffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    throwIfSnapshotAborted(signal);
    const after = await handle.stat();
    if (!matchesPlannedFile(after, file)) {
      throw new Error('Snapshot source changed while archiving.');
    }
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function matchesPlannedFile(
  current: Stats,
  file: Omit<PlannedFile, 'sha256'>,
): boolean {
  return current.isFile()
    && current.dev === file.device
    && current.ino === file.inode
    && current.size === file.sizeBytes
    && current.mtimeMs === file.modifiedAtMs
    && current.ctimeMs === file.changedAtMs
    && current.mode === file.mode;
}

function createHashVerifyingStream(expectedSha256: string): Transform {
  const hash = createHash('sha256');
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (hash.digest('hex') !== expectedSha256) {
        callback(new Error('Snapshot source changed while archiving.'));
        return;
      }
      callback();
    },
  });
}

function throwIfSnapshotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw snapshotAbortError(signal);
}

function snapshotAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Snapshot creation was canceled.');
  error.name = 'AbortError';
  return error;
}

function archiveDirectoryPath(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
