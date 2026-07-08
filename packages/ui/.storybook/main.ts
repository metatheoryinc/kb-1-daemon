import type { StorybookConfig } from '@storybook/sveltekit';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const config: StorybookConfig = {
  stories: [
    '../src/lib/**/*.stories.@(js|ts|svelte)',
    '../../editor/src/lib/**/*.stories.@(js|ts|svelte)'
  ],
  addons: ['@storybook/addon-docs', '@storybook/addon-svelte-csf', 'storybook/viewport'],
  framework: {
    name: '@storybook/sveltekit',
    options: {
      docgen: false
    }
  },
  viteFinal: async (vite) => {
    vite.plugins = [...(vite.plugins ?? []), svelte()];
    vite.resolve = vite.resolve ?? {};
    const existingAliases = Array.isArray(vite.resolve.alias)
      ? vite.resolve.alias
      : Object.entries(vite.resolve.alias ?? {}).map(([find, replacement]) => ({
          find,
          replacement
        }));
    vite.resolve.alias = [
      ...existingAliases,
      {
        find: /^@kb-1\/ui$/,
        replacement: fileURLToPath(new URL('../src/lib/index.ts', import.meta.url))
      },
      {
        find: /^@kb-1\/editor$/,
        replacement: fileURLToPath(new URL('../../editor/src/lib/index.ts', import.meta.url))
      }
    ];
    vite.server = vite.server ?? {};
    vite.server.host = '0.0.0.0';
    vite.server.allowedHosts = true;
    return vite;
  }
};

export default config;
