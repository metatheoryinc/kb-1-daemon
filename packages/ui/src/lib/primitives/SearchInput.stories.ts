import type { Meta, StoryObj } from '@storybook/svelte';
import SearchInputDemo from '../stories/SearchInputDemo.svelte';

const meta = {
  title: 'App/Primitives/SearchInput',
  component: SearchInputDemo,
  args: {
    value: 'filesystem'
  }
} satisfies Meta<typeof SearchInputDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithValue: Story = {};

export const Empty: Story = {
  args: {
    value: ''
  }
};
