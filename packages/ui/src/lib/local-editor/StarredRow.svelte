<script lang="ts">
  /**
   * One row in the starred panel. Mirrors the tree's row vocabulary —
   * a tinted folder/file swatch, a label, and a secondary meta line —
   * so the starred view reads as of-a-piece with the files tree.
   *
   * Notes and folders here open in-canvas rather than navigating, so the
   * row is a button that calls `onpick(path)` rather than an `<a href>`.
   * A trailing star toggle unstars the row in place. When the target is
   * no longer available the row dims and the pick button is disabled,
   * but the unstar control stays live so the user can clear a stale pin.
   */
  import Icon from '../primitives/Icon.svelte';
  import FolderIcon from '../primitives/FolderIcon.svelte';
  import { accentHex, type AccentName } from '../primitives/accent';

  interface Props {
    label: string;
    /** Secondary line — typically the parent folder / vault context. */
    meta: string;
    kind: 'note' | 'folder';
    /** Accent driving the leading swatch tint. */
    accent?: AccentName;
    /** Vault-relative path; passed back on pick / unstar. */
    path: string;
    /** When `false`, render dimmed and disable the open action. */
    available?: boolean;
    /** When this row's target is the open document, render selected. */
    active?: boolean;
    /** Open the row's target in the canvas. */
    onpick?: (path: string) => void;
    /** Remove this row from favorites. */
    onunstar?: (path: string) => void;
  }

  let {
    label,
    meta,
    kind,
    accent = 'slate',
    path,
    available = true,
    active = false,
    onpick,
    onunstar,
  }: Props = $props();

  const colorHex = $derived(accentHex[accent]);
</script>

<div class="row" class:active class:unavailable={!available}>
  <button
    type="button"
    class="activate"
    disabled={!available}
    aria-current={active ? 'page' : undefined}
    onclick={() => available && onpick?.(path)}
  >
    <span class="leading" aria-hidden="true">
      <FolderIcon
        color={colorHex}
        icon={null}
        size="sm"
        variant={kind === 'note' ? 'outline' : 'filled'}
      />
    </span>
    <span class="body">
      <span class="label">{label}</span>
      <span class="meta">{available ? meta : `${meta} · unavailable`}</span>
    </span>
  </button>
  <button
    type="button"
    class="unstar"
    title="Remove from starred"
    aria-label={`Remove ${label} from starred`}
    onclick={() => onunstar?.(path)}
  >
    <Icon name="star" size={13} weight="fill" />
  </button>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 4px 8px;
    border-radius: 7px;
    background: transparent;
    transition: background 80ms ease;
  }

  .row:hover {
    background: var(--rd-hover);
  }

  .row.active {
    background: var(--rd-active, var(--rd-hover));
  }

  .row.active .label {
    font-weight: 600;
  }

  .row.unavailable {
    opacity: 0.5;
  }

  .activate {
    display: flex;
    align-items: center;
    gap: 9px;
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 6px 2px;
    cursor: pointer;
  }

  .activate:disabled {
    cursor: default;
  }

  .leading {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .label {
    color: var(--rd-ink-1);
    font-family: var(--rd-ui);
    font-size: 13px;
    font-weight: 500;
    letter-spacing: -0.005em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .meta {
    color: var(--rd-ink-4);
    font-family: var(--rd-ui);
    font-size: 11.5px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .unstar {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--rd-accent-star, #e0a93b);
    cursor: pointer;
    opacity: 0.85;
    transition:
      opacity 80ms ease,
      background 80ms ease;
  }

  .unstar:hover {
    opacity: 1;
    background: var(--rd-hover-strong, var(--rd-hover));
  }

  .unstar:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--rd-ink-3) 40%, transparent);
    outline-offset: -2px;
  }
</style>
