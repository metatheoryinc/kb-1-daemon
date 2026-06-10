import type { Meta, StoryObj } from '@storybook/svelte';
import PrimitiveGallery from '../stories/PrimitiveGallery.svelte';

const meta = {
  title: 'App/Primitives/Gallery',
  component: PrimitiveGallery,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof PrimitiveGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ImportedPrimitives: Story = {};
