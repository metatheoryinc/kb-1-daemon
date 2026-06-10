import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    const response = await app.request('/health');
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
});
