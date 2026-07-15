import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

describe('container packaging safety', () => {
  it('publishes the unauthenticated Compose daemon on loopback only', async () => {
    const composePath = fileURLToPath(new URL('../../../compose.yaml', import.meta.url));
    const compose = await readFile(composePath, 'utf8');

    expect(compose).toContain('- "127.0.0.1:17382:7382"');
    expect(compose).not.toMatch(/-\s*["']?17382:7382/);
  });
});
