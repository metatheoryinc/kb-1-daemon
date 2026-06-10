import type { Meta, StoryObj } from '@storybook/svelte';
import OverlayExamples from '../stories/OverlayExamples.svelte';

const meta = {
  title: 'App/Overlays/Menu Dialog Popover',
  component: OverlayExamples,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof OverlayExamples>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FixtureBacked: Story = {};
