import type { Meta, StoryObj } from '@storybook/svelte';
import VaultFilterPopoverDemo from '../stories/VaultFilterPopoverDemo.svelte';

const meta = {
  title: 'App/Local Editor/VaultFilterPopover',
  component: VaultFilterPopoverDemo
} satisfies Meta<typeof VaultFilterPopoverDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllVisible: Story = {};

export const SomeHidden: Story = {
  args: {
    initialHidden: ['archive']
  }
};
