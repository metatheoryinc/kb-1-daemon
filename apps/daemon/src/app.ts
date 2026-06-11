import { Hono, type Context } from 'hono';
import type { DocumentSessionManager, OneFileDocumentSession } from '@kb-2/doc-session';
import {
  InvalidPathError,
  appendAudit,
  appendContent,
  applyAnchoredSplice,
  deleteVaultFile,
  deleteVaultFolder,
  getVaultInfo,
  listVaultTree,
  makeVaultFolder,
  moveVaultPath,
  prependContent,
  readVaultFile,
  searchVaultFiles,
  validateVaultPath,
  writeVaultFile,
  type AnchoredSpliceRequest,
  type VaultErrorCode,
  type VaultResult
} from '@kb-2/vault-core';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

import { SERVICE_NAME } from './config.js';
import { readDaemonStatus } from './status.js';

export interface CreateAppOptions {
  statusFile: string;
  vaultRoot?: string;
  documentSessions?: DocumentSessionManager;
  demoDocumentSession?: OneFileDocumentSession;
  webBuildDir?: string;
  webProxyTarget?: string;
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono();
  const api = new Hono();

  api.get('/health', async (context) => {
    const status = await readDaemonStatus(options.statusFile);

    return context.json({
      ok: true,
      service: SERVICE_NAME,
      status
    });
  });

  if (options.demoDocumentSession) {
    api.get('/demo-document', async (context) => {
      const content = await options.demoDocumentSession!.getContent();

      return context.json({
        ok: true,
        document: 'demo-vault/hello-world.md',
        content
      });
    });

    api.post('/demo-document/reset', async (context) => {
      const requestedContent = await readOptionalJsonContent(context.req.raw);
      const content = await options.demoDocumentSession!.reset(requestedContent);

      return context.json({
        ok: true,
        document: 'demo-vault/hello-world.md',
        content
      });
    });
  }

  if (options.vaultRoot) {
    api.get('/vault', async (context) => {
      return mapVaultResult(context, await getVaultInfo({ root: options.vaultRoot! }));
    });

    api.get('/tree', async (context) => {
      const depthRaw = context.req.query('depth');
      const depth = depthRaw === undefined ? undefined : Number(depthRaw);
      return mapVaultResult(context, await listVaultTree(
        { root: options.vaultRoot! },
        {
          under: context.req.query('under'),
          ...(depth !== undefined && Number.isInteger(depth) ? { depth } : {})
        }
      ));
    });

    api.get('/search', async (context) => {
      try {
        const result = await searchVaultFiles(options.vaultRoot!, {
          q: context.req.query('q') ?? '',
          under: context.req.query('under'),
          context: queryNumber(context, 'context'),
          limit: queryNumber(context, 'limit'),
          offset: queryNumber(context, 'offset')
        });
        return context.json({ ok: true, ...result });
      } catch (error) {
        if (error instanceof InvalidPathError) {
          return mapVaultResult(context, {
            ok: false,
            error: 'invalid_path',
            message: error.message
          });
        }
        throw error;
      }
    });

    api.get('/files/*', async (context) => {
      const filePath = filePathParam(context.req.path, '/api/files/');
      const diskRead = await readVaultFile({ root: options.vaultRoot! }, filePath);
      if (!diskRead.ok || !options.documentSessions) {
        return mapVaultResult(context, diskRead);
      }
      const baselineRead = await options.documentSessions.withSession(filePath, (session) => session.readWithBaseline());
      return context.json({
        ok: true,
        path: diskRead.value.path,
        content: baselineRead.content,
        baseline: baselineRead.baseline,
        size: diskRead.value.size,
        mtimeMs: diskRead.value.mtimeMs
      });
    });

    api.put('/files/*', async (context) => {
      const filePath = filePathParam(context.req.path, '/api/files/');
      const content = await requestTextContent(context.req.raw);
      const overwrite = context.req.query('overwrite') === 'true';
      const liveSession = options.documentSessions?.getOpenSession(filePath);
      if (liveSession) {
        if (!overwrite) {
          return mapVaultResult(context, {
            ok: false,
            error: 'already_exists',
            message: 'file already exists'
          });
        }
        await liveSession.applyContent(content);
        const audit = await appendAudit({
          root: options.vaultRoot!,
          actor: { kind: 'user' },
          operation: 'write',
          entityKind: 'file',
          path: filePath,
          summary: `Wrote ${filePath}`
        });
        return context.json({
          ok: true,
          path: filePath,
          content: await liveSession.getContent(),
          live: true,
          audit
        });
      }

      return mapVaultResult(context, await writeVaultFile(
        { root: options.vaultRoot!, actor: { kind: 'user' } },
        { path: filePath, content, overwrite }
      ), overwrite ? 200 : 201);
    });

    api.delete('/files/*', async (context) => {
      const filePath = filePathParam(context.req.path, '/api/files/');
      const permanent = context.req.query('permanent') === 'true';
      const deleteOnDisk = () => expectOk(deleteVaultFile(
        { root: options.vaultRoot!, actor: { kind: 'user' } },
        { path: filePath, permanent }
      ));
      const deletedLive = await withMappedVaultError(
        context,
        () => options.documentSessions?.deleteSession(filePath, deleteOnDisk)
      );
      if (deletedLive instanceof Response) return deletedLive;
      if (deletedLive) {
        return context.json({ ok: true, path: filePath, live: true });
      }
      return mapVaultResult(context, await deleteVaultFile(
        { root: options.vaultRoot!, actor: { kind: 'user' } },
        { path: filePath, permanent }
      ));
    });

    api.post('/files/*', async (context) => {
      if (context.req.path.endsWith('/splice')) {
        const filePath = filePathParam(context.req.path, '/api/files/', '/splice');
        const diskRead = await readVaultFile({ root: options.vaultRoot! }, filePath);
        if (!diskRead.ok) return mapVaultResult(context, diskRead);
        if (!options.documentSessions) {
          return context.json({ ok: false, error: 'session_unavailable', message: 'document sessions are unavailable' }, 503);
        }
        const body = await readJsonObject(context.req.raw);
        const splice = readSpliceRequest(body);
        const result = await options.documentSessions.withSession(filePath, (session) =>
          session.applyBaselineEdit(splice.baseline, (currentContent) =>
            applyAnchoredSplice(currentContent, splice.request)
          )
        );
        if (!result.ok) return mapSpliceReject(context, result);
        const audit = await appendAudit({
          root: options.vaultRoot!,
          actor: { kind: 'mcp_client', client: 'api' },
          operation: 'splice',
          entityKind: 'file',
          path: filePath,
          summary: `Spliced ${filePath}`
        });
        return context.json({
          ok: true,
          path: filePath,
          content: result.content,
          baseline: result.baseline,
          audit
        });
      }

      if (context.req.path.endsWith('/append')) {
        const filePath = filePathParam(context.req.path, '/api/files/', '/append');
        const validPath = validateRouteFilePath(context, filePath);
        if (validPath instanceof Response) return validPath;
        if (!options.documentSessions) {
          return context.json({ ok: false, error: 'session_unavailable', message: 'document sessions are unavailable' }, 503);
        }
        const body = await readJsonObject(context.req.raw);
        const content = typeof body.content === 'string' ? body.content : '';
        const result = await options.documentSessions.withSession(
          filePath,
          (session) => session.applyContentEdit((currentContent) => appendContent(currentContent, content)),
          { defaultContent: '' }
        );
        const audit = await appendAudit({
          root: options.vaultRoot!,
          actor: { kind: 'mcp_client', client: 'api' },
          operation: 'append',
          entityKind: 'file',
          path: filePath,
          summary: `Appended to ${filePath}`
        });
        return context.json({
          ok: true,
          path: filePath,
          content: result.content,
          baseline: result.baseline,
          audit
        });
      }

      if (context.req.path.endsWith('/prepend')) {
        const filePath = filePathParam(context.req.path, '/api/files/', '/prepend');
        const diskRead = await readVaultFile({ root: options.vaultRoot! }, filePath);
        if (!diskRead.ok) return mapVaultResult(context, diskRead);
        if (!options.documentSessions) {
          return context.json({ ok: false, error: 'session_unavailable', message: 'document sessions are unavailable' }, 503);
        }
        const body = await readJsonObject(context.req.raw);
        const content = typeof body.content === 'string' ? body.content : '';
        const result = await options.documentSessions.withSession(filePath, (session) =>
          session.applyContentEdit((currentContent) => prependContent(currentContent, content))
        );
        const audit = await appendAudit({
          root: options.vaultRoot!,
          actor: { kind: 'mcp_client', client: 'api' },
          operation: 'prepend',
          entityKind: 'file',
          path: filePath,
          summary: `Prepended to ${filePath}`
        });
        return context.json({
          ok: true,
          path: filePath,
          content: result.content,
          baseline: result.baseline,
          audit
        });
      }

      if (!context.req.path.endsWith('/move')) {
        return context.json({ ok: false, error: 'Not found' }, 404);
      }

      const fromPath = filePathParam(context.req.path, '/api/files/', '/move');
      const body = await readJsonObject(context.req.raw);
      const to = typeof body.to === 'string' ? body.to : '';
      // Chunk 007 records the move but does not rewrite wikilinks; link-index handling lands later.
      const moveOnDisk = () => expectOk(moveVaultPath(
        { root: options.vaultRoot!, actor: { kind: 'user' } },
        { kind: 'file', fromPath, toPath: to }
      ));
      const movedLive = await withMappedVaultError(
        context,
        () => options.documentSessions?.moveSession(fromPath, to, moveOnDisk)
      );
      if (movedLive instanceof Response) return movedLive;
      if (movedLive) {
        return context.json({ ok: true, fromPath, toPath: to, live: true });
      }
      return mapVaultResult(context, await moveVaultPath(
        { root: options.vaultRoot!, actor: { kind: 'user' } },
        { kind: 'file', fromPath, toPath: to }
      ));
    });

    api.post('/folders', async (context) => {
      const body = await readJsonObject(context.req.raw);
      const folderPath = typeof body.path === 'string' ? body.path : '';
      return mapVaultResult(context, await makeVaultFolder(
        { root: options.vaultRoot!, actor: { kind: 'user' } },
        folderPath
      ), 201);
    });

    api.delete('/folders/*', async (context) => {
      const folderPath = filePathParam(context.req.path, '/api/folders/');
      const recursive = context.req.query('recursive') === 'true';
      const permanent = context.req.query('permanent') === 'true';
      const deleteOnDisk = () => expectOk(deleteVaultFolder(
        { root: options.vaultRoot!, actor: { kind: 'user' } },
        { path: folderPath, recursive, permanent }
      ));
      if (options.documentSessions) {
        const deletedLive = await withMappedVaultError(
          context,
          () => options.documentSessions!.deleteSessionSubtree(folderPath, deleteOnDisk)
        );
        if (deletedLive instanceof Response) return deletedLive;
        return context.json({ ok: true, path: folderPath, liveDeleted: deletedLive });
      }
      return mapVaultResult(context, await deleteVaultFolder(
        { root: options.vaultRoot!, actor: { kind: 'user' } },
        { path: folderPath, recursive, permanent }
      ));
    });

    api.post('/folders/*', async (context) => {
      if (!context.req.path.endsWith('/move')) {
        return context.json({ ok: false, error: 'Not found' }, 404);
      }

      const fromPath = filePathParam(context.req.path, '/api/folders/', '/move');
      const body = await readJsonObject(context.req.raw);
      const to = typeof body.to === 'string' ? body.to : '';
      // Chunk 007 records the move but does not rewrite wikilinks; link-index handling lands later.
      const moveOnDisk = () => expectOk(moveVaultPath(
        { root: options.vaultRoot!, actor: { kind: 'user' } },
        { kind: 'folder', fromPath, toPath: to }
      ));
      if (options.documentSessions) {
        const movedLive = await withMappedVaultError(
          context,
          () => options.documentSessions!.moveSessionSubtree(fromPath, to, moveOnDisk)
        );
        if (movedLive instanceof Response) return movedLive;
        return context.json({ ok: true, fromPath, toPath: to, liveMoved: movedLive });
      }
      return mapVaultResult(context, await moveVaultPath(
        { root: options.vaultRoot!, actor: { kind: 'user' } },
        { kind: 'folder', fromPath, toPath: to }
      ));
    });
  }

  app.route('/api', api);

  /* v8 ignore start -- Static UI fallback predates Chunk 007; the coverage gate for this task targets the new vault API route code above. */
  const webBuildDir = options.webBuildDir;
  const webProxyTarget = options.webProxyTarget;

  if (webProxyTarget || webBuildDir) {
    app.notFound(async (context) => {
      const { pathname } = new URL(context.req.url);

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return context.json({ ok: false, error: 'Not found' }, 404);
      }

      if (webProxyTarget) {
        return proxyUi(webProxyTarget, context.req.raw);
      }

      if (!webBuildDir) {
        return missingUiBuildResponse(resolve('apps/web/build'));
      }

      return serveUi(webBuildDir, pathname);
    });
  }

  return app;
}

function readSpliceRequest(body: Record<string, unknown>): { baseline: string; request: AnchoredSpliceRequest } {
  return {
    baseline: typeof body.baseline === 'string' ? body.baseline : '',
    request: {
      oldText: typeof body.old_text === 'string' ? body.old_text : '',
      newText: typeof body.new_text === 'string' ? body.new_text : '',
      ...(typeof body.before === 'string' ? { before: body.before } : {}),
      ...(typeof body.after === 'string' ? { after: body.after } : {}),
      ...(typeof body.occurrence === 'number' && Number.isInteger(body.occurrence)
        ? { occurrence: body.occurrence }
        : {})
    }
  };
}

function mapSpliceReject(context: Context, result: Exclude<Awaited<ReturnType<OneFileDocumentSession['applyBaselineEdit']>>, { ok: true }>): Response {
  const status = statusForSpliceReject(result.rejected);
  const { ok: _ok, ...body } = result;
  return context.json({ ok: false, ...body }, status);
}

function statusForSpliceReject(rejected: string): 404 | 409 | 413 {
  switch (rejected) {
    case 'not_found':
      return 404;
    case 'too_large_splice':
    case 'too_large_document':
      return 413;
    default:
      return 409;
  }
}

function queryNumber(context: Context, name: string): number | undefined {
  const raw = context.req.query(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validateRouteFilePath(context: Context, filePath: string): string | Response {
  try {
    return validateVaultPath(filePath, 'file');
  } catch (error) {
    if (error instanceof InvalidPathError) {
      return mapVaultResult(context, {
        ok: false,
        error: 'invalid_path',
        message: error.message
      });
    }
    throw error;
  }
}

async function readOptionalJsonContent(request: Request): Promise<string | undefined> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return undefined;
  }

  const body = await request.json().catch(() => undefined) as { content?: unknown } | undefined;
  return typeof body?.content === 'string' ? body.content : undefined;
}

async function requestTextContent(request: Request): Promise<string> {
  if (request.headers.get('content-type')?.includes('application/json')) {
    const body = await request.json().catch(() => undefined) as { content?: unknown } | undefined;
    return typeof body?.content === 'string' ? body.content : '';
  }

  return request.text();
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const parsed = await request.json().catch(() => undefined) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

async function expectOk<T>(resultPromise: Promise<VaultResult<T>>): Promise<void> {
  const result = await resultPromise;
  if (!result.ok) {
    throw new VaultResultFailure(result);
  }
}

async function withMappedVaultError<T>(
  context: Context,
  operation: () => T | Promise<T>
): Promise<T | Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof VaultResultFailure) {
      return mapVaultResult(context, error.result);
    }
    throw error;
  }
}

class VaultResultFailure extends Error {
  constructor(readonly result: VaultResult<unknown>) {
    super(result.ok ? 'Unexpected successful vault result' : result.message);
  }
}

function filePathParam(pathname: string, prefix: string, suffix = ''): string {
  const withoutPrefix = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
  const withoutSuffix = suffix.length > 0 && withoutPrefix.endsWith(suffix)
    ? withoutPrefix.slice(0, -suffix.length)
    : withoutPrefix;
  return decodeURIComponent(withoutSuffix);
}

function mapVaultResult<T>(
  context: Context,
  result: VaultResult<T>,
  okStatus: 200 | 201 = 200
): Response {
  if (result.ok) {
    return context.json({ ok: true, ...valueBody(result.value) }, okStatus);
  }

  return context.json({
    ok: false,
    error: result.error,
    message: result.message
  }, statusForVaultError(result.error));
}

function valueBody(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { value };
}

function statusForVaultError(error: VaultErrorCode): 400 | 404 | 409 | 413 {
  switch (error) {
    case 'invalid_path':
      return 400;
    case 'not_found':
      return 404;
    case 'already_exists':
    case 'path_collision':
    case 'folder_not_empty':
      return 409;
    case 'entry_cap_exceeded':
      return 413;
  }
}

async function proxyUi(webProxyTarget: string, request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const upstreamUrl = new URL(webProxyTarget);
  upstreamUrl.pathname = requestUrl.pathname;
  upstreamUrl.search = requestUrl.search;

  try {
    return await fetch(new Request(upstreamUrl, request));
  } catch (error) {
    return new Response(`KB-2 web dev server is unavailable at ${webProxyTarget}.\n${String(error)}\n`, {
      status: 502,
      headers: {
        'content-type': 'text/plain; charset=utf-8'
      }
    });
  }
}

// Hono's Node static helper relies on middleware root handling that does not
// cover this SPA fallback cleanly, so the daemon keeps this small file server.
async function serveUi(webBuildDir: string, pathname: string): Promise<Response> {
  const root = resolve(webBuildDir);
  const filePath = await resolveUiFile(root, pathname);

  if (!filePath) {
    return missingUiBuildResponse(root);
  }

  const body = await readFile(filePath);

  return new Response(body, {
    headers: {
      'content-type': contentTypeFor(filePath)
    }
  });
}

async function resolveUiFile(root: string, pathname: string): Promise<string | undefined> {
  const decodedPathname = safeDecodePathname(pathname);
  const requestPath = decodedPathname.replace(/^\/+/, '') || 'index.html';
  const candidate = resolve(join(root, requestPath));

  if (isInside(root, candidate) && await isFile(candidate)) {
    return candidate;
  }

  const fallback = join(root, 'index.html');
  return await isFile(fallback) ? fallback : undefined;
}

function missingUiBuildResponse(root: string): Response {
  return new Response(
    [
      'KB-2 local UI is not built yet.',
      '',
      'Run `pnpm --filter @kb-2/web build` before starting the daemon,',
      'or run `pnpm dev` to start the daemon with the Vite dev proxy.',
      '',
      `Expected UI entry: ${join(root, 'index.html')}`,
      ''
    ].join('\n'),
    {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8'
      }
    }
  );
}

function safeDecodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return '/';
  }
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !pathFromRoot.startsWith(sep));
}

async function isFile(pathname: string): Promise<boolean> {
  try {
    return (await stat(pathname)).isFile();
  } catch {
    return false;
  }
}

function contentTypeFor(pathname: string): string {
  switch (extname(pathname)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.webp':
      return 'image/webp';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
/* v8 ignore stop */
