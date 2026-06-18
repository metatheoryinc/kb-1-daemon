import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

import { DOCUMENT_SESSION_FAILURE_CLOSE_CODE } from '@kb-2/doc-session';
import { startDaemon } from './main.js';

describe('daemon startup', () => {
  let kb2Home: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    kb2Home = await mkdtemp(join(tmpdir(), 'kb2-startup-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(kb2Home, { force: true, recursive: true });
  });

  it('does not write status when the HTTP server fails to bind', async () => {
    const blocker = createServer();
    await listen(blocker);
    const port = (blocker.address() as AddressInfo).port;

    process.env = {
      ...originalEnv,
      KB2_HOME: kb2Home,
      KB2_HOST: '127.0.0.1',
      KB2_PORT: String(port)
    };

    await expect(startDaemon()).rejects.toBeTruthy();
    await expect(access(join(kb2Home, 'daemon', 'status.json'))).rejects.toBeTruthy();

    await close(blocker);
  });

  it('creates and serves the demo document on startup', async () => {
    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB2_HOME: kb2Home,
      KB2_HOST: '127.0.0.1',
      KB2_PORT: String(port)
    };

    const started = await startDaemon();
    const response = await fetch(`http://127.0.0.1:${port}/api/demo-document`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      document: 'demo-vault/hello-world.md'
    });
    expect(typeof body.content).toBe('string');
    expect(body.content).toContain('Hello KB-2');
    await expect(readFile(join(started.config.vaultRoot, 'hello-world.md'), 'utf8')).resolves.toBe(body.content);

    await started.close();
  });

  it('seeds the demo document only for a first boot of an empty vault', async () => {
    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB2_HOME: kb2Home,
      KB2_HOST: '127.0.0.1',
      KB2_PORT: String(port)
    };

    const firstBoot = await startDaemon();
    await expect(readFile(join(firstBoot.config.vaultRoot, 'hello-world.md'), 'utf8')).resolves.toContain('Hello KB-2');

    const deleted = await fetch(`http://127.0.0.1:${port}/api/files/hello-world.md`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    await expect(access(join(firstBoot.config.vaultRoot, 'hello-world.md'))).rejects.toBeTruthy();
    await firstBoot.close();

    const restartedAfterDelete = await startDaemon();
    await expect(access(join(restartedAfterDelete.config.vaultRoot, 'hello-world.md'))).rejects.toBeTruthy();
    await restartedAfterDelete.close();

    const populatedHome = await mkdtemp(join(tmpdir(), 'kb2-populated-startup-'));
    process.env = {
      ...originalEnv,
      KB2_HOME: populatedHome,
      KB2_HOST: '127.0.0.1',
      KB2_PORT: String(port)
    };
    const populatedVault = join(populatedHome, 'demo-vault');
    await mkdir(join(populatedVault, 'notes'), { recursive: true });
    await writeFile(join(populatedVault, 'notes', 'preexisting.md'), 'already here\n', 'utf8');

    const populatedBoot = await startDaemon();
    await expect(access(join(populatedBoot.config.vaultRoot, 'hello-world.md'))).rejects.toBeTruthy();
    await expect(readFile(join(populatedBoot.config.vaultRoot, 'notes', 'preexisting.md'), 'utf8')).resolves.toBe('already here\n');
    await populatedBoot.close();
    await rm(populatedHome, { force: true, recursive: true });
  });

  it('rejects missing document WebSocket opens without creating typo folders', async () => {
    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB2_HOME: kb2Home,
      KB2_HOST: '127.0.0.1',
      KB2_PORT: String(port)
    };

    const started = await startDaemon();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/files/typo/missing.md/yjs`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    await expect(closed).resolves.toEqual({
      code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
      reason: JSON.stringify({ ok: false, error: 'not_found', message: 'file not found' })
    });
    await expect(access(join(started.config.vaultRoot, 'typo'))).rejects.toBeTruthy();
    await expect(readFile(join(started.config.vaultRoot, 'hello-world.md'), 'utf8')).resolves.toContain('Hello KB-2');

    await started.close();
  });

  it('allows an immediate create after a missing document WebSocket bind fails', async () => {
    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB2_HOME: kb2Home,
      KB2_HOST: '127.0.0.1',
      KB2_PORT: String(port)
    };

    const started = await startDaemon();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/files/typo/missing.md/yjs`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    await expect(closed).resolves.toEqual({
      code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
      reason: JSON.stringify({ ok: false, error: 'not_found', message: 'file not found' })
    });

    const created = await fetch(`http://127.0.0.1:${port}/api/files/typo/missing.md`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'created immediately\n'
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ ok: true, path: 'typo/missing.md' });
    await expect(readFile(join(started.config.vaultRoot, 'typo', 'missing.md'), 'utf8')).resolves.toBe('created immediately\n');

    await started.close();
  });
});

describe('daemon boot migration', () => {
  let kb2Home: string;
  let originalEnv: NodeJS.ProcessEnv;

  const SEEDED_NOTES: ReadonlyArray<{ readonly path: string; readonly content: string }> = [
    { path: 'welcome.md', content: '# Welcome\n\nThe first top-level note.\n' },
    { path: 'ideas.md', content: '# Ideas\n\nA second top-level note with distinctive text.\n' },
    { path: join('projects', 'roadmap.md'), content: '# Roadmap\n\nA nested note that must survive the move.\n' }
  ];

  beforeEach(async () => {
    originalEnv = { ...process.env };
    kb2Home = await mkdtemp(join(tmpdir(), 'kb2-migration-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(kb2Home, { force: true, recursive: true });
  });

  async function seedLegacyLayout(): Promise<void> {
    const legacyVault = join(kb2Home, 'demo-vault');
    for (const note of SEEDED_NOTES) {
      const absolute = join(legacyVault, note.path);
      await mkdir(join(absolute, '..'), { recursive: true });
      await writeFile(absolute, note.content, 'utf8');
    }
  }

  it('migrates a legacy single-vault layout into the registry layout on boot, preserving every note', async () => {
    await seedLegacyLayout();

    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB2_HOME: kb2Home,
      KB2_HOST: '127.0.0.1',
      KB2_PORT: String(port)
    };

    const started = await startDaemon();
    const vaultRoot = started.config.vaultRoot;

    // The migrated vault lives under <home>/vaults/<slug>/ and the legacy root is gone.
    expect(vaultRoot).toBe(join(kb2Home, 'vaults', 'demo-vault'));
    await expect(access(join(kb2Home, 'demo-vault'))).rejects.toBeTruthy();

    // Data-safety: every seeded note, including the nested one, survives byte-for-byte.
    for (const note of SEEDED_NOTES) {
      await expect(readFile(join(vaultRoot, note.path), 'utf8')).resolves.toBe(note.content);
    }

    // A durable vault identity was minted with a non-empty slug and display name.
    const identity = JSON.parse(await readFile(join(vaultRoot, '.kb2', 'vault.json'), 'utf8'));
    expect(typeof identity).toBe('object');
    expect(identity).not.toBeNull();
    expect(identity.id).toBe('demo-vault');
    expect(typeof identity.displayName).toBe('string');
    expect(identity.displayName.length).toBeGreaterThan(0);

    await started.close();
  });

  it('leaves the migrated tree and minted identity unchanged on a second boot (idempotent slug)', async () => {
    await seedLegacyLayout();

    const firstPort = await reservePort();
    process.env = {
      ...originalEnv,
      KB2_HOME: kb2Home,
      KB2_HOST: '127.0.0.1',
      KB2_PORT: String(firstPort)
    };

    const firstBoot = await startDaemon();
    const vaultRoot = firstBoot.config.vaultRoot;
    const identityFile = join(vaultRoot, '.kb2', 'vault.json');
    const identityAfterFirstBoot = await readFile(identityFile, 'utf8');
    const contentsAfterFirstBoot = await Promise.all(
      SEEDED_NOTES.map((note) => readFile(join(vaultRoot, note.path), 'utf8'))
    );
    await firstBoot.close();

    const secondPort = await reservePort();
    process.env = {
      ...originalEnv,
      KB2_HOME: kb2Home,
      KB2_HOST: '127.0.0.1',
      KB2_PORT: String(secondPort)
    };

    const secondBoot = await startDaemon();
    expect(secondBoot.config.vaultRoot).toBe(vaultRoot);

    // The legacy root is not recreated, and the identity is byte-for-byte identical
    // (the slug is read back, never recomputed).
    await expect(access(join(kb2Home, 'demo-vault'))).rejects.toBeTruthy();
    await expect(readFile(identityFile, 'utf8')).resolves.toBe(identityAfterFirstBoot);

    // Every note is still present with its original content unchanged.
    for (let index = 0; index < SEEDED_NOTES.length; index += 1) {
      await expect(readFile(join(vaultRoot, SEEDED_NOTES[index].path), 'utf8')).resolves.toBe(
        contentsAfterFirstBoot[index]
      );
    }

    await secondBoot.close();
  });
});

describe('daemon vault management API', () => {
  let kb2Home: string;
  let originalEnv: NodeJS.ProcessEnv;
  let port: number;
  let started: Awaited<ReturnType<typeof startDaemon>>;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    kb2Home = await mkdtemp(join(tmpdir(), 'kb2-vaults-api-'));
    port = await reservePort();
    process.env = {
      ...originalEnv,
      KB2_HOME: kb2Home,
      KB2_HOST: '127.0.0.1',
      KB2_PORT: String(port)
    };
    started = await startDaemon();
  });

  afterEach(async () => {
    await started.close();
    process.env = originalEnv;
    await rm(kb2Home, { force: true, recursive: true });
  });

  const base = () => `http://127.0.0.1:${port}`;

  async function listVaults(): Promise<Array<{ id: string; displayName: string }>> {
    const response = await fetch(`${base()}/api/vaults`);
    expect(response.status).toBe(200);
    const body = await response.json();
    return body.vaults;
  }

  it('drives the full create -> list -> rename -> delete lifecycle live, with no restart', async () => {
    // The default vault is present from boot.
    expect(await listVaults()).toContainEqual({ id: 'demo-vault', displayName: 'demo-vault' });

    // CREATE: caller supplies only a display name; the daemon owns the slug.
    const createResponse = await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Field Notes' })
    });
    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toEqual({
      ok: true,
      vault: { id: 'field-notes', displayName: 'Field Notes' }
    });

    // A real, valid empty vault landed on disk with minted identity.
    const identity = JSON.parse(
      await readFile(join(kb2Home, 'vaults', 'field-notes', '.kb2', 'vault.json'), 'utf8')
    );
    expect(identity).toEqual({ id: 'field-notes', displayName: 'Field Notes' });

    // LIST: it shows up immediately, no restart.
    expect(await listVaults()).toContainEqual({ id: 'field-notes', displayName: 'Field Notes' });

    // SERVE LIVE: the brand-new vault is reachable through its scoped routes.
    const liveTree = await fetch(`${base()}/api/vaults/field-notes/tree`);
    expect(liveTree.status).toBe(200);
    await expect(liveTree.json()).resolves.toMatchObject({ ok: true });

    // RENAME: display name only; slug and folder are stable.
    const renameResponse = await fetch(`${base()}/api/vaults/field-notes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Field Journal' })
    });
    expect(renameResponse.status).toBe(200);
    await expect(renameResponse.json()).resolves.toEqual({
      ok: true,
      vault: { id: 'field-notes', displayName: 'Field Journal' }
    });
    expect(await listVaults()).toContainEqual({ id: 'field-notes', displayName: 'Field Journal' });
    // The on-disk folder did not move; only identity changed.
    await expect(access(join(kb2Home, 'vaults', 'field-notes'))).resolves.toBeUndefined();
    const renamedIdentity = JSON.parse(
      await readFile(join(kb2Home, 'vaults', 'field-notes', '.kb2', 'vault.json'), 'utf8')
    );
    expect(renamedIdentity).toEqual({ id: 'field-notes', displayName: 'Field Journal' });

    // DELETE (soft): gone from the list, folder reversibly preserved in trash.
    const deleteResponse = await fetch(`${base()}/api/vaults/field-notes`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toMatchObject({ ok: true });
    expect((await listVaults()).some((v) => v.id === 'field-notes')).toBe(false);
    await expect(access(join(kb2Home, 'vaults', 'field-notes'))).rejects.toBeTruthy();
    // The data still exists under the home-level trash (never hard-deleted).
    const trashed = JSON.parse(
      await readFile(join(kb2Home, '.trash', 'field-notes', '.kb2', 'vault.json'), 'utf8')
    );
    expect(trashed).toEqual({ id: 'field-notes', displayName: 'Field Journal' });

    // Its scoped routes now resolve to a clean 404.
    const goneTree = await fetch(`${base()}/api/vaults/field-notes/tree`);
    expect(goneTree.status).toBe(404);
  });

  it('serves scoped data routes against the addressed vault, isolated from the default', async () => {
    await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Scoped' })
    });

    // Write a note into the scoped vault only.
    const put = await fetch(`${base()}/api/vaults/scoped/files/only-here.md`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'scoped content\n'
    });
    expect(put.status).toBe(201);
    await expect(put.json()).resolves.toMatchObject({ ok: true, path: 'only-here.md' });

    // It is on disk under the scoped vault's folder.
    await expect(
      readFile(join(kb2Home, 'vaults', 'scoped', 'only-here.md'), 'utf8')
    ).resolves.toBe('scoped content\n');

    // Readable back through the scoped route.
    const read = await fetch(`${base()}/api/vaults/scoped/files/only-here.md`);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ ok: true, content: 'scoped content\n' });

    // The default (flat) vault does not see the scoped vault's note.
    const flatRead = await fetch(`${base()}/api/files/only-here.md`);
    expect(flatRead.status).toBe(404);
  });

  it('returns a clean 404 for data routes addressing an unknown vault, without crashing', async () => {
    const tree = await fetch(`${base()}/api/vaults/does-not-exist/tree`);
    expect(tree.status).toBe(404);
    await expect(tree.json()).resolves.toMatchObject({ ok: false, error: 'not_found' });

    // The daemon is still healthy after the miss.
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);
  });

  it('rejects a slug collision over HTTP with a clean 409', async () => {
    const first = await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Dup' })
    });
    expect(first.status).toBe(201);

    const collision = await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'dup' })
    });
    expect(collision.status).toBe(409);
    await expect(collision.json()).resolves.toMatchObject({ ok: false, error: 'already_exists' });
  });

  it('edits a live document over the scoped Yjs WebSocket and persists to the scoped vault', async () => {
    await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'WS Vault' })
    });
    await fetch(`${base()}/api/vaults/ws-vault/files/doc.md`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'seed\n'
    });

    // A scoped Yjs socket opens against the addressed vault's document manager.
    // The daemon's own shutdown (in afterEach) drains and closes it in order, so
    // the document-session state is flushed before the throwaway home is removed.
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/vaults/ws-vault/files/doc.md/yjs`);
    const opened = new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once('open', () => resolveOpen());
      socket.once('error', rejectOpen);
    });
    await opened;

    // An unknown-vault scoped socket is refused: the upgrade is destroyed, so the
    // client sees an error/close rather than an open.
    const badSocket = new WebSocket(`ws://127.0.0.1:${port}/api/vaults/missing-vault/files/doc.md/yjs`);
    const badResult = await new Promise<'opened' | 'refused'>((resolveBad) => {
      badSocket.once('open', () => resolveBad('opened'));
      badSocket.once('error', () => resolveBad('refused'));
      badSocket.once('close', () => resolveBad('refused'));
    });
    expect(badResult).toBe('refused');
  });
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  await close(server);
  return port;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
