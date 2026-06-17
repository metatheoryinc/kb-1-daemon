import type { Meta, StoryObj } from '@storybook/svelte';
import DocumentHeader from './DocumentHeader.svelte';

const meta = {
  title: 'App/Local Editor/DocumentHeader',
  component: DocumentHeader,
  args: {
    breadcrumbItems: [
      { label: 'demo-vault' },
      { label: 'projects' },
      { label: 'active' },
      { label: 'editor-shell.md', current: true }
    ],
    statusLabel: 'Saved',
    favorited: false,
    onToggleFavorite: () => {},
    onRename: () => {},
    onMove: () => {},
    onDelete: () => {}
  }
} satisfies Meta<typeof DocumentHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Favorited: Story = {
  args: { favorited: true }
};

export const Connecting: Story = {
  args: { statusLabel: 'Connecting…' }
};

// A folder/vault view degrades gracefully: no document actions, so the
// overflow menu hides and only the favorite toggle remains.
export const NoDocumentActions: Story = {
  args: {
    breadcrumbItems: [{ label: 'demo-vault', current: true }],
    statusLabel: undefined,
    onRename: undefined,
    onMove: undefined,
    onDelete: undefined
  }
};
