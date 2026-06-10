import type { Meta, StoryObj } from '@storybook/svelte';
import LiveStatusChip from './LiveStatusChip.svelte';

const meta = {
  title: 'App/Primitives/LiveStatusChip',
  component: LiveStatusChip,
  args: {
    label: 'Live saved 2s ago'
  }
} satisfies Meta<typeof LiveStatusChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
