import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  build: {
    lib: {
      entry: 'src/lib/index.ts',
      formats: ['es']
    },
    rollupOptions: {
      external: ['svelte', 'yjs', '@kb-1/ui']
    }
  },
  test: {
    environment: 'node',
    globals: true
  }
});
