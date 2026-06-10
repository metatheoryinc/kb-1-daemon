import type { Meta, StoryObj } from '@storybook/svelte';
import Checkbox from './Checkbox.svelte';

const meta = {
  title: 'App/Primitives/Checkbox',
  component: Checkbox,
  args: {
    checked: true,
    ariaLabel: 'Select file'
  },
  argTypes: {
    checked: { control: 'boolean' }
  }
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Checked: Story = {};

export const Unchecked: Story = {
  args: {
    checked: false
  }
};
