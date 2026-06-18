import type { Meta, StoryObj } from '@storybook/svelte';
import NewVaultDialogDemo from '../stories/NewVaultDialogDemo.svelte';

const meta = {
  title: 'App/Dialogs/NewVaultDialog',
  component: NewVaultDialogDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    mode: 'light'
  }
} satisfies Meta<typeof NewVaultDialogDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  args: {
    mode: 'dark'
  }
};

// The server reported a slug collision; the dialog keeps the typed values
// and surfaces the message inline so the user can pick a different slug.
export const WithError: Story = {
  args: {
    error: 'A vault with that slug already exists.'
  }
};
