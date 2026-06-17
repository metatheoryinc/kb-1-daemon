import type { Meta, StoryObj } from '@storybook/svelte';
import PrimaryRailDemo from '../../stories/PrimaryRailDemo.svelte';

const meta = {
  title: 'Local/Layout/Primary Rail',
  component: PrimaryRailDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    mode: 'light',
    colorMode: 'system',
    activeNav: 'files'
  }
} satisfies Meta<typeof PrimaryRailDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  args: {
    mode: 'dark'
  }
};

export const Starred: Story = {
  args: {
    activeNav: 'starred'
  }
};
