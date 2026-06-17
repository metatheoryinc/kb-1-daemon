<script lang="ts">
  import FavoriteButton from '../primitives/FavoriteButton.svelte';
  import Icon from '../primitives/Icon.svelte';
  import IconButton from '../primitives/IconButton.svelte';

  interface Props {
    favorited?: boolean;
    onToggleFavorite?: () => void;
    onRename?: () => void;
    onMove?: () => void;
    onDelete?: () => void;
  }

  let {
    favorited = false,
    onToggleFavorite,
    onRename,
    onMove,
    onDelete,
  }: Props = $props();

  // Transient overflow-popover state. Lives here rather than on
  // app-state because nothing else needs to read it.
  let moreOpen = $state(false);

  const hasMoreActions = $derived(
    Boolean(onRename) || Boolean(onMove) || Boolean(onDelete),
  );

  // Keep `moreOpen` consistent with the render gate: if the action set
  // empties out while the popover is open (e.g., the active context
  // transitions and new context strips the callbacks), close so a
  // later flip back to `hasMoreActions === true` doesn't resurface a
  // stale popover.
  $effect(() => {
    if (!hasMoreActions) moreOpen = false;
  });

  const closeMoreMenu = () => {
    moreOpen = false;
  };

  const runAction = (action: () => void) => {
    action();
    closeMoreMenu();
  };
</script>

<div class="actions">
  <FavoriteButton {favorited} onclick={onToggleFavorite} />
  {#if hasMoreActions}
    <div class="more-wrap">
      <!-- Three-dot glyph at the default `thin` Phosphor weight reads as
           near-invisible at this size. `bold` is the ceiling weight
           before `fill`, which is reserved here for "active state"
           semantics (favorited star); size 18 with bold lands visibly
           heavier without crossing into that loud territory. -->
      <IconButton
        title="More"
        variant={moreOpen ? 'active' : 'quiet'}
        onclick={() => {
          moreOpen = !moreOpen;
        }}
      >
        <Icon name="dots" size={18} weight="bold" />
      </IconButton>
      {#if moreOpen}
        <button
          type="button"
          class="backdrop"
          aria-label="Close menu"
          onclick={closeMoreMenu}
        ></button>
        <div
          class="popover"
          role="menu"
          aria-label="More actions"
          onclick={(event) => event.stopPropagation()}
          onkeydown={(event) => {
            if (event.key === 'Escape') closeMoreMenu();
          }}
          tabindex="-1"
        >
          {#if onRename}
            <button
              type="button"
              class="row"
              role="menuitem"
              onclick={() => runAction(onRename)}
            >
              Rename
            </button>
          {/if}
          {#if onMove}
            <button
              type="button"
              class="row"
              role="menuitem"
              onclick={() => runAction(onMove)}
            >
              Move
            </button>
          {/if}
          {#if onDelete}
            <button
              type="button"
              class="row destructive"
              role="menuitem"
              onclick={() => runAction(onDelete)}
            >
              Delete
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .actions {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    gap: 2px;
    color: var(--rd-ink-3);
  }

  .more-wrap {
    position: relative;
    display: inline-flex;
  }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    border: none;
    padding: 0;
    margin: 0;
    background: transparent;
    cursor: default;
  }

  .popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 50;
    min-width: 168px;
    padding: 6px;
    background: var(--rd-panel);
    border: 1px solid var(--rd-rule-strong);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(31, 28, 22, 0.08), 0 1px 2px rgba(31, 28, 22, 0.04);
  }

  .row {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 12px;
    padding: 6px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--rd-ink-3);
    font-family: var(--rd-ui);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .row:hover,
  .row:focus-visible {
    background: var(--rd-hover);
    outline: none;
  }

  /* Destructive variant mirrors the vault-tree ContextMenu's
     `destructive: true` cue — same `--destructive` token Tailwind's
     `text-destructive` class resolves to. */
  .row.destructive {
    color: var(--destructive);
  }

  .row.destructive:hover,
  .row.destructive:focus-visible {
    background: color-mix(in oklab, var(--destructive) 12%, transparent);
  }
</style>
