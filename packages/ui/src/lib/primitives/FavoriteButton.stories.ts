import type { Meta, StoryObj } from '@storybook/svelte';
import FavoriteButton from './FavoriteButton.svelte';

const meta = {
  title: 'App/Primitives/FavoriteButton',
  component: FavoriteButton,
  args: {
    favorited: true,
    size: 'md'
  },
  argTypes: {
    favorited: { control: 'boolean' },
    size: { control: 'select', options: ['sm', 'md'] }
  }
} satisfies Meta<typeof FavoriteButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Favorited: Story = {};

export const Empty: Story = {
  args: {
    favorited: false
  }
};
