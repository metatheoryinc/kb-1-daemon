import type { Meta, StoryObj } from '@storybook/svelte';
import VaultGroup from './VaultGroup.svelte';
import { folderKey, vaultKey } from './expansion';
import { localEditorTreeFixture } from './fixtures';

const VAULT_ID = 'demo-vault';

const meta = {
  title: 'App/Local Editor/VaultGroup',
  component: VaultGroup,
  args: {
    vaultId: VAULT_ID,
    vaultName: 'demo-vault',
    accent: 'sage',
    tree: localEditorTreeFixture,
    activePath: 'projects/active/editor-shell.md',
    // Nested chain unfurled so the active file's row is visible.
    expandedFolderIds: new Set([
      folderKey(VAULT_ID, 'projects'),
      folderKey(VAULT_ID, 'projects/active'),
      folderKey(VAULT_ID, 'research')
    ]),
    expandedVaultIds: new Set([vaultKey(VAULT_ID)])
  }
} satisfies Meta<typeof VaultGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {};

export const Collapsed: Story = {
  args: {
    expandedVaultIds: new Set<string>()
  }
};

export const FoldersClosed: Story = {
  args: {
    expandedFolderIds: new Set<string>()
  }
};

// Forces every row's `…` kebab on (the mobile treatment) so the actions
// button is visible on the vault header, folder rows (beside their note
// counts), and file rows without hovering.
export const KebabVisible: Story = {
  args: {
    kebabAlwaysVisible: true
  }
};
