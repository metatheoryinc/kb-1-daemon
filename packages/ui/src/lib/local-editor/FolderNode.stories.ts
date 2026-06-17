import type { Meta, StoryObj } from '@storybook/svelte';
import FolderNode from './FolderNode.svelte';
import { folderKey } from './expansion';
import { localEditorTreeFixture } from './fixtures';

const folder = localEditorTreeFixture[0];
if (folder.kind !== 'folder') {
  throw new Error('Expected folder fixture');
}

const VAULT_ID = 'demo-vault';

const meta = {
  title: 'App/Local Editor/FolderNode',
  component: FolderNode,
  args: {
    node: folder,
    vaultId: VAULT_ID,
    activePath: 'projects/active/editor-shell.md',
    expandedFolderIds: new Set([
      folderKey(VAULT_ID, 'projects'),
      folderKey(VAULT_ID, 'projects/active')
    ])
  }
} satisfies Meta<typeof FolderNode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {};

export const Collapsed: Story = {
  args: {
    expandedFolderIds: new Set<string>()
  }
};

// Folder rows show a recursive note count at the trailing edge and a
// hover-revealed `…` kebab. This story forces the kebab on (mobile
// treatment) so both the count and the actions button are visible at rest.
export const KebabVisible: Story = {
  args: {
    kebabAlwaysVisible: true
  }
};
