import type { Meta, StoryObj } from '@storybook/svelte';
import PopoverDemo from '../stories/PopoverDemo.svelte';

const meta = {
  title: 'App/Overlays/Popover',
  component: PopoverDemo,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof PopoverDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};
