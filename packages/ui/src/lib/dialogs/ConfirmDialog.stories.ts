import type { Meta, StoryObj } from '@storybook/svelte';
import ConfirmDialogDemo from '../stories/ConfirmDialogDemo.svelte';

const meta = {
  title: 'App/Dialogs/ConfirmDialog',
  component: ConfirmDialogDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    mode: 'light',
    destructive: true
  }
} satisfies Meta<typeof ConfirmDialogDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  args: {
    mode: 'dark'
  }
};

export const WithError: Story = {
  args: {
    error: 'This folder is not empty.'
  }
};
