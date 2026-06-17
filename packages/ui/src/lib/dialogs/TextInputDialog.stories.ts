import type { Meta, StoryObj } from '@storybook/svelte';
import TextInputDialogDemo from '../stories/TextInputDialogDemo.svelte';

const meta = {
  title: 'App/Dialogs/TextInputDialog',
  component: TextInputDialogDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    mode: 'light'
  }
} satisfies Meta<typeof TextInputDialogDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  args: {
    mode: 'dark'
  }
};

export const RenameWithError: Story = {
  args: {
    title: 'Rename folder',
    submitLabel: 'Rename',
    fields: [{ type: 'text', label: 'Name', initialValue: 'projects', required: true }],
    error: 'A note or folder with that name already exists.'
  }
};
