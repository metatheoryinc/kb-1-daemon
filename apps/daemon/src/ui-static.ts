import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

export async function proxyUi(webProxyTarget: string, request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const upstreamUrl = new URL(webProxyTarget);
  upstreamUrl.pathname = requestUrl.pathname;
  upstreamUrl.search = requestUrl.search;

  try {
    return await fetch(new Request(upstreamUrl, request));
  } catch (error) {
    return new Response(`KB-1 web dev server is unavailable at ${webProxyTarget}.\n${String(error)}\n`, {
      status: 502,
      headers: {
        'content-type': 'text/plain; charset=utf-8'
      }
    });
  }
}

// Hono's Node static helper relies on middleware root handling that does not
// cover this SPA fallback cleanly, so the daemon keeps this small file server.
export async function serveUi(webBuildDir: string, pathname: string): Promise<Response> {
  const root = resolve(webBuildDir);
  const filePath = await resolveUiFile(root, pathname);

  if (!filePath) {
    return missingUiBuildResponse(root);
  }

  const body = await readFile(filePath);

  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': contentTypeFor(filePath)
    }
  });
}

export function missingUiBuildResponse(root: string): Response {
  return new Response(
    [
      'KB-1 local UI is not built yet.',
      '',
      'Run `pnpm --filter @kb-1/web build` before starting the daemon,',
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
