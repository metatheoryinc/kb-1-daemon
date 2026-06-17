import type { Meta, StoryObj } from '@storybook/svelte';
import MovePickerDialogDemo from '../stories/MovePickerDialogDemo.svelte';

const meta = {
  title: 'App/Dialogs/MovePickerDialog',
  component: MovePickerDialogDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    mode: 'light'
  }
} satisfies Meta<typeof MovePickerDialogDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  args: {
    mode: 'dark'
  }
};
