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
