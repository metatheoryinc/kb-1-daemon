import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DocumentSessionManager, OneFileDocumentSession, type DocumentSessionEvent } from '@kb-2/doc-session';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createApp } from './app.js';
import { createDaemonConfig } from './config.js';
import { writeDaemonStatus } from './status.js';

describe('daemon routing', () => {
  let kb2Home: string;

  beforeEach(async () => {
    kb2Home = await mkdtemp(join(tmpdir(), 'kb2-health-'));
  });

  afterEach(async () => {
    await rm(kb2Home, { force: true, recursive: true });
  });

  it('returns daemon status read back from the configured filesystem home', async () => {
    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home
      },
      now: new Date('2026-06-10T15:30:00.000Z'),
      pid: 5678
    });

    await writeDaemonStatus(config);

    const app = createApp({ statusFile: config.statusFile });
    const response = await app.request('/api/health');
    const body = await response.json();
    const statusFileContents = JSON.parse(await readFile(config.statusFile, 'utf8'));

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      service: 'kb2d',
      status: {
        serviceName: 'kb2d',
        kb2Home,
        daemonHome: join(kb2Home, 'daemon'),
        statusFile: config.statusFile,
        pid: 5678
      }
    });
    expect(statusFileContents).toMatchObject(body.status);
  });

  it('serves the UI shell for root and client route requests', async () => {
    const webBuildDir = await mkdtemp(join(tmpdir(), 'kb2-web-build-'));
    await writeFile(join(webBuildDir, 'index.html'), '<!doctype html><title>KB-2 Local</title><div id="svelte">KB-2 Local UI</div>', 'utf8');

    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home
      }
    });
    const app = createApp({ statusFile: config.statusFile, webBuildDir });

    const rootResponse = await app.request('/');
    const routeResponse = await app.request('/status');

    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get('content-type')).toContain('text/html');
    await expect(rootResponse.text()).resolves.toContain('KB-2 Local UI');

    expect(routeResponse.status).toBe(200);
    expect(routeResponse.headers.get('content-type')).toContain('text/html');
    await expect(routeResponse.text()).resolves.toContain('KB-2 Local UI');

    await rm(webBuildDir, { force: true, recursive: true });
  });

  it('serves built UI assets without routing them through the SPA fallback', async () => {
    const webBuildDir = await mkdtemp(join(tmpdir(), 'kb2-web-build-'));
    await mkdir(join(webBuildDir, '_app'), { recursive: true });
    await writeFile(join(webBuildDir, 'index.html'), '<!doctype html><title>KB-2 Local</title>', 'utf8');
    await writeFile(join(webBuildDir, '_app', 'app.css'), 'body { color: black; }', 'utf8');

    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home
      }
    });
    const app = createApp({ statusFile: config.statusFile, webBuildDir });

    const response = await app.request('/_app/app.css');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/css');
    await expect(response.text()).resolves.toContain('color: black');

    await rm(webBuildDir, { force: true, recursive: true });
  });

  it('keeps missing API routes out of the UI fallback', async () => {
    const webBuildDir = await mkdtemp(join(tmpdir(), 'kb2-web-build-'));
    await writeFile(join(webBuildDir, 'index.html'), '<!doctype html><title>KB-2 Local</title>', 'utf8');

    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home
      }
    });
    const app = createApp({ statusFile: config.statusFile, webBuildDir });

    const response = await app.request('/api/missing');
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ ok: false, error: 'Not found' });

    await rm(webBuildDir, { force: true, recursive: true });
  });

  it('reads and resets the one-file demo document through the daemon API', async () => {
    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home
      }
    });
    const documentSession = new OneFileDocumentSession(config.demoDocumentFile, { defaultContent: 'route seed\n' });
    await documentSession.open();

    const app = createApp({
      statusFile: config.statusFile,
      demoDocumentSession: documentSession
    });

    const readResponse = await app.request('/api/demo-document');
    const readBody = await readResponse.json();

    expect(readResponse.status).toBe(200);
    expect(readBody).toEqual({
      ok: true,
      document: 'demo-vault/hello-world.md',
      content: 'route seed\n'
    });

    const resetResponse = await app.request('/api/demo-document/reset', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ content: 'route reset\n' })
    });
    const resetBody = await resetResponse.json();

    expect(resetResponse.status).toBe(200);
    expect(resetBody).toEqual({
      ok: true,
      document: 'demo-vault/hello-world.md',
      content: 'route reset\n'
    });
    await expect(readFile(config.demoDocumentFile, 'utf8')).resolves.toBe('route reset\n');

    await documentSession.close();
  });

  it('exposes vault file routes with no-clobber writes, overwrite, taxonomy, and audit rows', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot });

    const created = await app.request('/api/files/notes/a.md', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'first'
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ ok: true, path: 'notes/a.md' });

    const duplicate = await app.request('/api/files/notes/a.md', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'second'
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: false, error: 'already_exists' });

    const overwritten = await app.request('/api/files/notes/a.md?overwrite=true', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'second' })
    });
    expect(overwritten.status).toBe(200);

    const read = await app.request('/api/files/notes/a.md');
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ ok: true, path: 'notes/a.md', content: 'second' });

    const invalid = await app.request('/api/files/no-extension', { method: 'PUT', body: 'x' });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ ok: false, error: 'invalid_path' });

    const audit = await readAuditRows(config.vaultRoot);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ operation: 'create', entityKind: 'file', path: 'notes/a.md', actor: { kind: 'user' } });
    expect(audit[1]).toMatchObject({ operation: 'write', path: 'notes/a.md' });
  });

  it('moves and deletes live file sessions through the API with doc events and trash', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({ root: config.vaultRoot, defaultContent: '' });
    const liveSession = sessions.getSession('notes/live.md');
    const events: DocumentSessionEvent[] = [];
    liveSession.onEvent((event) => events.push(event));
    await liveSession.open();
    liveSession.ydoc.getText('markdown').insert(0, 'live content\n');
    await liveSession.flush();

    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });
    const moved = await app.request('/api/files/notes/live.md/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'notes/renamed.md' })
    });
    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({ ok: true, fromPath: 'notes/live.md', toPath: 'notes/renamed.md', live: true });
    liveSession.ydoc.getText('markdown').insert(liveSession.ydoc.getText('markdown').length, 'after move\n');
    await liveSession.flush();

    await expect(readFile(join(config.vaultRoot, 'notes/renamed.md'), 'utf8')).resolves.toBe('live content\nafter move\n');
    await expect(readFile(join(config.vaultRoot, 'notes/live.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'doc-moved', fromPath: 'notes/live.md', toPath: 'notes/renamed.md' }));

    const deleted = await app.request('/api/files/notes/renamed.md', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ ok: true, path: 'notes/renamed.md', live: true });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'doc-deleted', path: 'notes/renamed.md' }));

    const tree = await app.request('/api/tree');
    const treeBody = await tree.json() as { entries: Array<{ path: string }> };
    expect(treeBody.entries.map((entry) => entry.path)).not.toContain('notes/renamed.md');
    const audit = await readAuditRows(config.vaultRoot);
    expect(audit.map((row) => row.operation)).toEqual(['move', 'delete']);
    expect(String(audit[1].summary)).toContain('trash');
    await sessions.close();
  });

  it('moves folder subtrees and rekeys live sessions underneath them', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({ root: config.vaultRoot, defaultContent: '' });
    const nested = sessions.getSession('parent/folder/deep/live.md');
    const events: DocumentSessionEvent[] = [];
    nested.onEvent((event) => events.push(event));
    await nested.open();
    nested.ydoc.getText('markdown').insert(0, 'nested\n');
    await nested.flush();

    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });
    const moved = await app.request('/api/folders/parent/folder/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'parent/moved/folder' })
    });

    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({
      ok: true,
      fromPath: 'parent/folder',
      toPath: 'parent/moved/folder',
      liveMoved: ['parent/moved/folder/deep/live.md']
    });
    nested.ydoc.getText('markdown').insert(nested.ydoc.getText('markdown').length, 'after folder move\n');
    await nested.flush();

    await expect(readFile(join(config.vaultRoot, 'parent/moved/folder/deep/live.md'), 'utf8')).resolves.toBe('nested\nafter folder move\n');
    await expect(readFile(join(config.vaultRoot, 'parent/folder/deep/live.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'doc-moved',
      fromPath: 'parent/folder/deep/live.md',
      toPath: 'parent/moved/folder/deep/live.md'
    }));
    await sessions.close();
  });

  it('routes live whole-file writes through the open session', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({ root: config.vaultRoot, defaultContent: 'old\n' });
    const session = sessions.getSession('live-write.md');
    await session.open();
    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });

    const noClobber = await app.request('/api/files/live-write.md', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'should not clobber\n' })
    });
    expect(noClobber.status).toBe(409);
    await expect(noClobber.json()).resolves.toMatchObject({ ok: false, error: 'already_exists' });
    await expect(readFile(join(config.vaultRoot, 'live-write.md'), 'utf8')).resolves.toBe('old\n');

    const response = await app.request('/api/files/live-write.md?overwrite=true', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'new through session\n' })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, path: 'live-write.md', live: true, content: 'new through session\n' });
    await expect(readFile(join(config.vaultRoot, 'live-write.md'), 'utf8')).resolves.toBe('new through session\n');
    const audit = await readAuditRows(config.vaultRoot);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operation: 'write', entityKind: 'file', path: 'live-write.md', actor: { kind: 'user' } });
    await sessions.close();
  });

  it('keeps live move failures classified and resumes old-path watching', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({
      root: config.vaultRoot,
      defaultContent: '',
      watchDebounceMs: 10,
      watchPollMs: 50
    });
    const session = sessions.getSession('notes/live-fail.md');
    const events: DocumentSessionEvent[] = [];
    session.onEvent((event) => events.push(event));
    await session.open();
    session.ydoc.getText('markdown').insert(0, 'live before failure\n');
    await session.flush();
    await writeFile(join(config.vaultRoot, 'notes/target.md'), 'existing target\n', 'utf8');

    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });
    const failedMove = await app.request('/api/files/notes/live-fail.md/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'notes/target.md' })
    });
    expect(failedMove.status).toBe(409);
    await expect(failedMove.json()).resolves.toMatchObject({ ok: false, error: 'path_collision' });

    await writeFile(join(config.vaultRoot, 'notes/live-fail.md'), 'external after failed move\n', 'utf8');
    await waitUntil(async () => await session.getContent() === 'external after failed move\n', () =>
      `Timed out waiting for watcher recovery; content=${session.ydoc.getText('markdown').toString()}`
    );
    expect(events).toContainEqual(expect.objectContaining({ kind: 'external-merge' }));
    expect(sessions.getOpenSession('notes/live-fail.md')).toBe(session);
    await sessions.close();
  });

  it('covers vault info and non-live folder route branches', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot });

    const mkdirResponse = await app.request('/api/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'folder' })
    });
    expect(mkdirResponse.status).toBe(201);
    await expect(mkdirResponse.json()).resolves.toMatchObject({ ok: true, path: 'folder' });

    await app.request('/api/files/folder/file.md', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'x'
    });
    const blockedDelete = await app.request('/api/folders/folder', { method: 'DELETE' });
    expect(blockedDelete.status).toBe(409);
    await expect(blockedDelete.json()).resolves.toMatchObject({ ok: false, error: 'folder_not_empty' });

    const moved = await app.request('/api/folders/folder/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'moved/folder' })
    });
    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({ ok: true, fromPath: 'folder', toPath: 'moved/folder' });

    const deleted = await app.request('/api/folders/moved/folder?recursive=true', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ ok: true, path: 'moved/folder' });

    const info = await app.request('/api/vault');
    expect(info.status).toBe(200);
    await expect(info.json()).resolves.toMatchObject({ ok: true, rootName: 'demo-vault' });

    const missing = await app.request('/api/files/missing.md/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'next.md' })
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ ok: false, error: 'not_found' });
  });

  it('proxies non-API requests to the configured Vite dev server', async () => {
    const upstream = createServer((request, response) => {
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end(`proxied ${request.method} ${request.url}`);
    });
    await listen(upstream);
    const port = (upstream.address() as AddressInfo).port;

    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home
      }
    });
    const app = createApp({
      statusFile: config.statusFile,
      webProxyTarget: `http://127.0.0.1:${port}`
    });

    const rootResponse = await app.request('/');
    const clientRouteResponse = await app.request('/status?from=test');

    expect(rootResponse.status).toBe(200);
    await expect(rootResponse.text()).resolves.toBe('proxied GET /');

    expect(clientRouteResponse.status).toBe(200);
    await expect(clientRouteResponse.text()).resolves.toBe('proxied GET /status?from=test');

    await close(upstream);
  });

  it('returns an instructional response when no UI build is available', async () => {
    const webBuildDir = await mkdtemp(join(tmpdir(), 'kb2-web-build-missing-'));
    const config = createDaemonConfig({
      env: {
        KB2_HOME: kb2Home
      }
    });
    const app = createApp({ statusFile: config.statusFile, webBuildDir });

    const response = await app.request('/');
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain('KB-2 local UI is not built yet.');
    expect(body).toContain('pnpm dev');

    await rm(webBuildDir, { force: true, recursive: true });
  });
});

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

async function readAuditRows(root: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(join(root, '.kb2/audit/changes.jsonl'), 'utf8');
  return content.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  errorMessage: () => string,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(errorMessage());
}
