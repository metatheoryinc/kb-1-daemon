import type { Meta, StoryObj } from '@storybook/svelte';
import LocalEditorShellDemo from '../stories/LocalEditorShellDemo.svelte';

const meta = {
  title: 'App/Local Editor/LocalEditorShell',
  component: LocalEditorShellDemo,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof LocalEditorShellDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fixture: Story = {};
