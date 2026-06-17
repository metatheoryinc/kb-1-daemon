import type { Meta, StoryObj } from '@storybook/svelte';
import FolderCanvas from './FolderCanvas.svelte';
import { localEditorTreeFixture } from './fixtures';
import type { LocalFolderNode } from './types';

const projects = localEditorTreeFixture[0];
if (projects.kind !== 'folder') {
  throw new Error('Expected folder fixture');
}
const projectsFolder: LocalFolderNode = projects;

const meta = {
  title: 'App/Local Editor/FolderCanvas',
  component: FolderCanvas,
  args: {
    vaultName: 'demo-vault',
    folderPath: 'projects',
    metadata: projectsFolder.metadata,
    children: projectsFolder.children
  }
} satisfies Meta<typeof FolderCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;

// A sub-folder: folder icon + heading, stat block, and a contents list
// of child folders (with recursive counts) followed by child notes.
export const Folder: Story = {};

// The vault root: no folder icon on the heading, the vault name as the
// title, and every top-level row in the contents list.
export const VaultRoot: Story = {
  args: {
    folderPath: '',
    metadata: undefined,
    children: localEditorTreeFixture
  }
};

// A folder with no children renders the empty state.
export const Empty: Story = {
  args: {
    folderPath: 'archive',
    metadata: undefined,
    children: []
  }
};
