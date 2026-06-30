import type { Meta, StoryObj } from '@storybook/svelte';
import FolderIcon from './FolderIcon.svelte';

const meta = {
  title: 'App/Primitives/FolderIcon',
  component: FolderIcon,
  args: {
    color: '#bae6fd',
    size: 'lg',
    variant: 'filled',
    label: 'Folder'
  },
  argTypes: {
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    variant: { control: 'select', options: ['filled', 'outline'] }
  }
} satisfies Meta<typeof FolderIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Filled: Story = {};

export const Outline: Story = {
  args: {
    variant: 'outline'
  }
};
