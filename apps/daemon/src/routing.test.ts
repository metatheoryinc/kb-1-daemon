import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { DocumentSessionManager, OneFileDocumentSession, type DocumentSessionEvent } from '@kb-2/doc-session';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Hono } from 'hono';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as Y from 'yjs';

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

  it('moves zero-live folder subtrees through the production session manager once', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({ root: config.vaultRoot, defaultContent: '' });
    await mkdir(join(config.vaultRoot, 'emptydir'), { recursive: true });

    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });
    const moved = await app.request('/api/folders/emptydir/move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'moved/emptydir' })
    });

    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({
      ok: true,
      fromPath: 'emptydir',
      toPath: 'moved/emptydir',
      liveMoved: []
    });
    expect((await stat(join(config.vaultRoot, 'moved/emptydir'))).isDirectory()).toBe(true);
    await expect(stat(join(config.vaultRoot, 'emptydir'))).rejects.toMatchObject({ code: 'ENOENT' });
    const audit = await readAuditRows(config.vaultRoot);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operation: 'move', entityKind: 'folder', fromPath: 'emptydir', toPath: 'moved/emptydir' });
    await sessions.close();
  });

  it('deletes zero-live folder subtrees through the production session manager once', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({ root: config.vaultRoot, defaultContent: '' });
    await mkdir(join(config.vaultRoot, 'emptydir'), { recursive: true });

    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });
    const deleted = await app.request('/api/folders/emptydir', { method: 'DELETE' });

    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ ok: true, path: 'emptydir', liveDeleted: [] });
    await expect(stat(join(config.vaultRoot, 'emptydir'))).rejects.toMatchObject({ code: 'ENOENT' });
    const audit = await readAuditRows(config.vaultRoot);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operation: 'delete', entityKind: 'folder', path: 'emptydir' });
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

  it('routes live whole-file writes through a fast-diff session merge', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({ root: config.vaultRoot, defaultContent: 'alpha\nomega\n' });
    const session = sessions.getSession('live-merge.md');
    await session.open();

    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(session.ydoc), session);
    const clientText = clientDoc.getText('markdown');
    clientText.insert('alpha\n'.length, 'typed concurrently\n');
    const inFlightUpdate = Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(session.ydoc));

    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });
    const response = await app.request('/api/files/live-merge.md?overwrite=true', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'alpha\nservice write\nomega\n' })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      path: 'live-merge.md',
      live: true,
      content: 'alpha\nservice write\nomega\n'
    });

    Y.applyUpdate(session.ydoc, inFlightUpdate, clientDoc);
    await session.flush();

    const mergedContent = await readFile(join(config.vaultRoot, 'live-merge.md'), 'utf8');
    expect([
      'alpha\ntyped concurrently\nservice write\nomega\n',
      'alpha\nservice write\ntyped concurrently\nomega\n'
    ]).toContain(mergedContent);
    const audit = await readAuditRows(config.vaultRoot);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operation: 'write', entityKind: 'file', path: 'live-merge.md' });
    await sessions.close();
  });

  it('serves baselines and applies agent splice with stale retry through live sessions', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({ root: config.vaultRoot, defaultContent: '' });
    await writeFileWithParents(join(config.vaultRoot, 'notes', 'splice.md'), 'one two three\n');
    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });

    const read = await app.request('/api/files/notes/splice.md');
    expect(read.status).toBe(200);
    const readBody = await read.json() as { content: string; baseline: string };
    expect(readBody.content).toBe('one two three\n');
    expect(readBody.baseline.length).toBeGreaterThan(0);

    const firstSplice = await app.request('/api/files/notes/splice.md/splice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseline: readBody.baseline,
        old_text: 'two',
        new_text: 'TWO'
      })
    });
    expect(firstSplice.status).toBe(200);
    const firstBody = await firstSplice.json() as { content: string; baseline: string };
    expect(firstBody.content).toBe('one TWO three\n');
    await expect(readFile(join(config.vaultRoot, 'notes/splice.md'), 'utf8')).resolves.toBe('one TWO three\n');

    const stale = await app.request('/api/files/notes/splice.md/splice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseline: readBody.baseline,
        old_text: 'three',
        new_text: 'THREE'
      })
    });
    expect(stale.status).toBe(409);
    const staleBody = await stale.json() as { rejected: string; current_content: string; baseline: string };
    expect(staleBody).toMatchObject({
      rejected: 'stale_doc',
      current_content: 'one TWO three\n'
    });
    expect(staleBody.baseline).not.toBe(readBody.baseline);

    const retry = await app.request('/api/files/notes/splice.md/splice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseline: staleBody.baseline,
        old_text: 'three',
        new_text: 'THREE'
      })
    });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ ok: true, content: 'one TWO THREE\n' });
    await expect(readFile(join(config.vaultRoot, 'notes/splice.md'), 'utf8')).resolves.toBe('one TWO THREE\n');

    const audit = await readAuditRows(config.vaultRoot);
    expect(audit).toHaveLength(2);
    expect(audit.map((row) => row.operation)).toEqual(['splice', 'splice']);
    expect(audit.every((row) => (row.actor as { kind?: string }).kind === 'user')).toBe(true);
    await sessions.close();
  });

  it('exercises every MCP tool end-to-end through the SDK client with mcp_client audit attribution', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({ root: config.vaultRoot, defaultContent: '' });
    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });
    const { client, transport } = await connectMcpClient(app, 'daemon-sdk-test');

    await expect(mcpToolJson(client, 'create_note', { path: 'notes/a.md', content: 'alpha beta alpha\n' }))
      .resolves.toMatchObject({ ok: true, path: 'notes/a.md' });
    await expect(readFile(join(config.vaultRoot, 'notes/a.md'), 'utf8')).resolves.toBe('alpha beta alpha\n');

    await expect(mcpToolJson(client, 'vault_info', {})).resolves.toMatchObject({ ok: true, fileCount: 1 });
    await expect(mcpToolJson(client, 'list_files', { under: 'notes', depth: 1 }))
      .resolves.toMatchObject({ ok: true, entries: [{ path: 'notes/a.md', kind: 'file' }] });

    const read = await mcpToolJson(client, 'read_note', { path: 'notes/a.md' }) as { content: string; baseline: string };
    expect(read.content).toBe('alpha beta alpha\n');
    expect(read.baseline.length).toBeGreaterThan(0);

    await expect(mcpToolJson(client, 'edit_note', {
      path: 'notes/a.md',
      baseline: read.baseline,
      old_text: 'beta',
      new_text: 'BETA'
    })).resolves.toMatchObject({ ok: true, content: 'alpha BETA alpha\n' });
    await expect(readFile(join(config.vaultRoot, 'notes/a.md'), 'utf8')).resolves.toBe('alpha BETA alpha\n');

    const stale = await client.callTool({
      name: 'edit_note',
      arguments: {
        path: 'notes/a.md',
        baseline: read.baseline,
        old_text: 'alpha',
        new_text: 'ALPHA'
      }
    });
    expect(stale.isError).toBe(true);
    expect(mcpText(stale)).toContain('"rejected":"stale_doc"');
    expect(mcpText(stale)).toContain('"current_content":"alpha BETA alpha\\n"');
    expect(mcpText(stale)).toContain('"baseline"');

    const fresh = await mcpToolJson(client, 'read_note', { path: 'notes/a.md' }) as { baseline: string };
    const ambiguous = await client.callTool({
      name: 'edit_note',
      arguments: {
        path: 'notes/a.md',
        baseline: fresh.baseline,
        old_text: 'alpha',
        new_text: 'ALPHA'
      }
    });
    expect(ambiguous.isError).toBe(true);
    expect(mcpText(ambiguous)).toContain('"rejected":"ambiguous"');
    expect(mcpText(ambiguous)).toContain('"match_count":2');

    await expect(mcpToolJson(client, 'append_note', { path: 'notes/a.md', content: 'tail\n' }))
      .resolves.toMatchObject({ ok: true, content: 'alpha BETA alpha\ntail\n' });
    await expect(mcpToolJson(client, 'prepend_note', { path: 'notes/a.md', content: 'head\n' }))
      .resolves.toMatchObject({ ok: true, content: 'head\nalpha BETA alpha\ntail\n' });
    await expect(readFile(join(config.vaultRoot, 'notes/a.md'), 'utf8')).resolves.toBe('head\nalpha BETA alpha\ntail\n');

    await expect(mcpToolJson(client, 'create_folder', { path: 'moved' })).resolves.toMatchObject({ ok: true, path: 'moved' });
    await expect(mcpToolJson(client, 'move_note', { from_path: 'notes/a.md', to_path: 'moved/a.md' }))
      .resolves.toMatchObject({ ok: true, fromPath: 'notes/a.md', toPath: 'moved/a.md', live: true });
    await expect(readFile(join(config.vaultRoot, 'moved/a.md'), 'utf8')).resolves.toBe('head\nalpha BETA alpha\ntail\n');
    await expect(stat(join(config.vaultRoot, 'notes/a.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(mcpToolJson(client, 'move_folder', { from_path: 'moved', to_path: 'archived' }))
      .resolves.toMatchObject({ ok: true, fromPath: 'moved', toPath: 'archived', liveMoved: ['archived/a.md'] });
    await expect(readFile(join(config.vaultRoot, 'archived/a.md'), 'utf8')).resolves.toContain('BETA');

    await expect(mcpToolJson(client, 'search', { query: 'BETA', under: 'archived', context: 0 }))
      .resolves.toMatchObject({ ok: true, total: 1, results: [{ path: 'archived/a.md' }] });

    await expect(mcpToolJson(client, 'delete_note', { path: 'archived/a.md' }))
      .resolves.toMatchObject({ ok: true, path: 'archived/a.md', live: true });
    await expect(stat(join(config.vaultRoot, 'archived/a.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(mcpToolJson(client, 'delete_folder', { path: 'archived', recursive: true }))
      .resolves.toMatchObject({ ok: true, path: 'archived', liveDeleted: [] });
    await expect(stat(join(config.vaultRoot, 'archived'))).rejects.toMatchObject({ code: 'ENOENT' });

    const audit = await readAuditRows(config.vaultRoot);
    expect(audit.map((row) => row.operation)).toEqual([
      'create',
      'splice',
      'append',
      'prepend',
      'mkdir',
      'move',
      'move',
      'delete',
      'delete'
    ]);
    expect(audit.every((row) => {
      const actor = row.actor as { kind?: string; client?: string };
      return actor.kind === 'mcp_client' && actor.client === 'daemon-sdk-test';
    })).toBe(true);

    await transport.terminateSession();
    await sessions.close();
  });

  it('surfaces MCP persist failures without a success audit row and recovers the live session', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({ root: config.vaultRoot, defaultContent: '' });
    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });
    const { client, transport } = await connectMcpClient(app, 'mcp-persist-test');

    await expect(mcpToolJson(client, 'create_note', { path: 'notes/readonly.md', content: 'base\n' }))
      .resolves.toMatchObject({ ok: true, path: 'notes/readonly.md' });
    await mcpToolJson(client, 'read_note', { path: 'notes/readonly.md' });

    const beforeAudit = await readAuditRows(config.vaultRoot);
    await chmod(join(config.vaultRoot, 'notes'), 0o500);
    const failed = await client.callTool({
      name: 'append_note',
      arguments: { path: 'notes/readonly.md', content: 'unsaved\n' }
    });

    expect(failed.isError).toBe(true);
    expect(mcpText(failed)).toBe('append_note rejected: {"ok":false,"error":"persist_failed","message":"Document edit could not be durably saved to disk."}');
    await expect(readFile(join(config.vaultRoot, 'notes/readonly.md'), 'utf8')).resolves.toBe('base\n');
    expect(await readAuditRows(config.vaultRoot)).toHaveLength(beforeAudit.length);

    await chmod(join(config.vaultRoot, 'notes'), 0o700);
    await expect(mcpToolJson(client, 'append_note', { path: 'notes/readonly.md', content: 'recovered\n' }))
      .resolves.toMatchObject({ ok: true, content: 'base\nunsaved\nrecovered\n' });
    await expect(readFile(join(config.vaultRoot, 'notes/readonly.md'), 'utf8')).resolves.toBe('base\nunsaved\nrecovered\n');

    const audit = await readAuditRows(config.vaultRoot);
    expect(audit).toHaveLength(beforeAudit.length + 1);
    expect(audit.at(-1)).toMatchObject({
      operation: 'append',
      actor: { kind: 'mcp_client', client: 'mcp-persist-test' },
      path: 'notes/readonly.md'
    });

    await transport.terminateSession();
    await sessions.close();
  });

  it('applies anchored splice disambiguation and structured rejections', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({ root: config.vaultRoot, defaultContent: '' });
    await writeFileWithParents(join(config.vaultRoot, 'ambiguous.md'), 'foo bar foo baz foo');
    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });
    const read = await (await app.request('/api/files/ambiguous.md')).json() as { baseline: string };

    const ambiguous = await app.request('/api/files/ambiguous.md/splice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseline: read.baseline, old_text: 'foo', new_text: 'FOO' })
    });
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({ ok: false, rejected: 'ambiguous', match_count: 3 });

    const occurrence = await app.request('/api/files/ambiguous.md/splice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseline: read.baseline, old_text: 'foo', new_text: 'FOO', occurrence: 2 })
    });
    expect(occurrence.status).toBe(200);
    await expect(readFile(join(config.vaultRoot, 'ambiguous.md'), 'utf8')).resolves.toBe('foo bar FOO baz foo');

    const reread = await (await app.request('/api/files/ambiguous.md')).json() as { baseline: string };
    const notFound = await app.request('/api/files/ambiguous.md/splice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseline: reread.baseline, old_text: 'missing', new_text: 'x' })
    });
    expect(notFound.status).toBe(404);
    await expect(notFound.json()).resolves.toMatchObject({ ok: false, rejected: 'not_found' });
    await sessions.close();
  });

  it('appends missing files, prepends after frontmatter, searches with context, and does not audit search', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({ root: config.vaultRoot, defaultContent: '' });
    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });

    const append = await app.request('/api/files/notes/new.md/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'created by append\n' })
    });
    expect(append.status).toBe(200);
    await expect(append.json()).resolves.toMatchObject({ ok: true, path: 'notes/new.md', content: 'created by append\n' });
    await expect(readFile(join(config.vaultRoot, 'notes/new.md'), 'utf8')).resolves.toBe('created by append\n');

    await writeFileWithParents(join(config.vaultRoot, 'notes/front.md'), '---\ntitle: Front\n---\nbody\n');
    const prepend = await app.request('/api/files/notes/front.md/prepend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'inserted\n' })
    });
    expect(prepend.status).toBe(200);
    await expect(readFile(join(config.vaultRoot, 'notes/front.md'), 'utf8')).resolves.toBe(
      '---\ntitle: Front\n---\ninserted\nbody\n'
    );

    await writeFileWithParents(join(config.vaultRoot, 'notes/deep/search.md'), 'before\nneedle here\nafter\n');
    await writeFileWithParents(join(config.vaultRoot, '.kb2/trash/hidden.md'), 'needle hidden\n');
    const search = await app.request('/api/search?q=NEEDLE&under=notes&context=1&limit=5');
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      ok: true,
      total: 1,
      results: [{
        path: 'notes/deep/search.md',
        line: 2,
        lineText: 'needle here',
        context: { before: ['before'], after: ['after'] }
      }]
    });

    const audit = await readAuditRows(config.vaultRoot);
    expect(audit.map((row) => row.operation)).toEqual(['append', 'prepend']);
    await sessions.close();
  });

  it('surfaces live append persist failures without auditing or idle-dropping unsaved content, then recovers', async () => {
    const config = createDaemonConfig({ env: { KB2_HOME: kb2Home } });
    const sessions = new DocumentSessionManager({
      root: config.vaultRoot,
      defaultContent: '',
      idleSessionGraceMs: 30
    });
    await writeFileWithParents(join(config.vaultRoot, 'notes', 'readonly.md'), 'base\n');
    const hydrated = sessions.getSession('notes/readonly.md');
    await hydrated.open();
    const app = createApp({ statusFile: config.statusFile, vaultRoot: config.vaultRoot, documentSessions: sessions });
    const notesDir = join(config.vaultRoot, 'notes');

    await chmod(notesDir, 0o500);
    const failedAppend = await app.request('/api/files/notes/readonly.md/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'lost if dropped\n' })
    });

    expect(failedAppend.status).toBe(500);
    await expect(failedAppend.json()).resolves.toMatchObject({ ok: false, error: 'persist_failed' });
    await expect(readFile(join(config.vaultRoot, 'notes/readonly.md'), 'utf8')).resolves.toBe('base\n');
    await expect(readFile(join(config.vaultRoot, '.kb2/audit/changes.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(sessions.getOpenSession('notes/readonly.md')).toBe(hydrated);
    await expect(hydrated.getContent()).resolves.toBe('base\nlost if dropped\n');

    await chmod(notesDir, 0o700);
    const recoveredAppend = await app.request('/api/files/notes/readonly.md/append', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'after recovery\n' })
    });

    expect(recoveredAppend.status).toBe(200);
    await expect(recoveredAppend.json()).resolves.toMatchObject({
      ok: true,
      path: 'notes/readonly.md',
      content: 'base\nlost if dropped\nafter recovery\n'
    });
    await expect(readFile(join(config.vaultRoot, 'notes/readonly.md'), 'utf8')).resolves.toBe('base\nlost if dropped\nafter recovery\n');
    const audit = await readAuditRows(config.vaultRoot);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operation: 'append', path: 'notes/readonly.md' });
    expect(hydrated.getActivePersistFailureEvent()).toBeUndefined();
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

async function connectMcpClient(app: Hono, clientName: string): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const client = new Client({ name: clientName, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
    fetch: async (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init))
  });
  await client.connect(transport);
  return { client, transport };
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

async function writeFileWithParents(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
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
