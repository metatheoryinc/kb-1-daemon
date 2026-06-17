import type { Meta, StoryObj } from '@storybook/svelte';
import FavoriteButton from './FavoriteButton.svelte';

const meta = {
  title: 'App/Primitives/FavoriteButton',
  component: FavoriteButton,
  args: {
    favorited: false,
    size: 'md',
    onclick: () => {}
  },
  argTypes: {
    favorited: { control: 'boolean' },
    size: { control: 'select', options: ['sm', 'md'] }
  }
} satisfies Meta<typeof FavoriteButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Favorited: Story = {
  args: { favorited: true }
};
