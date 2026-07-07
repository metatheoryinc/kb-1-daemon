import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDaemonStatus } from './status.js';

describe('daemon status', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kb1-status-'));
  });

  afterEach(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  it('rejects malformed status files', async () => {
    const statusFile = join(tempDir, 'status.json');
    await writeFile(statusFile, JSON.stringify({ serviceName: 'kb1d' }), 'utf8');

    await expect(readDaemonStatus(statusFile)).rejects.toThrow(/missing required fields/);
  });
});
