import type { Meta, StoryObj } from '@storybook/svelte';
import PrimaryRailDemo from '../../stories/PrimaryRailDemo.svelte';

const meta = {
  title: 'Local/Layout/Primary Rail',
  component: PrimaryRailDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    mode: 'light',
    colorMode: 'system',
    activeNav: 'files',
    collapsed: false
  }
} satisfies Meta<typeof PrimaryRailDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {};

export const ExpandedDark: Story = {
  args: {
    mode: 'dark'
  }
};

export const Collapsed: Story = {
  args: {
    collapsed: true
  }
};

export const CollapsedDark: Story = {
  args: {
    mode: 'dark',
    collapsed: true
  }
};

export const Starred: Story = {
  args: {
    activeNav: 'starred'
  }
};
