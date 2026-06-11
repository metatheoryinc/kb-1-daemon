import type { Meta, StoryObj } from '@storybook/svelte';
import DocumentSaveBanner, {
  type DocumentSaveBannerProps,
} from './DocumentSaveBanner.svelte';

const noop = () => undefined;

const fixtures = {
  externalMergeNotice: {
    variant: 'external-merge',
    title: 'External edit merged',
    message: 'Merged an edit made outside KB-2.',
    ondismiss: noop,
  },
  externalChangeNotice: {
    variant: 'external-change',
    title: 'Document changed elsewhere',
    message: 'A teammate saved a newer version while this document was open.',
    actionLabel: 'Review changes',
    onaction: noop,
    ondismiss: noop,
  },
  docDeletedAlarm: {
    variant: 'doc-deleted',
    title: 'Document deleted',
    message: 'This file was moved to trash while open. The editor is read-only.',
  },
  persistFailureAlarm: {
    variant: 'persist-failure',
    title: 'Changes are not saving',
    message: 'Keep this tab open. KB-2 will retry automatically when storage responds.',
  },
  persistRecoveredConfirmation: {
    variant: 'persist-recovered',
    title: 'Saving restored',
    message: 'All pending edits have been written to the knowledge base.',
  },
} satisfies Record<string, DocumentSaveBannerProps>;

const meta = {
  title: 'App/Notifications/Document Save Banner',
  component: DocumentSaveBanner,
  parameters: { layout: 'centered' },
  argTypes: {
    variant: {
      control: 'select',
      options: ['external-merge', 'external-change', 'doc-deleted', 'persist-failure', 'persist-recovered'],
    },
  },
} satisfies Meta<typeof DocumentSaveBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ExternalChangeNotice: Story = {
  args: fixtures.externalChangeNotice,
};

export const ExternalMergeNotice: Story = {
  args: fixtures.externalMergeNotice,
};

export const PersistFailureAlarm: Story = {
  args: fixtures.persistFailureAlarm,
};

export const DocDeletedAlarm: Story = {
  args: fixtures.docDeletedAlarm,
};

export const PersistRecoveredConfirmation: Story = {
  args: fixtures.persistRecoveredConfirmation,
};
