import type { StorybookConfig } from '@storybook/sveltekit';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const config: StorybookConfig = {
  stories: ['../src/lib/**/*.stories.@(js|ts|svelte)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-svelte-csf', 'storybook/viewport'],
  framework: {
    name: '@storybook/sveltekit',
    options: {
      docgen: false
    }
  },
  viteFinal: async (vite) => {
    vite.plugins = [...(vite.plugins ?? []), svelte()];
    vite.server = vite.server ?? {};
    vite.server.host = '0.0.0.0';
    vite.server.allowedHosts = true;
    return vite;
  }
};

export default config;
