import type { Meta, StoryObj } from '@storybook/svelte';
import BadgeDemo from '../stories/BadgeDemo.svelte';

const meta = {
  title: 'App/Primitives/Badge',
  component: BadgeDemo,
  argTypes: {
    tone: { control: 'select', options: ['neutral', 'success', 'danger', 'live'] }
  }
} satisfies Meta<typeof BadgeDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Success: Story = {};

export const Danger: Story = {
  args: {
    label: 'Unavailable',
    tone: 'danger'
  }
};
