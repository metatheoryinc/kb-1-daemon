#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repoRoot = resolve(import.meta.dirname, '..');
const nonce = `${Date.now()}-${process.pid}`;
const imageOverride = process.env.KB1_RELEASE_SMOKE_IMAGE;
const image = imageOverride || `kb-1-daemon:release-smoke-${nonce}`;
const container = `kb1-release-smoke-${nonce}`;
const volume = `kb1-release-smoke-${nonce}`;
const port = Number(process.env.KB1_RELEASE_SMOKE_PORT || await reservePort());
const origin = `http://127.0.0.1:${port}`;
const networkTimeoutMs = Number(process.env.KB1_RELEASE_SMOKE_TIMEOUT_MS || '60000');
let containerCreated = false;
let volumeCreated = false;

try {
  await run('docker', ['build', '-f', 'apps/daemon/Dockerfile', '-t', image, '.']);
  await run('docker', ['volume', 'create', volume]);
  volumeCreated = true;
  await run('docker', [
    'create', '--name', container,
    '--publish', `127.0.0.1:${port}:7382`,
    '--volume', `${volume}:/data/kb1`,
    image
  ]);
  containerCreated = true;
  await run('docker', ['start', container]);

  await waitForHealthy(origin);
  await verifyDistributionFiles();
  await verifyUi(origin);
  await verifyMcp(origin);
  await run(process.execPath, ['scripts/yjs-smoke.mjs'], {
    ...process.env,
    KB1_HOST: '127.0.0.1',
    KB1_PORT: String(port),
    KB1_YJS_URL: `ws://127.0.0.1:${port}/api/vaults/demo-vault/files/README.md/yjs`,
    KB1_YJS_EXPECTED_TEXT: 'Welcome to your vault',
    KB1_SMOKE_TIMEOUT_MS: String(networkTimeoutMs)
  });

  await run('docker', ['restart', container]);
  await waitForHealthy(origin);
  const restarted = await jsonFetch(`${origin}/api/vaults/demo-vault/files/README.md`);
  if (typeof restarted.content !== 'string' || !restarted.content.includes('Yjs release smoke client A')) {
    throw new Error('The smoke edit was not durable across a container restart.');
  }

  console.log(`Release image smoke passed at ${origin}.`);
  console.log('Verified licenses/notices, health, bundled UI, 19-tool MCP initialization, Yjs durability, and volume persistence across restart.');
} catch (error) {
  if (containerCreated) {
    console.error('\nContainer logs:');
    await run('docker', ['logs', container], process.env, false).catch(() => undefined);
  }
  throw error;
} finally {
  if (containerCreated) {
    await run('docker', ['rm', '--force', container], process.env, false).catch(() => undefined);
  }
  if (volumeCreated) {
    await run('docker', ['volume', 'rm', volume], process.env, false).catch(() => undefined);
  }
  if (!imageOverride) {
    await run('docker', ['image', 'rm', image], process.env, false).catch(() => undefined);
  }
}

async function waitForHealthy(baseUrl) {
  const deadline = Date.now() + networkTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await jsonFetch(
        `${baseUrl}/api/health`,
        Math.min(2000, Math.max(1, deadline - Date.now()))
      );
      if (health.ok === true) return;
      lastError = new Error(`Unexpected health payload: ${JSON.stringify(health)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Daemon did not become healthy: ${lastError?.message ?? 'unknown error'}`);
}

async function verifyUi(baseUrl) {
  const response = await fetch(`${baseUrl}/`, {
    signal: AbortSignal.timeout(networkTimeoutMs)
  });
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  if (!response.ok || !contentType.includes('text/html') || !body.includes('KB-1')) {
    throw new Error(`Bundled UI smoke failed: HTTP ${response.status}, content-type ${JSON.stringify(contentType)}`);
  }

  const assets = [...body.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => new URL(match[1], baseUrl))
    .filter((asset) => asset.origin === new URL(baseUrl).origin && /\.(?:css|js)$/.test(asset.pathname));
  const buildRoot = '/app/apps/web/build';
  const bundledFiles = (await runCapture('docker', [
    'exec', container, 'find', `${buildRoot}/_app`, '-type', 'f'
  ]))
    .trim()
    .split('\n')
    .filter((filePath) => /\.(?:css|js)$/.test(filePath))
    .map((filePath) => new URL(filePath.slice(buildRoot.length), baseUrl));
  if (assets.length === 0 || bundledFiles.length === 0) {
    throw new Error('Bundled UI smoke found no JavaScript or CSS assets.');
  }

  const assetUrls = new Set([...assets, ...bundledFiles].map((asset) => asset.href));
  await Promise.all([...assetUrls].map(async (assetUrl) => {
    const asset = await fetch(assetUrl, {
      signal: AbortSignal.timeout(networkTimeoutMs)
    });
    const assetType = asset.headers.get('content-type') || '';
    const bytes = await asset.arrayBuffer();
    const expectedType = new URL(assetUrl).pathname.endsWith('.css') ? 'text/css' : 'javascript';
    if (!asset.ok || bytes.byteLength === 0 || !assetType.includes(expectedType) || assetType.includes('text/html')) {
      throw new Error(
        `Bundled UI asset failed: ${assetUrl} -> HTTP ${asset.status}, content-type ${JSON.stringify(assetType)}, bytes ${bytes.byteLength}`
      );
    }
  }));
}

async function verifyDistributionFiles() {
  await run('docker', ['exec', container, 'test', '-s', '/app/LICENSE']);
  await run('docker', ['exec', container, 'test', '-s', '/app/THIRD_PARTY_NOTICES.md']);
}

async function verifyMcp(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`MCP smoke exceeded ${networkTimeoutMs}ms`));
  }, networkTimeoutMs);
  const boundedFetch = (input, init = {}) => fetch(input, {
    ...init,
    signal: init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    fetch: boundedFetch
  });
  const client = new Client({ name: 'kb-1-release-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const actual = listed.tools.map((tool) => tool.name).sort();
    const expected = [
      'append_note',
      'create_folder',
      'create_note',
      'delete_folder',
      'delete_note',
      'edit_note',
      'get_folder_metadata',
      'list_attachments',
      'list_files',
      'list_vaults',
      'move_folder',
      'move_note',
      'prepend_note',
      'read_attachment',
      'read_note',
      'search',
      'set_folder_metadata',
      'upload_attachment',
      'vault_info'
    ];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`MCP tool inventory mismatch. Expected ${expected.join(', ')}, got ${actual.join(', ')}`);
    }
  } finally {
    try {
      await transport.terminateSession().catch(() => undefined);
    } finally {
      controller.abort();
      clearTimeout(timeout);
      await client.close().catch(() => undefined);
    }
  }
}

async function jsonFetch(url, timeoutMs = networkTimeoutMs) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !body || typeof body !== 'object') {
    throw new Error(`Request failed: GET ${url} -> HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function run(command, args, env = process.env, inherit = true) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: inherit ? 'inherit' : ['ignore', 'inherit', 'inherit']
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with ${signal || `exit ${code}`}`));
    });
  });
}

function runCapture(command, args, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with ${signal || `exit ${code}`}`));
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
        reject(new Error('Could not reserve a release-smoke port.'));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}
