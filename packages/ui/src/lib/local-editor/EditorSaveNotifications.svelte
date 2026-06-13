<script lang="ts" module>
  import type {
    EditorSaveNotificationFlags,
    EditorSaveNotificationsCopy,
  } from './editor-save-notifications';

  export interface EditorSaveNotificationsProps extends EditorSaveNotificationFlags {
    copy: EditorSaveNotificationsCopy;
    onDismissExternalMerge?: () => void;
    onDismissExternalChange?: () => void;
  }
</script>

<script lang="ts">
  import DocumentSaveBanner from '../notifications/DocumentSaveBanner.svelte';
  import { getVisibleEditorSaveNotificationVariants } from './editor-save-notifications';

  let {
    externalMergeVisible,
    externalChangeVisible,
    persistFailureActive,
    persistRecoveredVisible,
    docDeleted,
    copy,
    onDismissExternalMerge,
    onDismissExternalChange,
  }: EditorSaveNotificationsProps = $props();

  const visibleVariants = $derived(
    getVisibleEditorSaveNotificationVariants({
      externalMergeVisible,
      externalChangeVisible,
      persistFailureActive,
      persistRecoveredVisible,
      docDeleted,
    }),
  );
</script>

{#if visibleVariants.length > 0}
  <section class="notification-stack" aria-label="Document save notifications">
    {#each visibleVariants as variant}
      {#if variant === 'external-merge'}
        <DocumentSaveBanner
          variant="external-merge"
          title={copy.externalMerge.title}
          message={copy.externalMerge.message}
          dismissLabel={copy.externalMerge.dismissLabel}
          ondismiss={onDismissExternalMerge}
        />
      {:else if variant === 'external-change'}
        <DocumentSaveBanner
          variant="external-change"
          title={copy.externalChange.title}
          message={copy.externalChange.message}
          dismissLabel={copy.externalChange.dismissLabel}
          ondismiss={onDismissExternalChange}
        />
      {:else if variant === 'persist-failure'}
        <DocumentSaveBanner
          variant="persist-failure"
          title={copy.persistFailure.title}
          message={copy.persistFailure.message}
        />
      {:else if variant === 'doc-deleted'}
        <DocumentSaveBanner
          variant="doc-deleted"
          title={copy.docDeleted.title}
          message={copy.docDeleted.message}
        />
      {/if}
    {/each}
  </section>
{/if}

<style>
  .notification-stack {
    position: fixed;
    top: 14px;
    right: 16px;
    z-index: 40;
    display: grid;
    gap: 8px;
    width: min(420px, calc(100vw - 32px));
    pointer-events: none;
  }

  .notification-stack :global(.document-save-banner) {
    pointer-events: auto;
  }

  @media (max-width: 720px) {
    .notification-stack {
      top: 10px;
      right: 10px;
      width: calc(100vw - 20px);
    }
  }
</style>
