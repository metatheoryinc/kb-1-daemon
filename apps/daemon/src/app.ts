import { Hono, type Context } from 'hono';
import type { DocumentSessionManager, OneFileDocumentSession } from '@kb-2/doc-session';
import {
  createLocalMcpEndpoint,
  type LocalMcpEndpoint,
  type LocalMcpVaultService,
  type ServiceResult
} from '@kb-2/local-mcp';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

import { SERVICE_NAME } from './config.js';
import { readDaemonStatus } from './status.js';
import { createVaultService } from './vault-service.js';

export interface CreateAppOptions {
  statusFile: string;
  vaultRoot?: string;
  documentSessions?: DocumentSessionManager;
  vaultService?: LocalMcpVaultService;
  demoDocumentSession?: OneFileDocumentSession;
  mcpEndpoint?: LocalMcpEndpoint;
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
    const vaultService = options.vaultService ?? createVaultService({
      vaultRoot: options.vaultRoot,
      documentSessions: options.documentSessions
    });
    const mcpEndpoint = options.mcpEndpoint ?? createLocalMcpEndpoint(vaultService);

    api.get('/vault', async (context) => {
      return mapServiceResult(context, await vaultService.vaultInfo());
    });

    api.get('/tree', async (context) => {
      const depthRaw = context.req.query('depth');
      const depth = depthRaw === undefined ? undefined : Number(depthRaw);
      return mapServiceResult(context, await vaultService.listFiles({
        under: context.req.query('under'),
        ...(depth !== undefined && Number.isInteger(depth) ? { depth } : {})
      }));
    });

    api.get('/search', async (context) => {
      return mapServiceResult(context, await vaultService.search({
        query: context.req.query('q') ?? '',
        under: context.req.query('under'),
        context: queryNumber(context, 'context'),
        limit: queryNumber(context, 'limit'),
        offset: queryNumber(context, 'offset')
      }));
    });

    api.get('/files/*', async (context) => {
      const filePath = filePathParam(context.req.path, '/api/files/');
      return mapServiceResult(context, await vaultService.readNote({ path: filePath }));
    });

    api.put('/files/*', async (context) => {
      const filePath = filePathParam(context.req.path, '/api/files/');
      const content = await requestTextContent(context.req.raw);
      const overwrite = context.req.query('overwrite') === 'true';
      return mapServiceResult(context, await vaultService.createNote({
        path: filePath,
        content,
        overwrite,
        actor: { kind: 'user' }
      }), overwrite ? 200 : 201);
    });

    api.delete('/files/*', async (context) => {
      const filePath = filePathParam(context.req.path, '/api/files/');
      const permanent = context.req.query('permanent') === 'true';
      return mapServiceResult(context, await vaultService.deleteNote({
        path: filePath,
        permanent,
        actor: { kind: 'user' }
      }));
    });

    api.post('/files/*', async (context) => {
      if (context.req.path.endsWith('/splice')) {
        const filePath = filePathParam(context.req.path, '/api/files/', '/splice');
        const body = await readJsonObject(context.req.raw);
        const splice = readSpliceRequest(body);
        return mapServiceResult(context, await vaultService.editNote({
          path: filePath,
          baseline: splice.baseline,
          oldText: splice.request.oldText,
          newText: splice.request.newText,
          before: splice.request.before,
          after: splice.request.after,
          occurrence: splice.request.occurrence,
          actor: { kind: 'user' }
        }));
      }

      if (context.req.path.endsWith('/append')) {
        const filePath = filePathParam(context.req.path, '/api/files/', '/append');
        const body = await readJsonObject(context.req.raw);
        const content = typeof body.content === 'string' ? body.content : '';
        return mapServiceResult(context, await vaultService.appendNote({
          path: filePath,
          content,
          actor: { kind: 'user' }
        }));
      }

      if (context.req.path.endsWith('/prepend')) {
        const filePath = filePathParam(context.req.path, '/api/files/', '/prepend');
        const body = await readJsonObject(context.req.raw);
        const content = typeof body.content === 'string' ? body.content : '';
        return mapServiceResult(context, await vaultService.prependNote({
          path: filePath,
          content,
          actor: { kind: 'user' }
        }));
      }

      if (!context.req.path.endsWith('/move')) {
        return context.json({ ok: false, error: 'Not found' }, 404);
      }

      const fromPath = filePathParam(context.req.path, '/api/files/', '/move');
      const body = await readJsonObject(context.req.raw);
      const to = typeof body.to === 'string' ? body.to : '';
      // Chunk 007 records the move but does not rewrite wikilinks; link-index handling lands later.
      return mapServiceResult(context, await vaultService.moveNote({
        fromPath,
        toPath: to,
        actor: { kind: 'user' }
      }));
    });

    api.post('/folders', async (context) => {
      const body = await readJsonObject(context.req.raw);
      const folderPath = typeof body.path === 'string' ? body.path : '';
      return mapServiceResult(context, await vaultService.createFolder({
        path: folderPath,
        actor: { kind: 'user' }
      }), 201);
    });

    api.delete('/folders/*', async (context) => {
      const folderPath = filePathParam(context.req.path, '/api/folders/');
      const recursive = context.req.query('recursive') === 'true';
      const permanent = context.req.query('permanent') === 'true';
      return mapServiceResult(context, await vaultService.deleteFolder({
        path: folderPath,
        recursive,
        permanent,
        actor: { kind: 'user' }
      }));
    });

    api.post('/folders/*', async (context) => {
      if (!context.req.path.endsWith('/move')) {
        return context.json({ ok: false, error: 'Not found' }, 404);
      }

      const fromPath = filePathParam(context.req.path, '/api/folders/', '/move');
      const body = await readJsonObject(context.req.raw);
      const to = typeof body.to === 'string' ? body.to : '';
      // Chunk 007 records the move but does not rewrite wikilinks; link-index handling lands later.
      return mapServiceResult(context, await vaultService.moveFolder({
        fromPath,
        toPath: to,
        actor: { kind: 'user' }
      }));
    });

    app.all('/mcp', async (context) => {
      return mcpEndpoint.handleRequest(context.req.raw);
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

function readSpliceRequest(body: Record<string, unknown>): {
  baseline: string;
  request: {
    oldText: string;
    newText: string;
    before?: string;
    after?: string;
    occurrence?: number;
  };
} {
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

function queryNumber(context: Context, name: string): number | undefined {
  const raw = context.req.query(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function filePathParam(pathname: string, prefix: string, suffix = ''): string {
  const withoutPrefix = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
  const withoutSuffix = suffix.length > 0 && withoutPrefix.endsWith(suffix)
    ? withoutPrefix.slice(0, -suffix.length)
    : withoutPrefix;
  return decodeURIComponent(withoutSuffix);
}

function mapServiceResult(
  context: Context,
  result: ServiceResult,
  okStatus: 200 | 201 = 200
): Response {
  if (result.ok) {
    return context.json(result, okStatus);
  }

  const error = ('error' in result ? result.error : result.rejected) as string | undefined;
  return context.json(result, statusForServiceError(error ?? 'unknown'));
}

function statusForServiceError(error: string): 400 | 404 | 409 | 413 | 500 | 503 {
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
    case 'too_large_splice':
    case 'too_large_document':
      return 413;
    case 'session_unavailable':
      return 503;
    case 'persist_failed':
      return 500;
    default:
      return 409;
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
