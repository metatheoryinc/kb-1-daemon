#!/usr/bin/env node

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { spawnPnpm, terminateProcessTree } from './process-runner.mjs';

if (process.platform !== 'win32') {
  console.log('Windows source smoke skipped: this check runs only on Windows.');
  process.exit(0);
}

const repoRoot = resolve(import.meta.dirname, '..');
const kb1Home = await mkdtemp(join(tmpdir(), 'kb1-windows-smoke-'));
const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const timeoutMs = Number(process.env.KB1_WINDOWS_SMOKE_TIMEOUT_MS || '90000');
const expectedContent = `# Windows smoke\n\nPersistent note ${Date.now()}\n`;
let daemon;

try {
  daemon = startDaemon();
  await waitForHealthy(daemon);

  const created = await fetch(`${origin}/api/vaults/demo-vault/files/windows-smoke.md`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: expectedContent,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (created.status !== 201) {
    throw new Error(`Windows smoke note create failed: HTTP ${created.status} ${await created.text()}`);
  }
  await verifyNote();

  await stopDaemon(daemon);
  daemon = undefined;
  await waitForUnavailable();

  daemon = startDaemon();
  await waitForHealthy(daemon);
  await verifyNote();

  console.log('Windows source smoke passed.');
  console.log('Verified daemon startup, note create/read, process-tree shutdown, and restart persistence.');
} catch (error) {
  if (daemon?.logs) {
    console.error('\nDaemon output:');
    console.error(daemon.logs.join(''));
  }
  throw error;
} finally {
  if (daemon) {
    await stopDaemon(daemon).catch(() => undefined);
  }
  await rm(kb1Home, { force: true, recursive: true });
}

function startDaemon() {
  const logs = [];
  const child = spawnPnpm(
    ['--filter', '@kb-1/daemon', 'dev'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        KB1_HOME: kb1Home,
        KB1_HOST: '127.0.0.1',
        KB1_PORT: String(port)
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  );

  child.stdout.on('data', (value) => {
    logs.push(String(value));
  });
  child.stderr.on('data', (value) => {
    logs.push(String(value));
  });

  return { child, logs };
}

async function stopDaemon(running) {
  const exited = waitForExit(running.child);
  await terminateProcessTree(running.child);
  await exited;
}

async function waitForHealthy(running) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    if (running.child.exitCode != null || running.child.signalCode != null) {
      throw new Error(
        `Daemon exited before becoming healthy (${running.child.exitCode ?? running.child.signalCode}).\n`
        + running.logs.join('')
      );
    }

    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now())))
      });
      const health = await response.json();
      if (response.ok && health.ok === true) {
        return;
      }
      lastError = new Error(`Unexpected health response: HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }

  throw new Error(`Daemon did not become healthy: ${lastError?.message ?? 'unknown error'}`);
}

async function verifyNote() {
  const response = await fetch(`${origin}/api/vaults/demo-vault/files/windows-smoke.md`, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  if (!response.ok || body.content !== expectedContent) {
    throw new Error(
      `Windows smoke note read failed: HTTP ${response.status} ${JSON.stringify(body)}`
    );
  }
}

async function waitForUnavailable() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(500)
      });
    } catch {
      return;
    }
    await delay(100);
  }
  throw new Error('Daemon remained reachable after Windows process-tree shutdown.');
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve();
  }

  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Daemon process tree did not exit after taskkill.'));
    }, 10000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a Windows smoke port.'));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
