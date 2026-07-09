import type { Meta, StoryObj } from '@storybook/svelte';
import EditorSaveNotifications, {
  type EditorSaveNotificationsProps,
} from './EditorSaveNotifications.svelte';

const noop = () => undefined;

const localCopy = {
  externalMerge: {
    title: 'External edit merged',
    message: 'Merged an edit made outside KB-1.',
  },
  externalChange: {
    title: 'File changed outside KB-1',
    message: 'This file changed outside KB-1 and was reloaded from disk.',
  },
  persistFailure: {
    title: 'Changes are NOT saving to disk.',
    message: 'Keep this tab open. KB-1 will keep retrying until saving recovers.',
  },
  docDeleted: {
    title: 'Document deleted',
    message: 'This file was deleted or moved to trash. The editor is read-only.',
  },
} satisfies EditorSaveNotificationsProps['copy'];

const meta = {
  title: 'App/Local Editor/Editor Save Notifications',
  component: EditorSaveNotifications,
  parameters: { layout: 'fullscreen' },
  args: {
    externalMergeVisible: true,
    externalChangeVisible: false,
    persistFailureActive: false,
    persistRecoveredVisible: false,
    docDeleted: false,
    copy: localCopy,
    onDismissExternalMerge: noop,
    onDismissExternalChange: noop,
  },
} satisfies Meta<typeof EditorSaveNotifications>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ExternalMerge: Story = {};

export const ExternalChange: Story = {
  args: {
    externalMergeVisible: false,
    externalChangeVisible: true,
  },
};

export const PersistFailure: Story = {
  args: {
    externalMergeVisible: false,
    persistFailureActive: true,
  },
};

export const DocDeleted: Story = {
  args: {
    externalMergeVisible: false,
    docDeleted: true,
  },
};

export const Stack: Story = {
  args: {
    externalChangeVisible: true,
    persistFailureActive: true,
    docDeleted: true,
  },
};

export const PersistRecoveredSuppressed: Story = {
  args: {
    externalMergeVisible: false,
    persistRecoveredVisible: true,
  },
};
