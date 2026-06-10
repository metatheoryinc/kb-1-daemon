import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const daemonPort = process.env.KB2_PORT ?? '7382';
const daemonHost = process.env.KB2_HOST && process.env.KB2_HOST !== '0.0.0.0'
  ? process.env.KB2_HOST
  : '127.0.0.1';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    proxy: {
      '/api': {
        target: `http://${daemonHost}:${daemonPort}`,
        changeOrigin: true
      }
    }
  }
});
