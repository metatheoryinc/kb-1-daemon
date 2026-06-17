import type { Meta, StoryObj } from '@storybook/svelte';
import ContextMenuDemo from '../stories/ContextMenuDemo.svelte';

const meta = {
  title: 'App/Overlays/ContextMenu',
  component: ContextMenuDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    mode: 'light'
  }
} satisfies Meta<typeof ContextMenuDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  args: {
    mode: 'dark'
  }
};
