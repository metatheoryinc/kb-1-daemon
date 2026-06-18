import type { Meta, StoryObj } from '@storybook/svelte';
import EmptyVaultsStateDemo from '../stories/EmptyVaultsStateDemo.svelte';

const meta = {
  title: 'App/Local Editor/EmptyVaultsState',
  component: EmptyVaultsStateDemo,
  parameters: { layout: 'fullscreen' },
  args: {
    mode: 'light'
  }
} satisfies Meta<typeof EmptyVaultsStateDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = {
  args: {
    mode: 'dark'
  }
};
