import type { Meta, StoryObj } from '@storybook/svelte';
import FolderNode from './FolderNode.svelte';
import { localEditorTreeFixture } from './fixtures';

const folder = localEditorTreeFixture[0];
if (folder.kind !== 'folder') {
  throw new Error('Expected folder fixture');
}

const meta = {
  title: 'App/Local Editor/FolderNode',
  component: FolderNode,
  args: {
    node: folder,
    activePath: 'projects/active/editor-shell.md',
    expandedPaths: new Set(['projects', 'projects/active'])
  }
} satisfies Meta<typeof FolderNode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {};
