import type { Meta, StoryObj } from '@storybook/svelte';
import RailResizeHandleDemo from '../stories/RailResizeHandleDemo.svelte';

const meta = {
  title: 'App/Local Editor/RailResizeHandle',
  component: RailResizeHandleDemo,
  args: {
    width: 282
  }
} satisfies Meta<typeof RailResizeHandleDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Wide: Story = {
  args: {
    width: 460
  }
};
