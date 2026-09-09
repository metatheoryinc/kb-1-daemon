import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rm, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';

import { openPromise, type Entry, type ZipFile } from 'yauzl';
import { z } from 'zod';

import {
  SNAPSHOT_COMPLETION_PATH,
  SNAPSHOT_MANIFEST_PATH,
  SNAPSHOT_RESTORE_HELP_PATH,
} from './snapshot-archive.js';
import { assertSafeSnapshotPath, isPortableSnapshotSegment } from './snapshot-paths.js';

const pathMetadata = z.object({
  path: z.string(),
  originalPath: z.string().optional(),
  modifiedAt: z.iso.datetime(),
  mode: z.number().int().nonnegative(),
});
const manifestBase = z.object({
  createdAt: z.iso.datetime(),
  durableAsOf: z.iso.datetime(),
  files: z.array(pathMetadata.extend({
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })),
  totals: z.object({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
});
const manifestSchema = z.discriminatedUnion('schemaVersion', [
  manifestBase.extend({ schemaVersion: z.literal(1) }),
  manifestBase.extend({ schemaVersion: z.literal(2), directories: z.array(pathMetadata) }),
]);

/** Restore into a new home only. Existing homes are never merged or replaced. */
export async function restoreSnapshotArchive(input: {
  archivePath: string;
  targetHome: string;
}): Promise<{ files: number; bytes: number; targetHome: string }> {
  const targetHome = resolve(input.targetHome);
  const zip = await openPromise(input.archivePath, {
    lazyEntries: true,
    autoClose: false,
    strictFileNames: true,
  });
  let ownsTarget = false;
  try {
    const entries = new Map<string, Entry>();
    for await (const entry of zip.eachEntry()) {
      const path = entry.fileName.replace(/\/$/, '');
      assertSafeSnapshotPath(path);
      if (entries.has(entry.fileName)) throw new Error(`Duplicate ZIP entry: ${path}`);
      const type = (entry.externalFileAttributes >>> 16) & 0xf000;
      const expectedType = entry.fileName.endsWith('/') ? 0x4000 : 0x8000;
      if (type !== 0 && type !== expectedType) throw new Error('Snapshot contains a link or special file.');
      entries.set(entry.fileName, entry);
    }
    const manifest = manifestSchema.parse(JSON.parse(
      await readSmallEntry(zip, entries, SNAPSHOT_MANIFEST_PATH, 64 * 1024 * 1024),
    ));
    const completion = await readSmallEntry(zip, entries, SNAPSHOT_COMPLETION_PATH, 128);
    if (completion !== `${manifest.createdAt}\n`) throw new Error('Snapshot completion marker does not match.');
    if (manifest.totals.files !== manifest.files.length
      || manifest.totals.bytes !== manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0)) {
      throw new Error('Snapshot totals do not match its manifest.');
    }

    const directories = manifest.schemaVersion === 2
      ? manifest.directories
      : [...entries.values()].filter((entry) => entry.fileName.endsWith('/')).map((entry) => ({
        path: entry.fileName.slice(0, -1),
        originalPath: undefined,
        modifiedAt: entry.getLastModDate().toISOString(),
        mode: (entry.externalFileAttributes >>> 16) || 0o700,
      }));
    const expectedEntries = new Set([SNAPSHOT_MANIFEST_PATH, SNAPSHOT_COMPLETION_PATH, SNAPSHOT_RESTORE_HELP_PATH]);
    const restorePaths = new Set<string>();
    for (const [items, isDirectory] of [[directories, true], [manifest.files, false]] as const) {
      for (const item of items) {
        assertSafeSnapshotPath(item.path);
        const path = item.originalPath ?? item.path;
        assertRestorePath(path);
        if (restorePaths.has(path)) throw new Error(`Duplicate restore path: ${path}`);
        restorePaths.add(path);
        const entryPath = isDirectory ? `${item.path}/` : item.path;
        if (expectedEntries.has(entryPath)) throw new Error(`Duplicate manifest path: ${entryPath}`);
        const entry = entries.get(entryPath);
        if (!entry) throw new Error(`Snapshot is missing ${entryPath}`);
        if (!isDirectory && entry.uncompressedSize !== (item as { sizeBytes: number }).sizeBytes) {
          throw new Error(`Snapshot size does not match its manifest: ${entryPath}`);
        }
        expectedEntries.add(entryPath);
      }
    }
    for (const path of entries.keys()) {
      if (!expectedEntries.has(path)) throw new Error(`Snapshot contains an unlisted entry: ${path}`);
    }

    // Include implied parents for v1 ZIPs whose root is a nested directory.
    const directoryPaths = new Set<string>();
    for (const item of directories) addParents(directoryPaths, `${item.originalPath ?? item.path}/child`);
    for (const item of manifest.files) addParents(directoryPaths, item.originalPath ?? item.path);
    for (const file of manifest.files) {
      if (directoryPaths.has(file.originalPath ?? file.path)) throw new Error('Snapshot file conflicts with a directory.');
    }

    await mkdir(targetHome, { mode: 0o700 });
    ownsTarget = true;
    // Each explicit directory is created once, without recursive merging.
    // EEXIST catches case/Unicode aliases on the actual destination filesystem.
    for (const path of [...directoryPaths].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
      await mkdir(join(targetHome, path), { mode: 0o700 });
    }
    for (const file of manifest.files) {
      const target = join(targetHome, file.originalPath ?? file.path);
      const hash = createHash('sha256');
      let bytes = 0;
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        await zip.openReadStreamPromise(entries.get(file.path)!),
        verify,
        createWriteStream(target, { flags: 'wx', mode: 0o600 }),
      );
      if (bytes !== file.sizeBytes || hash.digest('hex') !== file.sha256) {
        throw new Error(`Snapshot hash verification failed: ${file.path}`);
      }
      await chmod(target, file.mode & 0o777);
      await utimes(target, new Date(file.modifiedAt), new Date(file.modifiedAt));
    }
    for (const directory of [...directories].sort((a, b) => b.path.split('/').length - a.path.split('/').length)) {
      const target = join(targetHome, directory.originalPath ?? directory.path);
      await chmod(target, directory.mode & 0o777);
      await utimes(target, new Date(directory.modifiedAt), new Date(directory.modifiedAt));
    }
    return { ...manifest.totals, targetHome };
  } catch (error) {
    if (ownsTarget) await rm(targetHome, { recursive: true, force: true });
    throw error;
  } finally {
    zip.close();
  }
}

function assertRestorePath(path: string): void {
  assertSafeSnapshotPath(path);
  const segments = path.split('/');
  if (segments[0] !== 'vaults' && segments[0] !== '.trash') {
    throw new Error(`Snapshot path is outside the vault and trash roots: ${path}`);
  }
  if (process.platform === 'win32' && segments.some((segment) => !isPortableSnapshotSegment(segment))) {
    throw new Error('Original snapshot names require a compatible filesystem, such as Linux.');
  }
}

function addParents(paths: Set<string>, path: string): void {
  const segments = path.split('/');
  for (let length = 1; length < segments.length; length += 1) paths.add(segments.slice(0, length).join('/'));
}

async function readSmallEntry(zip: ZipFile, entries: Map<string, Entry>, path: string, limit: number): Promise<string> {
  const entry = entries.get(path);
  if (!entry || entry.uncompressedSize > limit) throw new Error(`Snapshot has a missing or oversized ${path}`);
  return (await buffer(await zip.openReadStreamPromise(entry))).toString('utf8');
}
