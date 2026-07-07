import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { proxyUi, serveUi } from './ui-static.js';

describe('ui static helpers', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb1-ui-static-'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>fallback</title>', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('returns a clear 502 when the dev proxy target is unavailable', async () => {
    const response = await proxyUi('http://127.0.0.1:9', new Request('http://localhost/deep/path?q=1'));

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    await expect(response.text()).resolves.toContain('KB-1 web dev server is unavailable at http://127.0.0.1:9.');
  });

  it('falls back to index for malformed or escaping paths', async () => {
    await expect((await serveUi(root, '/%E0%A4%A')).text()).resolves.toContain('fallback');
    await expect((await serveUi(root, '/../outside.js')).text()).resolves.toContain('fallback');
  });

  it.each([
    ['favicon.ico', 'image/x-icon'],
    ['app.js', 'text/javascript; charset=utf-8'],
    ['data.json', 'application/json; charset=utf-8'],
    ['app.js.map', 'application/json; charset=utf-8'],
    ['logo.png', 'image/png'],
    ['logo.svg', 'image/svg+xml'],
    ['readme.txt', 'text/plain; charset=utf-8'],
    ['image.webp', 'image/webp'],
    ['font.woff', 'font/woff'],
    ['font.woff2', 'font/woff2'],
    ['binary.bin', 'application/octet-stream']
  ])('serves %s with %s', async (filename, contentType) => {
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', filename), 'asset', 'utf8');

    const response = await serveUi(root, `/assets/${filename}`);

    expect(response.headers.get('content-type')).toBe(contentType);
    await expect(response.text()).resolves.toBe('asset');
  });
});
