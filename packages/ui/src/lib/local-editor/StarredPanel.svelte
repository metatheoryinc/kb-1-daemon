<script lang="ts">
  /**
   * The starred (favorites) panel — the middle-column view the rail
   * shows in "starred" mode. Renders the app's starred notes and folders
   * grouped Folders-then-Notes, each row clickable to open in-canvas and
   * unstar-able in place. Falls back to the empty-state when nothing is
   * pinned. Prop-driven only: the app builds the rows + owns persistence.
   */
  import Icon from '../primitives/Icon.svelte';
  import StarredRow from './StarredRow.svelte';
  import type { StarredRowData } from './types';

  interface Props {
    /** Starred folder rows, most-recently-starred first. */
    folders?: StarredRowData[];
    /** Starred note rows, most-recently-starred first. */
    notes?: StarredRowData[];
    /** Path of the open document — highlights the matching row. */
    activePath?: string;
    /** Open a starred row's target in the canvas. */
    onOpen?: (path: string) => void;
    /** Remove a row from favorites by path + kind. */
    onUnstar?: (entry: { kind: 'note' | 'folder'; path: string }) => void;
  }

  let {
    folders = [],
    notes = [],
    activePath = '',
    onOpen,
    onUnstar,
  }: Props = $props();

  const total = $derived(folders.length + notes.length);
</script>

<aside class="starred-panel" aria-label="Starred">
  <header class="head">
    <h2 class="title">Starred</h2>
    <p class="hint">Pinned notes and folders</p>
  </header>

  <div class="body">
    {#if total === 0}
      <div class="empty">
        <span class="empty-icon" aria-hidden="true">
          <Icon name="star" size={22} weight="regular" />
        </span>
        <p class="empty-title">No starred items yet</p>
        <p class="empty-hint">
          Star a note or folder to see it here.
        </p>
      </div>
    {:else}
      {#if folders.length > 0}
        <section class="group">
          <header class="group-head">
            <h3 class="group-label">Folders · {folders.length}</h3>
          </header>
          <div class="rows">
            {#each folders as row (row.id)}
              <StarredRow
                label={row.label}
                meta="folder"
                kind={row.kind}
                accent={row.accent}
                path={row.path}
                available={row.available}
                active={row.path === activePath}
                onpick={(path) => onOpen?.(path)}
                onunstar={(path) => onUnstar?.({ kind: 'folder', path })}
              />
            {/each}
          </div>
        </section>
      {/if}

      {#if notes.length > 0}
        <section class="group">
          <header class="group-head">
            <h3 class="group-label">Notes · {notes.length}</h3>
          </header>
          <div class="rows">
            {#each notes as row (row.id)}
              <StarredRow
                label={row.label}
                meta="note"
                kind={row.kind}
                accent={row.accent}
                path={row.path}
                available={row.available}
                active={row.path === activePath}
                onpick={(path) => onOpen?.(path)}
                onunstar={(path) => onUnstar?.({ kind: 'note', path })}
              />
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  </div>
</aside>

<style>
  .starred-panel {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    /* Self-sizing secondary panel — mirrors FilesPanel so the two share
       one width and neither collapses inside the flex-row shell. */
    flex-shrink: 0;
    width: var(--rd-mid-w, 282px);
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--rd-panel);
    border-right: 1px solid var(--rd-rule);
    color: var(--rd-ink-1);
    font-family: var(--rd-ui);
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 18px 18px 14px;
    border-bottom: 1px solid var(--rd-rule);
  }

  .title {
    margin: 0;
    color: var(--rd-ink-1);
    font-size: 14.5px;
    font-weight: 600;
    letter-spacing: -0.015em;
  }

  .hint {
    margin: 0;
    color: var(--rd-ink-4);
    font-size: 11.5px;
  }

  .body {
    min-height: 0;
    overflow-y: auto;
    padding: 10px 10px 14px;
  }

  .group + .group {
    margin-top: 12px;
  }

  .group-head {
    margin: 0 0 4px 8px;
  }

  .group-label {
    margin: 0;
    color: var(--rd-ink-4);
    font-family: var(--rd-ui);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 40px 16px;
    color: var(--rd-ink-4);
  }

  .empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    margin-bottom: 10px;
    border-radius: 12px;
    background: var(--rd-hover);
    color: var(--rd-ink-3);
  }

  .empty-title {
    margin: 0 0 2px;
    color: var(--rd-ink-2);
    font-size: 14px;
    font-weight: 500;
    letter-spacing: -0.005em;
  }

  .empty-hint {
    margin: 0;
    max-width: 220px;
    font-size: 11.5px;
    line-height: 1.4;
  }
</style>
