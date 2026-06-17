import type { Meta, StoryObj } from '@storybook/svelte';
import { INITIAL_VIEWPORTS } from 'storybook/viewport';
import LocalEditorMobileShellDemo from '../stories/LocalEditorMobileShellDemo.svelte';

/**
 * The mobile editor shell, locked to a phone viewport so the mobile
 * chrome (full-screen left-nav flyout, single-row top bar) renders at
 * its real width. The demo opens with the flyout already open so the
 * rail + files panel are visible; tap the backdrop or the close button
 * to dismiss it and reveal the canvas underneath.
 */
const meta = {
  title: 'App/Local Editor/LocalEditorMobileShell',
  component: LocalEditorMobileShellDemo,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: INITIAL_VIEWPORTS,
    },
  },
} satisfies Meta<typeof LocalEditorMobileShellDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fixture: Story = {
  globals: {
    viewport: { value: 'iphone14' },
  },
};
