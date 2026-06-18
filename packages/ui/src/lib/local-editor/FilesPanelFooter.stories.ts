import type { Meta, StoryObj } from '@storybook/svelte';
import FilesPanelFooter from './FilesPanelFooter.svelte';

const meta = {
  title: 'App/Local Editor/FilesPanelFooter',
  component: FilesPanelFooter,
  args: {
    onNewVault: () => {}
  }
} satisfies Meta<typeof FilesPanelFooter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
