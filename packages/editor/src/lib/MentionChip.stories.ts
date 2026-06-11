import type { Meta, StoryObj } from '@storybook/svelte';
import MentionChipStory from './stories/MentionChipStory.svelte';

const meta = {
  title: 'App/Editor/MentionChip',
  component: MentionChipStory,
} satisfies Meta<typeof MentionChipStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {};
