import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    alias: {
      '@kb-2/doc-session/protocol': fileURLToPath(new URL('../../packages/doc-session/src/protocol.ts', import.meta.url)),
      '@kb-2/doc-session': fileURLToPath(new URL('../../packages/doc-session/src/index.ts', import.meta.url)),
      '@kb-2/vault-core': fileURLToPath(new URL('../../packages/vault-core/src/index.ts', import.meta.url))
    },
    adapter: adapter({
      fallback: 'index.html'
    })
  }
};

export default config;
