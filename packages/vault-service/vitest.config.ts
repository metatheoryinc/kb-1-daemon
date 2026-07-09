import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@kb-1/doc-session': fileURLToPath(new URL('../doc-session/src/index.ts', import.meta.url)),
      '@kb-1/vault-core': fileURLToPath(new URL('../vault-core/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 90,
        perFile: true
      }
    }
  }
});
