import type { Meta, StoryObj } from '@storybook/svelte';
import DialogShellDemo from '../stories/DialogShellDemo.svelte';

const meta = {
  title: 'App/Dialogs/DialogShell',
  component: DialogShellDemo,
  parameters: { layout: 'fullscreen' },
  argTypes: {
    open: { control: 'boolean' }
  }
} satisfies Meta<typeof DialogShellDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};
