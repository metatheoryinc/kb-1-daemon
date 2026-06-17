<script lang="ts">
  import Breadcrumb from '../primitives/Breadcrumb.svelte';
  import type { BreadcrumbItem } from '../primitives/Breadcrumb.svelte';
  import LiveStatusChip from '../primitives/LiveStatusChip.svelte';
  import DocumentHeaderMenu from './DocumentHeaderMenu.svelte';

  interface Props {
    breadcrumbItems: BreadcrumbItem[];
    statusLabel?: string;
    favorited?: boolean;
    onToggleFavorite?: () => void;
    onRename?: () => void;
    onMove?: () => void;
    onDelete?: () => void;
  }

  let {
    breadcrumbItems,
    statusLabel,
    favorited = false,
    onToggleFavorite,
    onRename,
    onMove,
    onDelete,
  }: Props = $props();
</script>

<header class="document-header">
  <div class="grid">
    <div class="breadcrumb-cell">
      <Breadcrumb items={breadcrumbItems} />
    </div>

    <div class="meta-cell">
      {#if statusLabel}
        <LiveStatusChip label={statusLabel} />
      {/if}
    </div>

    <div class="actions-cell">
      <DocumentHeaderMenu
        {favorited}
        {onToggleFavorite}
        {onRename}
        {onMove}
        {onDelete}
      />
    </div>
  </div>
</header>

<style>
  .document-header {
    container-type: inline-size;
    border-bottom: 1px solid var(--rd-rule);
    background: var(--rd-panel);
    min-height: 62px;
  }

  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    grid-template-areas: 'breadcrumb meta actions';
    column-gap: 14px;
    align-items: center;
    padding: 14px 28px;
    min-height: inherit;
    box-sizing: border-box;
  }

  .breadcrumb-cell {
    grid-area: breadcrumb;
    display: flex;
    min-width: 0;
    align-items: center;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    /* Fade the right edge to hint that the breadcrumb scrolls when it
       overflows. The mask only paints when content actually overflows
       because at smaller widths the trail is what extends past the cell. */
    mask-image: linear-gradient(to right, black calc(100% - 24px), transparent);
    -webkit-mask-image: linear-gradient(to right, black calc(100% - 24px), transparent);
  }

  .breadcrumb-cell::-webkit-scrollbar {
    display: none;
  }

  .meta-cell {
    grid-area: meta;
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }

  .actions-cell {
    grid-area: actions;
    display: flex;
    align-items: center;
  }

  /* At narrow container widths the header stays a single, vertically
     centered row: only the breadcrumb cell yields space (it has
     min-width: 0 and scrolls/truncates within its own column), while
     the meta + actions cells keep their `auto` track and stay on the
     line. The grid lives on an inner element so the @container query
     can target it — a container can only be queried by its
     descendants, not by itself. */
  @container (max-width: 720px) {
    .grid {
      column-gap: 10px;
      padding: 12px 20px;
    }
  }
</style>
