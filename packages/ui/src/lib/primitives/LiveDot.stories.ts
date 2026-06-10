import type { Meta, StoryObj } from '@storybook/svelte';
import LiveDot from './LiveDot.svelte';

const meta = {
  title: 'App/Primitives/LiveDot',
  component: LiveDot,
  args: {
    size: 8,
    pulse: true,
    title: 'Live'
  },
  argTypes: {
    pulse: { control: 'boolean' },
    size: { control: { type: 'range', min: 4, max: 20, step: 1 } }
  }
} satisfies Meta<typeof LiveDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pulsing: Story = {};
