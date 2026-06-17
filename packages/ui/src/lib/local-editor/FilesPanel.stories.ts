import type { Meta, StoryObj } from '@storybook/svelte';
import FilesPanel from './FilesPanel.svelte';
import { localEditorSearchFixture, localEditorTreeFixture } from './fixtures';

const meta = {
  title: 'App/Local Editor/FilesPanel',
  component: FilesPanel,
  args: {
    vaultName: 'demo-vault',
    daemonLabel: 'Daemon · live',
    tree: localEditorTreeFixture,
    activePath: 'projects/active/editor-shell.md',
    expandedPaths: new Set(['projects', 'projects/active', 'research']),
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
