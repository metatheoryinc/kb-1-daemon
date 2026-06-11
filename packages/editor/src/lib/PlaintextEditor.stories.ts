import type { Meta, StoryObj } from '@storybook/svelte';
import PlaintextEditorStory from './stories/PlaintextEditorStory.svelte';

const meta = {
  title: 'App/Editor/PlaintextEditor',
  component: PlaintextEditorStory,
} satisfies Meta<typeof PlaintextEditorStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fixture: Story = {};

