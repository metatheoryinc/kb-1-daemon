import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@kb-2/doc-session': fileURLToPath(new URL('../../packages/doc-session/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    globals: true
  }
});
