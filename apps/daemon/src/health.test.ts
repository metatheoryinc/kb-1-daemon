import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createApp } from './app.js';
import { createDaemonConfig } from './config.js';
import { writeDaemonStatus } from './status.js';

describe('health endpoint', () => {
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
});
