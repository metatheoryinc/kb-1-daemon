import type { Meta, StoryObj } from '@storybook/svelte';
import BrandMark from './BrandMark.svelte';

const meta = {
  title: 'App/Primitives/BrandMark',
  component: BrandMark,
  args: {
    size: 32
  },
  argTypes: {
    size: { control: { type: 'range', min: 16, max: 64, step: 2 } }
  }
} satisfies Meta<typeof BrandMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
