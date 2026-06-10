import type { Meta, StoryObj } from '@storybook/svelte';
import FormExamples from '../../stories/FormExamples.svelte';

const meta = {
  title: 'App/Primitives/Forms',
  component: FormExamples
} satisfies Meta<typeof FormExamples>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Controls: Story = {};
