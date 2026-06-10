import type { Meta, StoryObj } from '@storybook/svelte';
import IconButtonDemo from '../stories/IconButtonDemo.svelte';

const meta = {
  title: 'App/Primitives/IconButton',
  component: IconButtonDemo,
  argTypes: {
    icon: { control: 'select', options: ['refresh', 'search', 'plus', 'settings', 'star'] },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    variant: { control: 'select', options: ['quiet', 'active', 'outlined'] }
  }
} satisfies Meta<typeof IconButtonDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const IconOnly: Story = {};

export const WithLabel: Story = {
  args: {
    label: 'Refresh',
    variant: 'outlined'
  }
};
