import type { Meta, StoryObj } from '@storybook/svelte';
import DocumentHeaderMenu from './DocumentHeaderMenu.svelte';

const meta = {
  title: 'App/Local Editor/DocumentHeaderMenu',
  component: DocumentHeaderMenu,
  args: {
    favorited: false,
    onToggleFavorite: () => {},
    onRename: () => {},
    onMove: () => {},
    onDelete: () => {}
  }
} satisfies Meta<typeof DocumentHeaderMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Favorited: Story = {
  args: { favorited: true }
};

// With no rename/move/delete handlers the overflow menu hides; only the
// favorite toggle renders.
export const FavoriteOnly: Story = {
  args: { onRename: undefined, onMove: undefined, onDelete: undefined }
};
