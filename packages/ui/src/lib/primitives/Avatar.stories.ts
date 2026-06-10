import type { Meta, StoryObj } from '@storybook/svelte';
import AvatarDemo from '../stories/AvatarDemo.svelte';

const meta = {
  title: 'App/Primitives/Avatar',
  component: AvatarDemo,
  argTypes: {
    kind: { control: 'select', options: ['human', 'agent', 'org', 'folder', 'file'] },
    accent: { control: 'select', options: ['coral', 'peach', 'butter', 'sage', 'mint', 'lime', 'sky', 'periwinkle', 'lavender', 'rose', 'teal', 'slate'] },
    brand: { control: 'select', options: ['codex', 'claude', 'openai', 'cursor', 'gemini'] },
    tone: { control: 'select', options: ['soft', 'pastel'] }
  }
} satisfies Meta<typeof AvatarDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Human: Story = {};

export const Agent: Story = {
  args: {
    kind: 'agent',
    accent: 'periwinkle',
    brand: 'codex'
  }
};
