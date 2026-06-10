import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { startDaemon } from './main.js';

describe('daemon startup', () => {
  let kb2Home: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    kb2Home = await mkdtemp(join(tmpdir(), 'kb2-startup-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(kb2Home, { force: true, recursive: true });
  });

  it('does not write status when the HTTP server fails to bind', async () => {
    const blocker = createServer();
    await listen(blocker);
    const port = (blocker.address() as AddressInfo).port;

    process.env = {
      ...originalEnv,
      KB2_HOME: kb2Home,
      KB2_HOST: '127.0.0.1',
      KB2_PORT: String(port)
    };

    await expect(startDaemon()).rejects.toBeTruthy();
    await expect(access(join(kb2Home, 'daemon', 'status.json'))).rejects.toBeTruthy();

    await close(blocker);
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
