import type { Meta, StoryObj } from '@storybook/svelte';
import FileNode from './FileNode.svelte';

const meta = {
  title: 'App/Local Editor/FileNode',
  component: FileNode,
  args: {
    node: { kind: 'file', path: 'projects/active/editor-shell.md', name: 'editor-shell.md' },
    activePath: 'projects/active/editor-shell.md'
  }
} satisfies Meta<typeof FileNode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {};
