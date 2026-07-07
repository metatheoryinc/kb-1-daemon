import type { Meta, StoryObj } from '@storybook/svelte';
import LocalStatusShell from './LocalStatusShell.svelte';

const health = {
  ok: true,
  service: '@kb-1/daemon',
  status: {
    serviceName: '@kb-1/daemon',
    startedAt: '2026-06-10T18:42:12.000Z',
    kb1Home: '/tmp/kb1-storybook/home',
    daemonHome: '/tmp/kb1-storybook/home/daemon',
    statusFile: '/tmp/kb1-storybook/home/daemon/status.json',
    pid: 42420,
    nodeVersion: 'v25.9.2'
  }
};

const meta = {
  title: 'App/Layout/Local Status Shell',
  component: LocalStatusShell,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof LocalStatusShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Online: Story = {
  args: {
    health,
    loading: false
  }
};

export const Unavailable: Story = {
  args: {
    error: 'Health request failed with 503',
    loading: false
  }
};
