import type { Meta, StoryObj } from '@storybook/svelte';
import FormFieldDemo from '../../stories/FormFieldDemo.svelte';

const meta = {
  title: 'App/Primitives/FormField',
  component: FormFieldDemo,
  argTypes: {
    type: { control: 'select', options: ['text', 'email', 'password'] }
  }
} satisfies Meta<typeof FormFieldDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Text: Story = {};
