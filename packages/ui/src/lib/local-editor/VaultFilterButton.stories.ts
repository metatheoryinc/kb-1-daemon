import type { Meta, StoryObj } from '@storybook/svelte';
import VaultFilterButton from './VaultFilterButton.svelte';

const meta = {
  title: 'App/Local Editor/VaultFilterButton',
  component: VaultFilterButton,
  args: {
    open: false,
    label: 'All vaults'
  },
  argTypes: {
    open: { control: 'boolean' }
  }
} satisfies Meta<typeof VaultFilterButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = {
  args: {
    open: true,
    label: '1 vault'
  }
};
