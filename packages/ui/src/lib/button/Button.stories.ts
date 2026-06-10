import type { Meta, StoryObj } from '@storybook/svelte';
import ButtonExamples from '../stories/ButtonExamples.svelte';

const meta = {
  title: 'App/Primitives/Button',
  component: ButtonExamples,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof ButtonExamples>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {};
