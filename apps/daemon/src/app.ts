import { Hono } from 'hono';
import type { OneFileDocumentSession } from '@kb-2/doc-session';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

import { SERVICE_NAME } from './config.js';
import { readDaemonStatus } from './status.js';

export interface CreateAppOptions {
  statusFile: string;
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

  app.route('/api', api);

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

async function readOptionalJsonContent(request: Request): Promise<string | undefined> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return undefined;
  }

  const body = await request.json().catch(() => undefined) as { content?: unknown } | undefined;
  return typeof body?.content === 'string' ? body.content : undefined;
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
