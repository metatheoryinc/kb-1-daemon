import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@kb-2/doc-session': fileURLToPath(new URL('../../packages/doc-session/src/index.ts', import.meta.url)),
      '@kb-2/local-mcp': fileURLToPath(new URL('../../packages/local-mcp/src/index.ts', import.meta.url)),
      '@kb-2/vault-core': fileURLToPath(new URL('../../packages/vault-core/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/app.ts'],
      thresholds: {
        lines: 90
      }
    }
  }
});
