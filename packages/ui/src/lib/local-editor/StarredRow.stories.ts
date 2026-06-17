import type { Meta, StoryObj } from '@storybook/svelte';
import StarredRowDemo from '../stories/StarredRowDemo.svelte';

const meta = {
  title: 'App/Local Editor/StarredRow',
  component: StarredRowDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    label: 'launch-notes.md',
    meta: 'in Demo Vault',
    kind: 'note',
    accent: 'coral',
    colorHex: '#ee8a91',
    icon: null,
    href: '/projects/active/launch-notes.md',
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
    meta: 'in Demo Vault',
    kind: 'folder',
    accent: 'sky',
    colorHex: '#7fb9e5',
    href: '/research'
  }
};

export const FolderDark: Story = {
  args: {
    label: 'research',
    meta: 'in Demo Vault',
    kind: 'folder',
    accent: 'sky',
    colorHex: '#7fb9e5',
    href: '/research',
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
    colorHex: '#8fa3b1',
    href: undefined,
    available: false
  }
};
