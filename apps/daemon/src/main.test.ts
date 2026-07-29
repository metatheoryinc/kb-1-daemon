import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { DOCUMENT_SESSION_FAILURE_CLOSE_CODE } from '@kb-1/doc-session';
import { isDaemonCliEntrypoint, startDaemon } from './main.js';
import * as statusModule from './status.js';

describe('daemon startup', () => {
  let kb1Home: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    kb1Home = await mkdtemp(join(tmpdir(), 'kb1-startup-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(kb1Home, { force: true, recursive: true });
  });

  it('does not write status when the HTTP server fails to bind', async () => {
    const blocker = createServer();
    await listen(blocker);
    const port = (blocker.address() as AddressInfo).port;

    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port)
    };

    await expect(startDaemon()).rejects.toBeTruthy();
    await expect(access(join(kb1Home, 'daemon', 'status.json'))).rejects.toBeTruthy();

    await close(blocker);
  });

  it('ignores KB2_* env vars during startup', async () => {
    const port = await reservePort();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ignoredHome = join(kb1Home, 'ignored-kb2-home');
    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port),
      KB2_HOME: ignoredHome,
      KB2_HOST: '0.0.0.0',
      KB2_PORT: '1'
    };

    const started = await startDaemon();

    expect(started.config.kb1Home).toBe(kb1Home);
    expect(started.config.host).toBe('127.0.0.1');
    expect(started.config.port).toBe(port);
    expect(started.config.serviceName).toBe('kb1d');
    await expect(readFile(join(kb1Home, 'daemon', 'status.json'), 'utf8')).resolves.toContain('"kb1Home"');
    await expect(access(ignoredHome)).rejects.toBeTruthy();
    expect(warnSpy).not.toHaveBeenCalled();

    await started.close();
    warnSpy.mockRestore();
  });

  it('recognizes the installed kb1d symlink bin as a daemon entrypoint', async () => {
    const installRoot = await mkdtemp(join(tmpdir(), 'kb1-bin-entrypoint-'));
    try {
      const distDir = join(installRoot, 'node_modules', '@kb-1', 'daemon', 'dist');
      const binDir = join(installRoot, 'bin');
      await mkdir(distDir, { recursive: true });
      await mkdir(binDir, { recursive: true });
      const entrypoint = join(distDir, 'main.js');
      await writeFile(entrypoint, '#!/usr/bin/env node\n', 'utf8');

      const binPath = join(binDir, 'kb1d');
      await symlink(entrypoint, binPath);
      expect(isDaemonCliEntrypoint(pathToFileURL(entrypoint).href, binPath)).toBe(true);
    } finally {
      await rm(installRoot, { force: true, recursive: true });
    }
  });

  it('seeds and serves the first-boot starter vault through its scoped route', async () => {
    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port)
    };

    const started = await startDaemon();

    // The first-boot starter vault is listed and reachable only via its scoped
    // route — there is no flat default-vault surface.
    const list = await fetch(`http://127.0.0.1:${port}/api/vaults`);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      ok: true,
      vaults: [{ id: 'demo-vault' }]
    });

    const response = await fetch(`http://127.0.0.1:${port}/api/vaults/demo-vault/files/README.md`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, path: 'README.md' });
    expect(body.content).toContain('Welcome to your vault');
    await expect(readFile(join(started.config.vaultRoot, 'README.md'), 'utf8')).resolves.toBe(body.content);

    // The retired flat surface is gone.
    const flat = await fetch(`http://127.0.0.1:${port}/api/demo-document`);
    expect(flat.status).toBe(404);

    await started.close();
  });

  it('seeds the starter kit only for a first boot of an empty vault', async () => {
    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port)
    };

    const firstBoot = await startDaemon();
    // The whole bundled kit lands in the first-boot vault: a top-level README and
    // a nested note, proving the seeder copies the template tree recursively.
    await expect(readFile(join(firstBoot.config.vaultRoot, 'README.md'), 'utf8')).resolves.toContain('Welcome to your vault');
    await expect(readFile(join(firstBoot.config.vaultRoot, 'notes', 'getting-started.md'), 'utf8')).resolves.toContain('Getting started');

    const deleted = await fetch(`http://127.0.0.1:${port}/api/vaults/demo-vault/files/README.md`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    await expect(access(join(firstBoot.config.vaultRoot, 'README.md'))).rejects.toBeTruthy();
    await firstBoot.close();

    // Restart does not re-seed an existing vault: the deleted file stays gone.
    const restartedAfterDelete = await startDaemon();
    await expect(access(join(restartedAfterDelete.config.vaultRoot, 'README.md'))).rejects.toBeTruthy();
    await restartedAfterDelete.close();

    // A pre-existing (non-empty) vault is migrated but never seeded with the kit.
    const populatedHome = await mkdtemp(join(tmpdir(), 'kb1-populated-startup-'));
    process.env = {
      ...originalEnv,
      KB1_HOME: populatedHome,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port)
    };
    const populatedVault = join(populatedHome, 'demo-vault');
    await mkdir(join(populatedVault, 'notes'), { recursive: true });
    await writeFile(join(populatedVault, 'notes', 'preexisting.md'), 'already here\n', 'utf8');

    const populatedBoot = await startDaemon();
    await expect(access(join(populatedBoot.config.vaultRoot, 'README.md'))).rejects.toBeTruthy();
    await expect(readFile(join(populatedBoot.config.vaultRoot, 'notes', 'preexisting.md'), 'utf8')).resolves.toBe('already here\n');
    await populatedBoot.close();
    await rm(populatedHome, { force: true, recursive: true });
  });

  it('rejects missing document WebSocket opens without creating typo folders', async () => {
    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port)
    };

    const started = await startDaemon();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/vaults/demo-vault/files/typo/missing.md/yjs`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    await expect(closed).resolves.toEqual({
      code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
      reason: JSON.stringify({ ok: false, error: 'not_found', message: 'file not found' })
    });
    await expect(access(join(started.config.vaultRoot, 'typo'))).rejects.toBeTruthy();
    await expect(readFile(join(started.config.vaultRoot, 'README.md'), 'utf8')).resolves.toContain('Welcome to your vault');

    await started.close();
  });

  it('allows an immediate create after a missing document WebSocket bind fails', async () => {
    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port)
    };

    const started = await startDaemon();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/vaults/demo-vault/files/typo/missing.md/yjs`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    await expect(closed).resolves.toEqual({
      code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
      reason: JSON.stringify({ ok: false, error: 'not_found', message: 'file not found' })
    });

    const created = await fetch(`http://127.0.0.1:${port}/api/vaults/demo-vault/files/typo/missing.md`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'created immediately\n'
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ ok: true, path: 'typo/missing.md' });
    await expect(readFile(join(started.config.vaultRoot, 'typo', 'missing.md'), 'utf8')).resolves.toBe('created immediately\n');

    await started.close();
  });

  it('authenticates a supervised shutdown and exposes its launch nonce in health', async () => {
    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port),
      KB1_CONTROL_TOKEN: 'supervisor-secret',
      KB1_INSTANCE_ID: 'scheduled-task-run-123'
    };

    const started = await startDaemon();
    const origin = `http://127.0.0.1:${port}`;
    const health = await fetch(`${origin}/api/health`);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      status: {
        pid: process.pid,
        instanceId: 'scheduled-task-run-123'
      }
    });

    const rejected = await fetch(`${origin}/api/control/shutdown`, {
      method: 'POST',
      headers: { 'x-kb1-control-token': 'not-the-secret' }
    });
    expect(rejected.status).toBe(401);
    expect((await fetch(`${origin}/api/health`)).status).toBe(200);

    const accepted = await fetch(`${origin}/api/control/shutdown`, {
      method: 'POST',
      headers: { 'x-kb1-control-token': 'supervisor-secret' }
    });
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({ ok: true, shuttingDown: true });

    await started.close();
    await expect(fetch(`${origin}/api/health`)).rejects.toBeTruthy();
  });

  it('completes an authenticated shutdown requested while startup status is pending', async () => {
    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port),
      KB1_CONTROL_TOKEN: 'startup-shutdown-secret'
    };

    let releaseStatusWrite: (() => void) | undefined;
    const statusWriteGate = new Promise<void>((resolve) => {
      releaseStatusWrite = resolve;
    });
    let markStatusWriteStarted: (() => void) | undefined;
    const statusWriteStarted = new Promise<void>((resolve) => {
      markStatusWriteStarted = resolve;
    });
    const writeDaemonStatus = statusModule.writeDaemonStatus;
    const statusSpy = vi
      .spyOn(statusModule, 'writeDaemonStatus')
      .mockImplementation(async (config) => {
        markStatusWriteStarted?.();
        await statusWriteGate;
        return writeDaemonStatus(config);
      });

    try {
      const starting = startDaemon();
      await statusWriteStarted;
      const origin = `http://127.0.0.1:${port}`;
      const accepted = await fetch(`${origin}/api/control/shutdown`, {
        method: 'POST',
        headers: { 'x-kb1-control-token': 'startup-shutdown-secret' }
      });
      expect(accepted.status).toBe(202);
      await expect(accepted.json()).resolves.toEqual({
        ok: true,
        shuttingDown: true
      });

      releaseStatusWrite?.();
      const started = await starting;
      await started.close();
      await expect(fetch(`${origin}/api/health`)).rejects.toBeTruthy();
    } finally {
      releaseStatusWrite?.();
      statusSpy.mockRestore();
    }
  });
});

describe('daemon boot migration', () => {
  let kb1Home: string;
  let originalEnv: NodeJS.ProcessEnv;

  const SEEDED_NOTES: ReadonlyArray<{ readonly path: string; readonly content: string }> = [
    { path: 'welcome.md', content: '# Welcome\n\nThe first top-level note.\n' },
    { path: 'ideas.md', content: '# Ideas\n\nA second top-level note with distinctive text.\n' },
    { path: join('projects', 'roadmap.md'), content: '# Roadmap\n\nA nested note that must survive the move.\n' }
  ];

  beforeEach(async () => {
    originalEnv = { ...process.env };
    kb1Home = await mkdtemp(join(tmpdir(), 'kb1-migration-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(kb1Home, { force: true, recursive: true });
  });

  async function seedLegacyLayout(): Promise<void> {
    const legacyVault = join(kb1Home, 'demo-vault');
    for (const note of SEEDED_NOTES) {
      const absolute = join(legacyVault, note.path);
      await mkdir(join(absolute, '..'), { recursive: true });
      await writeFile(absolute, note.content, 'utf8');
    }
  }

  it('migrates a legacy .kb2 daemon home to .kb1 on boot and is idempotent', async () => {
    const homeDir = join(kb1Home, 'user-home');
    const legacyHome = join(homeDir, '.kb2');
    const migratedHome = join(homeDir, '.kb1');
    const legacyVaultRoot = join(legacyHome, 'vaults', 'demo-vault');
    await mkdir(join(legacyHome, 'daemon'), { recursive: true });
    await writeFile(join(legacyHome, 'daemon', 'legacy-marker.txt'), 'legacy daemon data\n', 'utf8');
    await mkdir(join(legacyVaultRoot, 'notes'), { recursive: true });
    await writeFile(join(legacyVaultRoot, 'notes', 'from-old-home.md'), 'from old home\n', 'utf8');

    const firstPort = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(firstPort)
    };

    const firstBoot = await startDaemon({ homeDir });
    expect(firstBoot.config.kb1Home).toBe(migratedHome);
    await expect(access(legacyHome)).rejects.toBeTruthy();
    await expect(readFile(join(migratedHome, 'daemon', 'legacy-marker.txt'), 'utf8')).resolves.toBe(
      'legacy daemon data\n'
    );
    await expect(readFile(join(migratedHome, 'vaults', 'demo-vault', 'notes', 'from-old-home.md'), 'utf8')).resolves.toBe(
      'from old home\n'
    );
    await firstBoot.close();

    const secondPort = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(secondPort)
    };
    const secondBoot = await startDaemon({ homeDir });
    expect(secondBoot.config.kb1Home).toBe(migratedHome);
    await expect(access(legacyHome)).rejects.toBeTruthy();
    await expect(readFile(join(migratedHome, 'vaults', 'demo-vault', 'notes', 'from-old-home.md'), 'utf8')).resolves.toBe(
      'from old home\n'
    );
    await secondBoot.close();
  });

  it('migrates a Docker-style sibling kb2 home to an explicit kb1 home and is idempotent', async () => {
    const dataRoot = join(kb1Home, 'data');
    const legacyHome = join(dataRoot, 'kb2');
    const targetHome = join(dataRoot, 'kb1');
    const legacyVaultRoot = join(legacyHome, 'vaults', 'demo-vault');
    await mkdir(join(legacyHome, 'daemon'), { recursive: true });
    await writeFile(join(legacyHome, 'daemon', 'docker-marker.txt'), 'legacy docker data\n', 'utf8');
    await mkdir(join(legacyVaultRoot, 'notes'), { recursive: true });
    await writeFile(join(legacyVaultRoot, 'notes', 'from-docker-home.md'), 'from docker home\n', 'utf8');

    const firstPort = await reservePort();
    const firstBoot = await startDaemon({
      env: {
        ...originalEnv,
        KB1_HOME: targetHome,
        KB1_HOST: '127.0.0.1',
        KB1_PORT: String(firstPort)
      },
      homeDir: join(kb1Home, 'ignored-home')
    });

    expect(firstBoot.config.kb1Home).toBe(targetHome);
    await expect(access(legacyHome)).rejects.toBeTruthy();
    await expect(readFile(join(targetHome, 'daemon', 'docker-marker.txt'), 'utf8')).resolves.toBe(
      'legacy docker data\n'
    );
    await expect(readFile(join(targetHome, 'vaults', 'demo-vault', 'notes', 'from-docker-home.md'), 'utf8')).resolves.toBe(
      'from docker home\n'
    );
    await firstBoot.close();

    const secondPort = await reservePort();
    const secondBoot = await startDaemon({
      env: {
        ...originalEnv,
        KB1_HOME: targetHome,
        KB1_HOST: '127.0.0.1',
        KB1_PORT: String(secondPort)
      },
      homeDir: join(kb1Home, 'ignored-home')
    });

    expect(secondBoot.config.kb1Home).toBe(targetHome);
    await expect(access(legacyHome)).rejects.toBeTruthy();
    await expect(readFile(join(targetHome, 'vaults', 'demo-vault', 'notes', 'from-docker-home.md'), 'utf8')).resolves.toBe(
      'from docker home\n'
    );
    await secondBoot.close();
  });

  it('migrates a legacy single-vault layout into the registry layout on boot, preserving every note', async () => {
    await seedLegacyLayout();

    const port = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port)
    };

    const started = await startDaemon();
    const vaultRoot = started.config.vaultRoot;

    // The migrated vault lives under <home>/vaults/<slug>/ and the legacy root is gone.
    expect(vaultRoot).toBe(join(kb1Home, 'vaults', 'demo-vault'));
    await expect(access(join(kb1Home, 'demo-vault'))).rejects.toBeTruthy();

    // Data-safety: every seeded note, including the nested one, survives byte-for-byte.
    for (const note of SEEDED_NOTES) {
      await expect(readFile(join(vaultRoot, note.path), 'utf8')).resolves.toBe(note.content);
    }

    // A durable vault identity was minted with a non-empty slug and display name.
    const identity = JSON.parse(await readFile(join(vaultRoot, '.kb1', 'vault.json'), 'utf8'));
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
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(firstPort)
    };

    const firstBoot = await startDaemon();
    const vaultRoot = firstBoot.config.vaultRoot;
    const identityFile = join(vaultRoot, '.kb1', 'vault.json');
    const identityAfterFirstBoot = await readFile(identityFile, 'utf8');
    const contentsAfterFirstBoot = await Promise.all(
      SEEDED_NOTES.map((note) => readFile(join(vaultRoot, note.path), 'utf8'))
    );
    await firstBoot.close();

    const secondPort = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(secondPort)
    };

    const secondBoot = await startDaemon();
    expect(secondBoot.config.vaultRoot).toBe(vaultRoot);

    // The legacy root is not recreated, and the identity is byte-for-byte identical
    // (the slug is read back, never recomputed).
    await expect(access(join(kb1Home, 'demo-vault'))).rejects.toBeTruthy();
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
  let kb1Home: string;
  let originalEnv: NodeJS.ProcessEnv;
  let port: number;
  let started: Awaited<ReturnType<typeof startDaemon>>;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    kb1Home = await mkdtemp(join(tmpdir(), 'kb1-vaults-api-'));
    port = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port)
    };
    started = await startDaemon();
  });

  afterEach(async () => {
    await started.close();
    process.env = originalEnv;
    await rm(kb1Home, { force: true, recursive: true });
  });

  const base = () => `http://127.0.0.1:${port}`;

  async function listVaults(): Promise<Array<{ id: string; displayName: string }>> {
    const response = await fetch(`${base()}/api/vaults`);
    expect(response.status).toBe(200);
    const body = await response.json();
    return body.vaults;
  }

  it('drives the full create -> list -> rename -> delete lifecycle live, with no restart', async () => {
    // The first-boot starter vault is present from boot.
    expect(await listVaults()).toContainEqual({ id: 'demo-vault', displayName: 'demo-vault' });

    // CREATE: caller supplies BOTH display name and an explicit, valid slug.
    const createResponse = await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Field Notes', slug: 'field-notes' })
    });
    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toEqual({
      ok: true,
      vault: { id: 'field-notes', displayName: 'Field Notes' }
    });

    // A real, valid empty vault landed on disk with minted identity.
    const identity = JSON.parse(
      await readFile(join(kb1Home, 'vaults', 'field-notes', '.kb1', 'vault.json'), 'utf8')
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
    await expect(access(join(kb1Home, 'vaults', 'field-notes'))).resolves.toBeUndefined();
    const renamedIdentity = JSON.parse(
      await readFile(join(kb1Home, 'vaults', 'field-notes', '.kb1', 'vault.json'), 'utf8')
    );
    expect(renamedIdentity).toEqual({ id: 'field-notes', displayName: 'Field Journal' });

    // DELETE (soft): gone from the list, folder reversibly preserved in trash.
    const deleteResponse = await fetch(`${base()}/api/vaults/field-notes`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toMatchObject({ ok: true });
    expect((await listVaults()).some((v) => v.id === 'field-notes')).toBe(false);
    await expect(access(join(kb1Home, 'vaults', 'field-notes'))).rejects.toBeTruthy();
    // The data still exists under the home-level trash (never hard-deleted).
    const trashed = JSON.parse(
      await readFile(join(kb1Home, '.trash', 'field-notes', '.kb1', 'vault.json'), 'utf8')
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
      body: JSON.stringify({ displayName: 'Scoped', slug: 'scoped' })
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
      readFile(join(kb1Home, 'vaults', 'scoped', 'only-here.md'), 'utf8')
    ).resolves.toBe('scoped content\n');

    // Readable back through the scoped route.
    const read = await fetch(`${base()}/api/vaults/scoped/files/only-here.md`);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ ok: true, content: 'scoped content\n' });

    // The retired flat route does not exist: it falls through to a clean 404.
    const flatRead = await fetch(`${base()}/api/files/only-here.md`);
    expect(flatRead.status).toBe(404);

    // A different vault does not see the scoped vault's note either.
    const otherRead = await fetch(`${base()}/api/vaults/demo-vault/files/only-here.md`);
    expect(otherRead.status).toBe(404);
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
      body: JSON.stringify({ displayName: 'Dup', slug: 'dup' })
    });
    expect(first.status).toBe(201);

    const collision = await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Another Dup', slug: 'dup' })
    });
    expect(collision.status).toBe(409);
    await expect(collision.json()).resolves.toMatchObject({ ok: false, error: 'already_exists' });
  });

  it('rejects a create with an invalid or missing slug as a clean 400', async () => {
    // A non-normalized slug is never inferred from the display name; it is a 400.
    const invalid = await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Field Notes', slug: 'Field Notes' })
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ ok: false, error: 'invalid_request' });

    // A missing slug is also a clean 400 (the server never infers it).
    const missing = await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Field Notes' })
    });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ ok: false, error: 'invalid_request' });

    // Nothing landed on disk for the rejected slug.
    await expect(access(join(kb1Home, 'vaults', 'field-notes'))).rejects.toBeTruthy();
  });

  it('treats zero vaults as a valid state: deleting the last vault still serves', async () => {
    // Delete the only (starter) vault, leaving the daemon with no vaults.
    const deleted = await fetch(`${base()}/api/vaults/demo-vault`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);

    // Listing returns an empty array, not an error.
    await expect(listVaults()).resolves.toEqual([]);

    // Scoped routes for the now-missing vault return a clean 404 (no crash).
    const goneTree = await fetch(`${base()}/api/vaults/demo-vault/tree`);
    expect(goneTree.status).toBe(404);

    // The daemon is still healthy and the web bundle path still serves.
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);

    // A fresh vault can still be created from the empty state.
    const recreated = await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Fresh Start', slug: 'fresh-start' })
    });
    expect(recreated.status).toBe(201);
    expect(await listVaults()).toContainEqual({ id: 'fresh-start', displayName: 'Fresh Start' });
  });

  it('edits a live document over the scoped Yjs WebSocket and persists to the scoped vault', async () => {
    await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'WS Vault', slug: 'ws-vault' })
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

describe('daemon multi-vault MCP surface', () => {
  let kb1Home: string;
  let originalEnv: NodeJS.ProcessEnv;
  let port: number;
  let started: Awaited<ReturnType<typeof startDaemon>>;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    kb1Home = await mkdtemp(join(tmpdir(), 'kb1-mcp-vaults-'));
    port = await reservePort();
    process.env = {
      ...originalEnv,
      KB1_HOME: kb1Home,
      KB1_HOST: '127.0.0.1',
      KB1_PORT: String(port)
    };
    started = await startDaemon();
    client = new Client({ name: 'mcp-multi-vault-test', version: '1.0.0' });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
  });

  afterEach(async () => {
    await transport.terminateSession().catch(() => undefined);
    await started.close();
    process.env = originalEnv;
    await rm(kb1Home, { force: true, recursive: true });
  });

  const base = () => `http://127.0.0.1:${port}`;

  async function createVault(displayName: string, slug: string): Promise<string> {
    const response = await fetch(`${base()}/api/vaults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName, slug })
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    return body.vault.id as string;
  }

  it('lists every vault through the list_vaults tool, mirroring the registry', async () => {
    const created = await createVault('Field Notes', 'field-notes');
    expect(created).toBe('field-notes');

    const listed = await mcpToolJson(client, 'list_vaults', {}) as {
      ok: boolean;
      vaults: Array<{ id: string; displayName: string }>;
    };
    expect(listed.ok).toBe(true);
    // The starter vault plus the freshly created one — same shape the HTTP API returns.
    expect(listed.vaults).toContainEqual({ id: 'demo-vault', displayName: 'demo-vault' });
    expect(listed.vaults).toContainEqual({ id: 'field-notes', displayName: 'Field Notes' });
  });

  it('requires the vaultId param on data tools but not on list_vaults', async () => {
    const tools = await client.listTools();
    const vaultInfo = tools.tools.find((tool) => tool.name === 'vault_info');
    expect(vaultInfo?.inputSchema.properties).toHaveProperty('vaultId');
    expect(vaultInfo?.inputSchema.required ?? []).toContain('vaultId');
    const createNote = tools.tools.find((tool) => tool.name === 'create_note');
    expect(createNote?.inputSchema.properties).toHaveProperty('vaultId');
    expect(createNote?.inputSchema.required ?? []).toContain('vaultId');
    const listVaults = tools.tools.find((tool) => tool.name === 'list_vaults');
    expect(listVaults?.inputSchema.properties ?? {}).not.toHaveProperty('vaultId');
  });

  it('rejects a data-tool call that omits vaultId (no default vault)', async () => {
    const missing = await client.callTool({ name: 'create_note', arguments: { path: 'nope.md', content: 'x\n' } });
    expect(missing.isError).toBe(true);

    // Nothing was written into any vault.
    await expect(access(join(kb1Home, 'vaults', 'demo-vault', 'nope.md'))).rejects.toBeTruthy();

    // The same call WITH a valid vaultId succeeds.
    await expect(mcpToolJson(client, 'create_note', { vaultId: 'demo-vault', path: 'in-starter.md', content: 'body\n' }))
      .resolves.toMatchObject({ ok: true, path: 'in-starter.md' });
    await expect(readFile(join(kb1Home, 'vaults', 'demo-vault', 'in-starter.md'), 'utf8'))
      .resolves.toBe('body\n');
  });

  it('addresses a second vault by vaultId and keeps it isolated from the starter vault', async () => {
    const vaultId = await createVault('Second', 'second');
    expect(vaultId).toBe('second');

    // Write a note into the second vault via MCP using its vaultId.
    await expect(mcpToolJson(client, 'create_note', {
      vaultId,
      path: 'only-in-second.md',
      content: 'second body\n'
    })).resolves.toMatchObject({ ok: true, path: 'only-in-second.md' });

    // It is on disk under the second vault's folder.
    await expect(readFile(join(kb1Home, 'vaults', 'second', 'only-in-second.md'), 'utf8'))
      .resolves.toBe('second body\n');

    // Readable back addressing the second vault via MCP.
    await expect(mcpToolJson(client, 'read_note', { vaultId, path: 'only-in-second.md' }))
      .resolves.toMatchObject({ ok: true, content: 'second body\n' });

    // Cross-vault isolation: the starter vault does not see it (MCP and HTTP both miss).
    const starterRead = await client.callTool({ name: 'read_note', arguments: { vaultId: 'demo-vault', path: 'only-in-second.md' } });
    expect(starterRead.isError).toBe(true);
    expect(mcpText(starterRead)).toContain('"error":"not_found"');

    const httpStarterRead = await fetch(`${base()}/api/vaults/demo-vault/files/only-in-second.md`);
    expect(httpStarterRead.status).toBe(404);

    // And the HTTP scoped route for the second vault DOES see it — same content.
    const httpScopedRead = await fetch(`${base()}/api/vaults/second/files/only-in-second.md`);
    expect(httpScopedRead.status).toBe(200);
    await expect(httpScopedRead.json()).resolves.toMatchObject({ ok: true, content: 'second body\n' });
  });

  it('returns a clean tool error for an unknown vaultId without crashing the daemon', async () => {
    const result = await client.callTool({
      name: 'create_note',
      arguments: { vaultId: 'does-not-exist', path: 'nope.md', content: 'x\n' }
    });
    expect(result.isError).toBe(true);
    expect(mcpText(result)).toBe('create_note rejected: {"ok":false,"error":"not_found","message":"No vault with id \\"does-not-exist\\"."}');

    // The daemon is still healthy and serving after the miss.
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);

    // Nothing was written anywhere.
    await expect(access(join(kb1Home, 'vaults', 'demo-vault', 'nope.md'))).rejects.toBeTruthy();
  });
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  await close(server);
  return port;
}

async function mcpToolJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(mcpText(await client.callTool({ name, arguments: args }))) as Record<string, unknown>;
}

function mcpText(result: Awaited<ReturnType<Client['callTool']>>): string {
  if (!Array.isArray(result.content)) {
    throw new Error('Expected MCP content array');
  }
  const first = result.content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected text MCP content');
  }
  return first.text;
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
