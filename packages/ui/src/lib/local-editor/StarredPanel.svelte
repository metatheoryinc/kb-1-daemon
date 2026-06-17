<script lang="ts">
  /**
   * The starred panel — the middle-column view the rail shows in
   * "starred" mode. Sits in the secondary-panel slot of the shell,
   * alongside `FilesPanel` — same `--rd-mid-w` width, same border
   * treatment.
   *
   * Sticky filter semantics: this panel stays mounted as long as the
   * Starred rail mode is active. Clicking a row opens its target in the
   * canvas without dismissing the panel — mode swap only happens when
   * the user picks a different rail entry.
   *
   * Reuses `StarredRow` for rendering and the same Folders / Notes
   * grouping. The local shell has a single vault, so there is no Vaults
   * group; folders and notes are the groups that apply. Prop-driven
   * only: the app builds the rows + owns persistence.
   */
  import StarredRow from './StarredRow.svelte';
  import Icon from '../primitives/Icon.svelte';
  import type { StarredRowData } from './types';

  interface Props {
    /** Starred folder rows, most-recently-starred first. */
    folders?: StarredRowData[];
    /** Starred note rows, most-recently-starred first. */
    notes?: StarredRowData[];
    /** Path of the open document — highlights the matching row. */
    activePath?: string;
    /** Fires when the user picks any starred row. The mobile shell can
     *  pass a closure to close its flyout on terminal selection; the
     *  desktop shell leaves this unset (sticky panel). */
    onPick?: () => void;
  }

  let {
    folders = [],
    notes = [],
    activePath = '',
    onPick,
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
                meta={`in ${row.vaultLabel}`}
                kind={row.kind}
                accent={row.accent}
                colorHex={row.colorHex}
                icon={row.icon}
                href={row.href}
                available={row.available}
                active={row.path === activePath}
                onpick={onPick}
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
                meta={`in ${row.vaultLabel}`}
                kind={row.kind}
                accent={row.accent}
                colorHex={row.colorHex}
                icon={row.icon}
                href={row.href}
                available={row.available}
                active={row.path === activePath}
                onpick={onPick}
              />
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  </div>
</aside>

<style>
  /* Width / chrome match `FilesPanel` so the Starred mode reads as the
     same kind of object — a middle-column panel. */
  .starred-panel {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
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
    scrollbar-width: thin;
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
    font-family: var(--rd-serif);
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
