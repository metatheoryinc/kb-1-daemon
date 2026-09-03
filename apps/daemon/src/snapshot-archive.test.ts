import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buffer } from 'node:stream/consumers';

import { afterEach, describe, expect, it } from 'vitest';
import { fromBufferPromise } from 'yauzl';

import { startDaemon } from './main.js';
import { DAEMON_INITIALIZED_FILENAME } from './config.js';
import {
  SNAPSHOT_COMPLETION_PATH,
  SNAPSHOT_MANIFEST_PATH,
  createSnapshotArchive,
  type SnapshotArchiveManifest,
} from './snapshot-archive.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('daemon snapshot archive', () => {
  it('round-trips active and trashed vault bytes into a disposable daemon runtime', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-source-');
    const restoredHome = await temporaryDirectory('kb1-snapshot-restored-');
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
      schemaVersion: 1,
      createdAt: '2026-09-03T08:00:00.000Z',
      durableAsOf: '2026-09-03T08:00:01.000Z',
      totals: { files: 3 },
    });
    expect(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
    expect(entries.get(SNAPSHOT_COMPLETION_PATH)?.toString('utf8')).toBe(
      '2026-09-03T08:00:00.000Z\n'
    );

    await extractZip(entries, restoredHome);
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
    const restoredHome = await temporaryDirectory('kb1-snapshot-empty-restored-');
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
    await extractZip(await readZipEntries(await buffer(archive.stream)), restoredHome);

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
    })).rejects.toThrow('non-portable path segment');
  });

  it('fails closed for Windows-reserved path segments', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-reserved-');
    const vaultRoot = join(sourceHome, 'vaults', 'demo');
    await mkdir(vaultRoot, { recursive: true });
    await writeFile(join(vaultRoot, 'con.md'), 'not portable\n');

    await expect(createSnapshotArchive({
      roots: [{ archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') }],
      createdAt: new Date(),
      durableAsOf: new Date(),
    })).rejects.toThrow('non-portable path segment');
  });

  it('fails closed when target filesystems would collapse distinct archive paths', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-collision-');
    const firstRoot = join(sourceHome, 'first');
    const secondRoot = join(sourceHome, 'second');
    await mkdir(firstRoot, { recursive: true });
    await mkdir(secondRoot, { recursive: true });
    await writeFile(join(firstRoot, 'note.md'), 'first\n');
    await writeFile(join(secondRoot, 'note.md'), 'second\n');

    await expect(createSnapshotArchive({
      roots: [
        { archivePath: 'vaults/Demo', filesystemPath: firstRoot },
        { archivePath: 'vaults/demo', filesystemPath: secondRoot },
      ],
      createdAt: new Date(),
      durableAsOf: new Date(),
    })).rejects.toThrow('colliding portable paths');
  });

  it('fails the ZIP stream when the source tree changes after planning', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-changing-');
    const vaultRoot = join(sourceHome, 'vaults', 'demo');
    await mkdir(vaultRoot, { recursive: true });
    await writeFile(join(vaultRoot, 'before.md'), 'planned\n');

    const archive = await createSnapshotArchive({
      roots: [{ archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') }],
      createdAt: new Date(),
      durableAsOf: new Date(),
    });
    await writeFile(join(vaultRoot, 'after.md'), 'not planned\n');

    await expect(buffer(archive.stream)).rejects.toThrow(
      'Snapshot source changed while archiving'
    );
  });

  it('fails the ZIP stream when an initially absent root appears after planning', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-new-root-');
    const trashRoot = join(sourceHome, '.trash');
    const archive = await createSnapshotArchive({
      roots: [{ archivePath: '.trash', filesystemPath: trashRoot }],
      createdAt: new Date(),
      durableAsOf: new Date(),
    });
    await mkdir(join(trashRoot, 'deleted-vault'), { recursive: true });
    await writeFile(join(trashRoot, 'deleted-vault', 'note.md'), 'appeared\n');

    await expect(buffer(archive.stream)).rejects.toThrow(
      'Snapshot source changed while archiving'
    );
  });

  it('fails the ZIP stream when source permissions change after planning', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-mode-changing-');
    const vaultRoot = join(sourceHome, 'vaults', 'demo');
    const file = join(vaultRoot, 'script.sh');
    await mkdir(vaultRoot, { recursive: true });
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o600);

    const archive = await createSnapshotArchive({
      roots: [{ archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') }],
      createdAt: new Date(),
      durableAsOf: new Date(),
    });
    await chmod(file, 0o700);

    await expect(buffer(archive.stream)).rejects.toThrow(
      'Snapshot source changed while archiving'
    );
  });

  it('fails the ZIP stream after a same-size rewrite with restored mtime', async () => {
    const sourceHome = await temporaryDirectory('kb1-snapshot-content-changing-');
    const vaultRoot = join(sourceHome, 'vaults', 'demo');
    const file = join(vaultRoot, 'note.md');
    await mkdir(vaultRoot, { recursive: true });
    await writeFile(file, 'before\n');
    const original = await stat(file);

    const archive = await createSnapshotArchive({
      roots: [{ archivePath: 'vaults', filesystemPath: join(sourceHome, 'vaults') }],
      createdAt: new Date(),
      durableAsOf: new Date(),
    });
    await writeFile(file, 'after!\n');
    await utimes(file, original.atime, original.mtime);

    await expect(buffer(archive.stream)).rejects.toThrow(
      'Snapshot source changed while archiving'
    );
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
    if (entry.fileName.endsWith('/')) continue;
    const stream = await zip.openReadStreamPromise(entry);
    entries.set(entry.fileName, await buffer(stream));
  }
  zip.close();
  return entries;
}

async function extractZip(entries: Map<string, Buffer>, targetRoot: string): Promise<void> {
  const canonicalRoot = `${resolve(targetRoot)}/`;
  for (const [entryPath, bytes] of entries) {
    if (entryPath === SNAPSHOT_MANIFEST_PATH) continue;
    const target = resolve(targetRoot, entryPath);
    if (!target.startsWith(canonicalRoot)) {
      throw new Error(`Archive entry escaped restore root: ${entryPath}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
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
