import type { Meta, StoryObj } from '@storybook/svelte';
import Icon from './Icon.svelte';

const meta = {
  title: 'App/Primitives/Icon',
  component: Icon,
  args: {
    name: 'search',
    size: 24,
    weight: 'regular'
  },
  argTypes: {
    name: { control: 'select', options: ['search', 'home', 'vault', 'folder', 'file', 'robot', 'star', 'refresh', 'settings', 'codex'] },
    weight: { control: 'select', options: ['thin', 'light', 'regular', 'bold', 'fill', 'duotone'] },
    size: { control: { type: 'range', min: 12, max: 48, step: 2 } }
  }
} satisfies Meta<typeof Icon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
