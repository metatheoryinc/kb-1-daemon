<script lang="ts">
  /**
   * One row in the starred panel. Mirrors the visual vocabulary of the
   * tree row (leading swatch + title + secondary meta) so the starred
   * view feels of-a-piece with the rest of the shell.
   *
   * Renders as `<a>` when `href` is set; otherwise as a non-clickable
   * `<div>` with reduced opacity to communicate "this row's target is no
   * longer available." Removing a row from here isn't part of the panel —
   * the document header owns the star toggle.
   *
   * Folder + note rows render with a `FolderIcon` swatch tinted by the
   * resolved folder color (folder color for folder rows; parent folder
   * color for note rows). Rows with no resolved color fall back to the
   * palette accent dot.
   */
  import Icon from '../primitives/Icon.svelte';
  import { accentStyle, type AccentName } from '../primitives/accent';
  import type { IconName } from '../primitives/types';
  import FolderIcon from '../primitives/FolderIcon.svelte';

  interface Props {
    label: string;
    /** Secondary line — typically the parent vault. */
    meta: string;
    /** "folder" / "note" — drives the leading icon. */
    kind: 'note' | 'folder';
    accent?: AccentName;
    /** Resolved hex color for folder + note rows. When null, the row
     *  falls back to the `accent` palette swatch. */
    colorHex?: string | null;
    /** Folder customize-icon glyph (folder rows only). */
    icon?: string | null;
    href?: string;
    /** When false, render dimmed and as a static element rather than a link. */
    available?: boolean;
    /** When this row's target IS the currently-viewed canvas, render with
     *  the selected treatment so the user can see "you're already here".
     *  Mirrors the tree's selected-row visual. */
    active?: boolean;
    /** Fires alongside the link's native navigation when the row is
     *  clicked. The link's `href` drives the actual route change; this
     *  callback is only for shell-side side effects. */
    onpick?: () => void;
  }

  let {
    label,
    meta,
    kind,
    accent = 'slate',
    colorHex = null,
    icon = null,
    href,
    available = true,
    active = false,
    onpick,
  }: Props = $props();

  const iconName = $derived<IconName>(kind === 'note' ? 'file' : 'folder');
  // Folder + note rows tint by folder color when supplied. Notes get the
  // outline-variant FolderIcon (matches the file-leaf treatment); folders
  // get the filled variant + their optional icon glyph. Rows with no
  // resolved color keep the palette accent dot.
  const showFolderSwatch = $derived(colorHex !== null);
</script>

{#snippet leading()}
  {#if showFolderSwatch}
    <FolderIcon
      color={colorHex}
      icon={kind === 'folder' ? icon : null}
      size="sm"
      variant={kind === 'note' ? 'outline' : 'filled'}
    />
  {:else}
    <span class="dot" aria-hidden="true"></span>
    <span class="leading-icon" aria-hidden="true">
      <Icon name={iconName} size={13} weight="regular" />
    </span>
  {/if}
{/snippet}

{#if href}
  <a
    class="row"
    class:active
    {href}
    style={accentStyle(accent)}
    aria-current={active ? 'page' : undefined}
    onclick={() => onpick?.()}
  >
    {@render leading()}
    <div class="body">
      <span class="label">{label}</span>
      <span class="meta">{meta}</span>
    </div>
    <span class="open" aria-hidden="true">
      <Icon name="chevron" size={11} weight="regular" />
    </span>
  </a>
{:else}
  <div
    class="row unavailable"
    style={accentStyle(accent)}
    aria-disabled={available ? undefined : 'true'}
    title="No longer available"
  >
    {@render leading()}
    <div class="body">
      <span class="label">{label}</span>
      <span class="meta">{meta} · unavailable</span>
    </div>
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 7px;
    background: transparent;
    color: inherit;
    text-decoration: none;
    transition: background 80ms ease;
  }

  a.row {
    cursor: pointer;
  }

  a.row:hover {
    background: var(--rd-hover);
  }

  a.row:hover .open {
    opacity: 1;
  }

  a.row:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--rd-ink-3) 40%, transparent);
    outline-offset: -2px;
  }

  /* Selected row: same treatment the tree uses for its active row, so
     "you're already viewing this" reads consistently across the panel
     and the tree. The chevron is always visible on active so it doesn't
     depend on hover to communicate that the row is the current target. */
  a.row.active {
    background: var(--rd-hover-strong, var(--rd-hover));
    color: var(--rd-ink-1);
  }

  a.row.active .label {
    font-weight: 600;
  }

  a.row.active .open {
    opacity: 1;
  }

  .row.unavailable {
    opacity: 0.5;
    cursor: default;
  }

  .dot {
    flex-shrink: 0;
    width: 10px;
    height: 10px;
    border-radius: 3px;
    background: var(--rd-accent-bg);
    border: 1px solid color-mix(in srgb, var(--rd-accent) 55%, transparent);
  }

  .leading-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--rd-ink-3);
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

  .open {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    color: var(--rd-ink-4);
    opacity: 0;
    transition: opacity 80ms ease;
  }
</style>
