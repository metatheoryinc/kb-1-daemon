import { Hono } from 'hono';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

import { SERVICE_NAME } from './config.js';
import { readDaemonStatus } from './status.js';

export interface CreateAppOptions {
  statusFile: string;
  webBuildDir?: string;
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

  app.route('/api', api);

  if (options.webBuildDir) {
    app.notFound(async (context) => {
      const { pathname } = new URL(context.req.url);

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return context.json({ ok: false, error: 'Not found' }, 404);
      }

      return serveUi(options.webBuildDir!, pathname);
    });
  }

  return app;
}

async function serveUi(webBuildDir: string, pathname: string): Promise<Response> {
  const root = resolve(webBuildDir);
  const filePath = await resolveUiFile(root, pathname);
  const body = await readFile(filePath);

  return new Response(body, {
    headers: {
      'content-type': contentTypeFor(filePath)
    }
  });
}

async function resolveUiFile(root: string, pathname: string): Promise<string> {
  const decodedPathname = safeDecodePathname(pathname);
  const requestPath = decodedPathname.replace(/^\/+/, '') || 'index.html';
  const candidate = resolve(join(root, requestPath));

  if (isInside(root, candidate) && await isFile(candidate)) {
    return candidate;
  }

  return join(root, 'index.html');
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
