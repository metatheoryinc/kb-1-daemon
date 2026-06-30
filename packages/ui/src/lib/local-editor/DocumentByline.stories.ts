import type { Meta, StoryObj } from '@storybook/svelte';
import DocumentByline from './DocumentByline.svelte';

const meta = {
  title: 'App/Local Editor/DocumentByline',
  component: DocumentByline,
  args: {
    statusLabel: 'Saved',
    statusTone: 'normal'
  }
} satisfies Meta<typeof DocumentByline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Saved: Story = {};

export const Saving: Story = {
  args: { statusLabel: 'Saving…' }
};

export const Error: Story = {
  args: { statusLabel: 'Not saving', statusTone: 'error' }
};
