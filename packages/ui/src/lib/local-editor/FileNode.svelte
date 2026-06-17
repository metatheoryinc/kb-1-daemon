<script lang="ts">
  import Icon from '../primitives/Icon.svelte';
  import ContextMenu from '../menus/ContextMenu.svelte';
  import type { LocalFileNode, LocalTreeAction } from './types';
  import type { MenuItem } from '../menus/ContextMenu.svelte';

  interface Props {
    node: LocalFileNode;
    /** Nesting depth — drives indentation so a file aligns under its
        folder's label rather than its caret. */
    depth?: number;
    activePath?: string;
    onOpen?: (path: string) => void;
    onAction?: (action: LocalTreeAction) => void;
  }

  let { node, depth = 0, activePath = '', onOpen, onAction }: Props = $props();
  let menuPosition = $state<{ mode: 'cursor'; x: number; y: number } | null>(null);
  const active = $derived(activePath === node.path);
  // Mirror the folder indent (12 + depth * 14) plus a 4px nudge so the
  // file icon lands under the folder label, not under the caret.
  const indent = $derived(12 + depth * 14 + 4);

  const items = $derived<MenuItem[]>([
    { label: 'Rename', onSelect: () => onAction?.({ kind: 'file', action: 'rename', path: node.path }) },
    { label: 'Move', onSelect: () => onAction?.({ kind: 'file', action: 'move', path: node.path }) },
    {
      label: 'Delete',
      destructive: true,
      onSelect: () => onAction?.({ kind: 'file', action: 'delete', path: node.path })
    }
  ]);

  function openMenu(event: MouseEvent): void {
    event.preventDefault();
    menuPosition = { mode: 'cursor', x: event.clientX, y: event.clientY };
  }
</script>

<div class="file-node">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="row"
    class:active
    style="padding-left: {indent}px;"
    oncontextmenu={openMenu}
  >
    <button
      type="button"
      class="activate"
      aria-current={active ? 'page' : undefined}
      onclick={() => onOpen?.(node.path)}
    >
      <span class="spacer" aria-hidden="true"></span>
      <span class="file-icon" aria-hidden="true">
        <Icon name="file" size={13} />
      </span>
      <span class="label">{node.name}</span>
    </button>
  </div>

  {#if menuPosition}
    <ContextMenu
      items={items}
      position={menuPosition}
      ariaLabel={`File actions for ${node.path}`}
      onclose={() => {
        menuPosition = null;
      }}
    />
  {/if}
</div>

<style>
  .file-node {
    position: relative;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 28px;
    border-radius: 6px;
    background: transparent;
    color: var(--rd-ink-2);
    padding: 4px 6px;
    font-family: var(--rd-ui);
    font-size: 12px;
  }

  .row:hover:not(.active) {
    background: var(--rd-hover);
    color: var(--rd-ink-1);
  }

  .row.active {
    background: var(--rd-active);
    color: var(--rd-ink-1);
    font-weight: 500;
  }

  .activate {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    padding: 0;
  }

  .spacer {
    display: inline-block;
    width: 10px;
    flex-shrink: 0;
  }

  .file-icon {
    display: inline-flex;
    align-items: center;
    color: var(--rd-ink-3);
    opacity: 0.72;
  }

  .label {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
