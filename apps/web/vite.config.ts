import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const webPort = Number(process.env.KB2_WEB_PORT ?? '5173');

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    hmr: {
      clientPort: webPort
    }
  }
});
