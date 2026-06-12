import type { Meta, StoryObj } from '@storybook/svelte';
import DocumentHeader from './DocumentHeader.svelte';

const meta = {
  title: 'App/Local Editor/DocumentHeader',
  component: DocumentHeader,
  args: {
    vaultName: 'demo-vault',
    path: 'projects/active/editor-shell.md'
  }
} satisfies Meta<typeof DocumentHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
