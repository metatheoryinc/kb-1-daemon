import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';

import { afterEach, describe, expect, it } from 'vitest';
import { fromBufferPromise } from 'yauzl';
import { ZipFile } from 'yazl';

import { startDaemon } from './main.js';
import { DAEMON_INITIALIZED_FILENAME } from './config.js';
import {
  SNAPSHOT_COMPLETION_PATH,
  SNAPSHOT_MANIFEST_PATH,
  createSnapshotArchive,
  type SnapshotArchiveManifest,
} from './snapshot-archive.js';
import { restoreSnapshotArchive } from './snapshot-restore.js';
import { isPortableSnapshotSegment } from './snapshot-paths.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('daemon snapshot archive', () => {
  it('round-trips active and trashed vault bytes into a disposable daemon runtime', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-source-');
    const restoredHome = join(await temporaryDirectory('kb1-snapshot-restored-'), 'home');
    await mkdir(join(sourceHome, 'vaults', 'field-notes', '.kb1'), { recursive: true });
    await mkdir(join(sourceHome, '.trash', 'old-vault'), { recursive: true });
    await writeFile(
      join(sourceHome, 'vaults', 'field-notes', '.kb1', 'vault.json'),
      '{"id":"field-notes","displayName":"Field Notes"}\n',
    );
    await writeFile(join(sourceHome, 'vaults', 'field-notes', 'note.md'), 'recover me\n');
    await writeFile(join(sourceHome, '.trash', 'old-vault', 'deleted.md'), 'still recoverable\n');

    const archive = await createSnapshotArchive({
      roots: [
        { archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') },
        { archivePath: '.trash', filesystemPath: join(sourceHome, '.trash') },
      ],
      createdAt: new Date('2026-09-03T08:00:00.000Z'),
      durableAsOf: new Date('2026-09-03T08:00:01.000Z'),
    });
    const archiveBytes = await buffer(archive.stream);
    const entries = await readZipEntries(archiveBytes);

    expect(entries.get('vaults/field-notes/note.md')?.toString('utf8')).toBe('recover me\n');
    expect(entries.get('.trash/old-vault/deleted.md')?.toString('utf8')).toBe('still recoverable\n');
    const manifest = JSON.parse(
      entries.get(SNAPSHOT_MANIFEST_PATH)?.toString('utf8') ?? '',
    ) as SnapshotArchiveManifest;
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      createdAt: '2026-09-03T08:00:00.000Z',
      durableAsOf: '2026-09-03T08:00:01.000Z',
      totals: { files: 3 },
    });
    expect(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
    expect(entries.get(SNAPSHOT_COMPLETION_PATH)?.toString('utf8')).toBe(
      '2026-09-03T08:00:00.000Z\n'
    );

    await restoreBytes(archiveBytes, restoredHome);
    const port = await reservePort();
    const restored = await startDaemon({
      env: {
        KB1_HOME: restoredHome,
        KB1_HOST: '127.0.0.1',
        KB1_PORT: String(port),
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/vaults/field-notes/files/note.md`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        content: 'recover me\n',
      });
    } finally {
      await restored.close();
    }
  });

  it('fails closed when a snapshot root contains a symbolic link', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-symlink-');
    await mkdir(join(sourceHome, 'vaults', 'demo'), { recursive: true });
    await symlink('/tmp', join(sourceHome, 'vaults', 'demo', 'outside'));

    await expect(createSnapshotArchive({
      roots: [{ archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') }],
      createdAt: new Date(),
      durableAsOf: new Date(),
    })).rejects.toThrow('unsupported symbolic link');
  });

  it('excludes daemon-local state and the Git implementation directory', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-portable-');
    const vaultRoot = join(sourceHome, 'vaults', 'demo');
    await mkdir(join(vaultRoot, '.kb1', 'secrets'), { recursive: true });
    await mkdir(join(vaultRoot, '.kb1', 'cache'), { recursive: true });
    await mkdir(join(vaultRoot, '.git', 'objects', 'aa'), { recursive: true });
    await mkdir(join(vaultRoot, '.git', 'refs', 'heads'), { recursive: true });
    await mkdir(join(vaultRoot, '.KB1', 'Secrets'), { recursive: true });
    await mkdir(join(vaultRoot, '.GIT'), { recursive: true });
    await writeFile(join(vaultRoot, '.kb1', 'vault.json'), '{"id":"demo","displayName":"Demo"}\n');
    await writeFile(join(vaultRoot, '.kb1', 'secrets', 'token'), 'do-not-export');
    await writeFile(join(vaultRoot, '.kb1', 'cache', 'index'), 'rebuildable');
    await writeFile(join(vaultRoot, '.git', 'config'), '[remote "origin"]\nurl = secret\n');
    await writeFile(join(vaultRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(vaultRoot, '.git', 'refs', 'heads', 'main'), 'abc123\n');
    await writeFile(join(vaultRoot, '.git', 'objects', 'aa', 'object'), 'history');
    await writeFile(join(vaultRoot, '.KB1', 'Secrets', 'case-token'), 'do-not-export');
    await writeFile(join(vaultRoot, '.GIT', 'config'), 'case-variant secret');

    const archive = await createSnapshotArchive({
      roots: [{ archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') }],
      createdAt: new Date(),
      durableAsOf: new Date(),
    });
    const entries = await readZipEntries(await buffer(archive.stream));

    expect(entries.get('vaults/demo/.kb1/vault.json')?.toString('utf8')).toBe(
      '{"id":"demo","displayName":"Demo"}\n'
    );
    expect(entries.has('vaults/demo/.kb1/secrets/token')).toBe(false);
    expect(entries.has('vaults/demo/.kb1/cache/index')).toBe(false);
    expect(entries.has('vaults/demo/.git/config')).toBe(false);
    expect(entries.has('vaults/demo/.KB1/Secrets/case-token')).toBe(false);
    expect(entries.has('vaults/demo/.GIT/config')).toBe(false);
    expect([...entries.keys()].some((path) => path.startsWith('vaults/demo/.git/'))).toBe(false);
  });

  it('cancels planning and lazy archive work through an AbortSignal', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-cancel-');
    const vaultRoot = join(sourceHome, 'vaults', 'demo');
    await mkdir(vaultRoot, { recursive: true });
    await writeFile(join(vaultRoot, 'note.md'), 'cancel me\n');

    const planningController = new AbortController();
    planningController.abort();
    await expect(createSnapshotArchive({
      roots: [{ archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') }],
      createdAt: new Date(),
      durableAsOf: new Date(),
      signal: planningController.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    const streamingController = new AbortController();
    const archive = await createSnapshotArchive({
      roots: [{ archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') }],
      createdAt: new Date(),
      durableAsOf: new Date(),
      signal: streamingController.signal,
    });
    streamingController.abort();
    await expect(buffer(archive.stream)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('contains an abort before the caller attaches a stream consumer', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-early-abort-');
    const vaultRoot = join(sourceHome, 'vaults', 'demo');
    await mkdir(vaultRoot, { recursive: true });
    await writeFile(join(vaultRoot, 'note.md'), 'cancel before consume\n');
    const controller = new AbortController();

    const archive = await createSnapshotArchive({
      roots: [{ archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') }],
      createdAt: new Date(),
      durableAsOf: new Date(),
      signal: controller.signal,
    });
    controller.abort();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

    expect(archive.stream.destroyed).toBe(true);
  });

  it('round-trips an intentionally empty initialized daemon without reseeding', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-empty-source-');
    const restoredHome = join(await temporaryDirectory('kb1-snapshot-empty-restored-'), 'home');
    await mkdir(join(sourceHome, 'vaults'), { recursive: true });
    await mkdir(join(sourceHome, '.trash'), { recursive: true });
    await writeFile(join(sourceHome, 'vaults', DAEMON_INITIALIZED_FILENAME), '1\n');

    const archive = await createSnapshotArchive({
      roots: [
        { archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') },
        { archivePath: '.trash', filesystemPath: join(sourceHome, '.trash') },
      ],
      createdAt: new Date(),
      durableAsOf: new Date(),
    });
    await restoreBytes(await buffer(archive.stream), restoredHome);

    const port = await reservePort();
    const restored = await startDaemon({
      env: {
        KB1_HOME: restoredHome,
        KB1_HOST: '127.0.0.1',
        KB1_PORT: String(port),
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/vaults`);
      await expect(response.json()).resolves.toEqual({ ok: true, vaults: [] });
    } finally {
      await restored.close();
    }
  });

  it('fails closed for file names that ZIP tools would reinterpret as paths', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-backslash-');
    const vaultRoot = join(sourceHome, 'vaults', 'demo');
    await mkdir(vaultRoot, { recursive: true });
    await writeFile(join(vaultRoot, 'one\\two.md'), 'ambiguous\n');

    await expect(createSnapshotArchive({
      roots: [{ archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') }],
      createdAt: new Date(),
      durableAsOf: new Date(),
    })).rejects.toThrow('Unsafe snapshot path');
  });

  it.skipIf(process.platform === 'win32')('round-trips valid names through portable archive paths without changing source names or bytes', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-reserved-');
    const vaultRoot = join(sourceHome, 'vaults', 'demo');
    await mkdir(vaultRoot, { recursive: true });
    const names = ['Meeting: launch.md', 'con.md', 'feedback /bug reports.md', '~kb1-literal.md'];
    for (const name of names) {
      const segments = name.split('/');
      await mkdir(join(vaultRoot, ...segments.slice(0, -1)), { recursive: true });
      await writeFile(join(vaultRoot, name), `original ${name}\n`);
    }
    await mkdir(join(vaultRoot, 'empty: folder'), { recursive: true });

    const archive = await createSnapshotArchive({
      roots: [{ archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') }],
      createdAt: new Date(),
      durableAsOf: new Date(),
    });
    const bytes = await buffer(archive.stream);
    const entries = await readZipEntries(bytes);
    expect(archive.manifest.files).toHaveLength(names.length);
    for (const file of archive.manifest.files) {
      expect(file.path.split('/').every(isPortableSnapshotSegment)).toBe(true);
      expect(file.originalPath).toBeDefined();
      expect(entries.get(file.path)?.toString('utf8')).toBe(`original ${file.originalPath!.slice('vaults/demo/'.length)}\n`);
    }
    const restoredHome = join(await temporaryDirectory('kb1-snapshot-names-'), 'home');
    await restoreBytes(bytes, restoredHome);
    for (const name of names) {
      expect(await readFile(join(restoredHome, 'vaults/demo', name), 'utf8')).toBe(await readFile(join(vaultRoot, name), 'utf8'));
    }
    expect((await stat(join(restoredHome, 'vaults/demo/empty: folder'))).isDirectory()).toBe(true);
  });

  it('preserves colliding names in the ZIP and restores only on a compatible filesystem', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-collision-');
    const firstRoot = join(sourceHome, 'first');
    const secondRoot = join(sourceHome, 'second');
    await mkdir(firstRoot, { recursive: true });
    await mkdir(secondRoot, { recursive: true });
    await writeFile(join(firstRoot, 'note.md'), 'first\n');
    await writeFile(join(secondRoot, 'note.md'), 'second\n');

    const archive = await createSnapshotArchive({
      roots: [
        { archivePath: 'vaults/Demo', filesystemPath: firstRoot },
        { archivePath: 'vaults/demo', filesystemPath: secondRoot },
      ],
      createdAt: new Date(),
      durableAsOf: new Date(),
    });
    const bytes = await buffer(archive.stream);
    const entries = await readZipEntries(bytes);
    expect(new Set(archive.manifest.files.map((file) => file.path.toLowerCase())).size).toBe(2);
    expect(archive.manifest.files.map((file) => file.originalPath).sort()).toEqual(['vaults/Demo/note.md', 'vaults/demo/note.md']);
    expect(archive.manifest.files.map((file) => entries.get(file.path)?.toString('utf8')).sort()).toEqual(['first\n', 'second\n']);
    const restoredHome = join(await temporaryDirectory('kb1-snapshot-case-'), 'home');
    if (await supportsDistinctCase(sourceHome)) {
      await restoreBytes(bytes, restoredHome);
      expect(await readFile(join(restoredHome, 'vaults/Demo/note.md'), 'utf8')).toBe('first\n');
      expect(await readFile(join(restoredHome, 'vaults/demo/note.md'), 'utf8')).toBe('second\n');
    } else {
      await expect(restoreBytes(bytes, restoredHome)).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(stat(restoredHome)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('restores v1 archives and refuses to merge into an existing home', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-v1-');
    await writeFile(join(sourceHome, 'note.md'), 'legacy archive\n');
    const archive = await createSnapshotArchive({
      roots: [{ archivePath: 'vaults/demo', filesystemPath: sourceHome }],
      createdAt: new Date(), durableAsOf: new Date(),
    });
    const entries = await readZipEntries(await buffer(archive.stream));
    const { directories: _directories, ...manifest } = archive.manifest;
    entries.set(SNAPSHOT_MANIFEST_PATH, Buffer.from(JSON.stringify({ ...manifest, schemaVersion: 1 })));
    const bytes = await zipEntries(entries);
    const restoredHome = join(await temporaryDirectory('kb1-restore-v1-'), 'home');
    await restoreBytes(bytes, restoredHome);
    expect(await readFile(join(restoredHome, 'vaults/demo/note.md'), 'utf8')).toBe('legacy archive\n');
    await expect(restoreBytes(bytes, restoredHome)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(restoredHome, 'vaults/demo/note.md'), 'utf8')).toBe('legacy archive\n');
  });

  it.each(['traversal', 'changed bytes', 'missing completion', 'symbolic link'] as const)(
    'refuses a damaged or unsafe restore (%s) and removes only its partial target', async (damage) => {
      const sourceHome = await temporaryDirectory('kb1-snapshot-unsafe-');
      await writeFile(join(sourceHome, 'note.md'), 'original bytes\n');
      const archive = await createSnapshotArchive({
        roots: [{ archivePath: 'vaults/demo', filesystemPath: sourceHome }],
        createdAt: new Date(), durableAsOf: new Date(),
      });
      const entries = await readZipEntries(await buffer(archive.stream));
      if (damage === 'traversal') {
        archive.manifest.files[0]!.originalPath = 'vaults/../../outside.md';
        entries.set(SNAPSHOT_MANIFEST_PATH, Buffer.from(JSON.stringify(archive.manifest)));
      }
      if (damage === 'changed bytes') entries.set('vaults/demo/note.md', Buffer.from('modified bytes\n'));
      if (damage === 'missing completion') entries.delete(SNAPSHOT_COMPLETION_PATH);
      const parent = await temporaryDirectory('kb1-restore-unsafe-');
      const target = join(parent, 'new-home');
      await writeFile(join(parent, 'sentinel.md'), 'keep me');
      await expect(restoreBytes(await zipEntries(entries, damage === 'symbolic link'), target)).rejects.toThrow();
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(parent, 'sentinel.md'), 'utf8')).toBe('keep me');
    },
  );

  it('keeps the captured bytes and tree when source content, permissions, and roots change during delivery', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-changing-');
    const vaultRoot = join(sourceHome, 'vaults', 'demo');
    const file = join(vaultRoot, 'before.md');
    const trashRoot = join(sourceHome, '.trash');
    await mkdir(vaultRoot, { recursive: true });
    await writeFile(file, 'before\n');
    await chmod(file, 0o600);
    const original = await stat(file);
    const archive = await createSnapshotArchive({
      roots: [
        { archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') },
        { archivePath: '.trash', filesystemPath: trashRoot },
      ],
      createdAt: new Date(),
      durableAsOf: new Date(),
    });
    await writeFile(file, 'after!\n');
    await utimes(file, original.atime, original.mtime);
    await chmod(file, 0o700);
    await writeFile(join(vaultRoot, 'after.md'), 'not captured\n');
    await mkdir(trashRoot);
    await writeFile(join(trashRoot, 'deleted.md'), 'after capture\n');

    const entries = await readZipEntries(await buffer(archive.stream));
    expect(entries.get('vaults/demo/before.md')?.toString('utf8')).toBe('before\n');
    expect(archive.manifest.files[0]?.mode).toBe(original.mode);
    expect(entries.has('vaults/demo/after.md')).toBe(false);
    expect(entries.has('.trash/deleted.md')).toBe(false);
    expect(entries.has(SNAPSHOT_COMPLETION_PATH)).toBe(true);
  });

});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
}

async function readZipEntries(archive: Buffer): Promise<Map<string, Buffer>> {
  const zip = await fromBufferPromise(archive, { lazyEntries: true });
  const entries = new Map<string, Buffer>();
  for await (const entry of zip.eachEntry()) {
    if (entry.fileName.endsWith('/')) {
      entries.set(entry.fileName, Buffer.alloc(0));
      continue;
    }
    const stream = await zip.openReadStreamPromise(entry);
    entries.set(entry.fileName, await buffer(stream));
  }
  zip.close();
  return entries;
}

async function restoreBytes(bytes: Buffer, targetHome: string): Promise<void> {
  const path = join(await temporaryDirectory('kb1-restore-input-'), 'snapshot.zip');
  await writeFile(path, bytes);
  await restoreSnapshotArchive({ archivePath: path, targetHome });
}

async function zipEntries(entries: Map<string, Buffer>, link = false): Promise<Buffer> {
  const zip = new ZipFile();
  for (const [path, bytes] of entries) {
    if (path.endsWith('/')) zip.addEmptyDirectory(path);
    else zip.addBuffer(bytes, path, { mode: link && path === 'vaults/demo/note.md' ? 0o120777 : 0o100600 });
  }
  zip.end();
  return buffer(zip.outputStream);
}

async function supportsDistinctCase(parent: string): Promise<boolean> {
  await writeFile(join(parent, 'case-probe'), 'a', { flag: 'wx' });
  try {
    await writeFile(join(parent, 'CASE-PROBE'), 'b', { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve test port.');
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return port;
}
