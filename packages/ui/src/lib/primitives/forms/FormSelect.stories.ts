import type { Meta, StoryObj } from '@storybook/svelte';
import FormSelectDemo from '../../stories/FormSelectDemo.svelte';

const meta = {
  title: 'App/Primitives/FormSelect',
  component: FormSelectDemo
} satisfies Meta<typeof FormSelectDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
