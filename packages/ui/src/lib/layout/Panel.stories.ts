import type { Meta, StoryObj } from '@storybook/svelte';
import PanelExamples from '../stories/PanelExamples.svelte';

const meta = {
  title: 'App/Layout/Panel',
  component: PanelExamples
} satisfies Meta<typeof PanelExamples>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Basic: Story = {};
