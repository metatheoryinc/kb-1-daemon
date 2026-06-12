<script lang="ts">
  import Icon from '../primitives/Icon.svelte';
  import ContextMenu from '../menus/ContextMenu.svelte';
  import type { LocalFileNode, LocalTreeAction } from './types';
  import type { MenuItem } from '../menus/ContextMenu.svelte';

  interface Props {
    node: LocalFileNode;
    activePath?: string;
    onOpen?: (path: string) => void;
    onAction?: (action: LocalTreeAction) => void;
  }

  let { node, activePath = '', onOpen, onAction }: Props = $props();
  let menuPosition = $state<{ mode: 'cursor'; x: number; y: number } | null>(null);
  const active = $derived(activePath === node.path);

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
  <button
    type="button"
    class="row"
    class:active
    aria-current={active ? 'page' : undefined}
    oncontextmenu={openMenu}
    onclick={() => onOpen?.(node.path)}
  >
    <Icon name="file" size={14} />
    <span class="label">{node.name}</span>
  </button>

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
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 28px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--rd-ink-2);
    padding: 4px 8px;
    font-family: var(--rd-ui);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }

  .row:hover {
    background: var(--rd-hover);
    color: var(--rd-ink-1);
  }

  .row.active {
    background: var(--rd-panel-alt);
    color: var(--rd-ink-1);
    font-weight: 600;
  }

  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
