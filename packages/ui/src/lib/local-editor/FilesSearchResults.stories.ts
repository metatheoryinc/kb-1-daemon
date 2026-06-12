import type { Meta, StoryObj } from '@storybook/svelte';
import FilesSearchResults from './FilesSearchResults.svelte';
import { localEditorSearchFixture } from './fixtures';

const meta = {
  title: 'App/Local Editor/FilesSearchResults',
  component: FilesSearchResults,
  args: {
    query: 'editor',
    results: localEditorSearchFixture,
    total: 64,
    truncated: true
  }
} satisfies Meta<typeof FilesSearchResults>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Results: Story = {};
