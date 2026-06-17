import type { Meta, StoryObj } from '@storybook/svelte';
import FilesPanel from './FilesPanel.svelte';
import { folderKey } from './expansion';
import { localEditorSearchFixture, localEditorTreeFixture } from './fixtures';

const VAULT_ID = 'demo-vault';

const meta = {
  title: 'App/Local Editor/FilesPanel',
  component: FilesPanel,
  args: {
    vaultName: 'demo-vault',
    vaultId: VAULT_ID,
    daemonLabel: 'Daemon · live',
    tree: localEditorTreeFixture,
    activePath: 'projects/active/editor-shell.md',
    expandedFolderIds: new Set([
      folderKey(VAULT_ID, 'projects'),
      folderKey(VAULT_ID, 'projects/active'),
      folderKey(VAULT_ID, 'research')
    ]),
    searchValue: '',
    searchResults: localEditorSearchFixture
  }
} satisfies Meta<typeof FilesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tree: Story = {};

export const Search: Story = {
  args: {
    searchValue: 'editor',
    searchTotal: 64,
    searchTruncated: true
  }
};
