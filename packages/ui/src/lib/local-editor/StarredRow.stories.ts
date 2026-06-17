import type { Meta, StoryObj } from '@storybook/svelte';
import StarredRowDemo from '../stories/StarredRowDemo.svelte';

const meta = {
  title: 'App/Local Editor/StarredRow',
  component: StarredRowDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    label: 'launch-notes.md',
    meta: 'note',
    kind: 'note',
    accent: 'coral',
    path: 'projects/active/launch-notes.md',
    available: true,
    active: false,
    mode: 'light'
  }
} satisfies Meta<typeof StarredRowDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoteLight: Story = {};

export const NoteDark: Story = {
  args: { mode: 'dark' }
};

export const Folder: Story = {
  args: {
    label: 'research',
    meta: 'folder',
    kind: 'folder',
    accent: 'sky',
    path: 'research'
  }
};

export const FolderDark: Story = {
  args: {
    label: 'research',
    meta: 'folder',
    kind: 'folder',
    accent: 'sky',
    path: 'research',
    mode: 'dark'
  }
};

export const Active: Story = {
  args: { active: true }
};

export const Unavailable: Story = {
  args: {
    label: 'old-plan.md',
    accent: 'slate',
    path: 'archive/old-plan.md',
    available: false
  }
};
