import type { Meta, StoryObj } from '@storybook/svelte';
import StarredPanelDemo from '../stories/StarredPanelDemo.svelte';
import {
  localEditorStarredFoldersFixture,
  localEditorStarredNotesFixture
} from './fixtures';

const meta = {
  title: 'App/Local Editor/StarredPanel',
  component: StarredPanelDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    folders: localEditorStarredFoldersFixture,
    notes: localEditorStarredNotesFixture,
    activePath: 'projects/active/launch-notes.md',
    mode: 'light'
  }
} satisfies Meta<typeof StarredPanelDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  args: {
    mode: 'dark'
  }
};

export const Empty: Story = {
  args: {
    folders: [],
    notes: [],
    activePath: ''
  }
};

export const EmptyDark: Story = {
  args: {
    folders: [],
    notes: [],
    activePath: '',
    mode: 'dark'
  }
};
