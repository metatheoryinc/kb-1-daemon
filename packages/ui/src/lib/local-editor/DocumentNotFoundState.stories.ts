import type { Meta, StoryObj } from '@storybook/svelte';
import DocumentNotFoundStateDemo from '../stories/DocumentNotFoundStateDemo.svelte';

const meta = {
  title: 'App/Local Editor/DocumentNotFoundState',
  component: DocumentNotFoundStateDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    path: 'projects/typo/missing-note.md',
    mode: 'light'
  }
} satisfies Meta<typeof DocumentNotFoundStateDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  args: {
    mode: 'dark'
  }
};
