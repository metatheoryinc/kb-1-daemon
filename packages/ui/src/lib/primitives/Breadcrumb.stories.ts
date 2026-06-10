import type { Meta, StoryObj } from '@storybook/svelte';
import Breadcrumb from './Breadcrumb.svelte';

const meta = {
  title: 'App/Primitives/Breadcrumb',
  component: Breadcrumb,
  args: {
    items: [
      { label: 'Vault', avatar: { kind: 'org', accent: 'sky', letter: 'K' } },
      { label: 'Research', avatar: { kind: 'folder', accent: 'sage' } },
      { label: 'Local-first roadmap', current: true }
    ]
  }
} satisfies Meta<typeof Breadcrumb>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
