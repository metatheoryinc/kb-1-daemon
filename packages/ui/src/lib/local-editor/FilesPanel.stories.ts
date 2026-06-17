import type { Meta, StoryObj } from '@storybook/svelte';
import FilesPanel from './FilesPanel.svelte';
import { folderKey } from './expansion';
import { localEditorTreeFixture } from './fixtures';

const VAULT_ID = 'demo-vault';

const meta = {
  title: 'App/Local Editor/FilesPanel',
  component: FilesPanel,
  args: {
    vaultName: 'demo-vault',
    vaultId: VAULT_ID,
    tree: localEditorTreeFixture,
    activePath: 'projects/active/editor-shell.md',
    expandedFolderIds: new Set([
      folderKey(VAULT_ID, 'projects'),
      folderKey(VAULT_ID, 'projects/active'),
      folderKey(VAULT_ID, 'research')
    ]),
    hiddenVaultIds: []
  }
} satisfies Meta<typeof FilesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tree: Story = {};

export const VaultHidden: Story = {
  args: {
    hiddenVaultIds: [VAULT_ID]
  }
};
