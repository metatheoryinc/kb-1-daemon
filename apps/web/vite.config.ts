import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const webPort = Number(process.env.KB1_WEB_PORT ?? process.env.KB2_WEB_PORT ?? '5173');

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  resolve: {
    alias: [
      {
        find: /^@kb-1\/doc-session\/protocol$/,
        replacement: fileURLToPath(new URL('../../packages/doc-session/src/protocol.ts', import.meta.url))
      },
      {
        find: /^@kb-1\/doc-session$/,
        replacement: fileURLToPath(new URL('../../packages/doc-session/src/index.ts', import.meta.url))
      },
      {
        find: /^@kb-1\/vault-core$/,
        replacement: fileURLToPath(new URL('../../packages/vault-core/src/index.ts', import.meta.url))
      }
    ]
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    hmr: {
      clientPort: webPort
    }
  }
});
