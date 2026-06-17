import type { Meta, StoryObj } from '@storybook/svelte';
import FileNode from './FileNode.svelte';

const meta = {
  title: 'App/Local Editor/FileNode',
  component: FileNode,
  args: {
    node: { kind: 'file', path: 'projects/active/editor-shell.md', name: 'editor-shell.md' },
    depth: 0,
    activePath: 'projects/active/editor-shell.md'
  }
} satisfies Meta<typeof FileNode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {};

export const Inactive: Story = {
  args: {
    activePath: 'somewhere/else.md'
  }
};

export const Nested: Story = {
  args: {
    depth: 2,
    activePath: 'somewhere/else.md'
  }
};

// Kebab is hover/focus-revealed on desktop; this story forces it on so the
// `…` actions button is visible without hovering (the mobile treatment).
export const KebabVisible: Story = {
  args: {
    activePath: 'somewhere/else.md',
    kebabAlwaysVisible: true
  }
};
