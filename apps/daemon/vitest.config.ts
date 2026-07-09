import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    dedupe: ['yjs'],
    alias: {
      '@kb-1/doc-session': fileURLToPath(new URL('../../packages/doc-session/src/index.ts', import.meta.url)),
      '@kb-1/local-mcp': fileURLToPath(new URL('../../packages/local-mcp/src/index.ts', import.meta.url)),
      '@kb-1/tunnel-client': fileURLToPath(new URL('../../packages/tunnel-client/src/index.ts', import.meta.url)),
      '@kb-1/tunnel-protocol': fileURLToPath(new URL('../../packages/tunnel-protocol/src/index.ts', import.meta.url)),
      '@kb-1/vault-core': fileURLToPath(new URL('../../packages/vault-core/src/index.ts', import.meta.url)),
      '@kb-1/vault-service': fileURLToPath(new URL('../../packages/vault-service/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/app.ts', 'src/request-helpers.ts', 'src/starter-kit.ts', 'src/ui-static.ts', 'src/vault-registry.ts'],
      thresholds: {
        lines: 90,
        perFile: true
      }
    }
  }
});
