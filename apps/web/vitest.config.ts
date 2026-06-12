import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  resolve: {
    alias: [
      {
        find: /^svelte$/,
        replacement: fileURLToPath(new URL('../../node_modules/.pnpm/svelte@5.55.5/node_modules/svelte/src/index-client.js', import.meta.url))
      },
      {
        find: /^@kb-2\/doc-session\/protocol$/,
        replacement: fileURLToPath(new URL('../../packages/doc-session/src/protocol.ts', import.meta.url))
      },
      {
        find: /^@kb-2\/doc-session$/,
        replacement: fileURLToPath(new URL('../../packages/doc-session/src/index.ts', import.meta.url))
      },
      {
        find: /^@kb-2\/vault-core$/,
        replacement: fileURLToPath(new URL('../../packages/vault-core/src/index.ts', import.meta.url))
      }
    ]
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
