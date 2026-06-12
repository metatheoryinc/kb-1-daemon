<script lang="ts">
  import ContextMenu from '../menus/ContextMenu.svelte';
  import FolderIcon from '../primitives/FolderIcon.svelte';
  import Icon from '../primitives/Icon.svelte';
  import { accentHex, accentNames, type AccentName } from '../primitives/accent';
  import FileNode from './FileNode.svelte';
  import FolderNode from './FolderNode.svelte';
  import type { LocalFolderNode, LocalTreeAction } from './types';
  import type { MenuItem } from '../menus/ContextMenu.svelte';

  interface Props {
    node: LocalFolderNode;
    activePath?: string;
    expandedPaths?: Set<string>;
    depth?: number;
    onToggle?: (path: string) => void;
    onOpen?: (path: string) => void;
    onAction?: (action: LocalTreeAction) => void;
  }

  let {
    node,
    activePath = '',
    expandedPaths = new Set<string>(),
    depth = 0,
    onToggle,
    onOpen,
    onAction,
  }: Props = $props();

  let menuPosition = $state<{ mode: 'cursor'; x: number; y: number } | null>(null);
  const expanded = $derived(expandedPaths.has(node.path));
  const folderColor = $derived(accentHex[node.metadata?.color ?? 'slate']);
  const folderIcon = $derived(node.metadata?.icon ?? null);

  const items = $derived<MenuItem[]>([
    { label: 'New Note', onSelect: () => onAction?.({ kind: 'folder', action: 'new-note', path: node.path }) },
    { label: 'New Folder', onSelect: () => onAction?.({ kind: 'folder', action: 'new-folder', path: node.path }) },
    { label: 'Rename', onSelect: () => onAction?.({ kind: 'folder', action: 'rename', path: node.path }) },
    { label: 'Move', onSelect: () => onAction?.({ kind: 'folder', action: 'move', path: node.path }) },
    {
      kind: 'swatches',
      label: 'Color',
      swatches: accentNames.map((accent) => ({
        label: accent,
        color: accentHex[accent],
        selected: node.metadata?.color === accent,
        onSelect: () => onAction?.({ kind: 'folder', action: 'color', path: node.path, color: accent as AccentName })
      }))
    },
    {
      label: 'Delete',
      destructive: true,
      onSelect: () => onAction?.({ kind: 'folder', action: 'delete', path: node.path })
    }
  ]);

  function openMenu(event: MouseEvent): void {
    event.preventDefault();
    menuPosition = { mode: 'cursor', x: event.clientX, y: event.clientY };
  }
</script>

<div class="folder-node" style:--depth={depth}>
  <button
    type="button"
    class="row"
    aria-expanded={expanded}
    oncontextmenu={openMenu}
    onclick={() => onToggle?.(node.path)}
  >
    <span class="chevron" class:expanded>
      <Icon name="chevron" size={11} weight="bold" />
    </span>
    <FolderIcon color={folderColor} icon={folderIcon} size="sm" label={`${node.name} folder`} />
    <span class="label">{node.name}</span>
  </button>

  {#if expanded}
    <div class="children">
      {#each node.children as child (child.path)}
        {#if child.kind === 'folder'}
          <FolderNode
            node={child}
            {activePath}
            {expandedPaths}
            depth={depth + 1}
            {onToggle}
            {onOpen}
            {onAction}
          />
        {:else}
          <div class="file-indent">
            <FileNode node={child} {activePath} {onOpen} {onAction} />
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if menuPosition}
    <ContextMenu
      items={items}
      position={menuPosition}
      ariaLabel={`Folder actions for ${node.path}`}
      onclose={() => {
        menuPosition = null;
      }}
    />
  {/if}
</div>

<style>
  .folder-node {
    --indent: calc(var(--depth) * 14px);
  }

  .row {
    display: grid;
    grid-template-columns: 12px 16px minmax(0, 1fr);
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 28px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--rd-ink-2);
    padding: 4px 8px 4px calc(8px + var(--indent));
    font-family: var(--rd-ui);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }

  .row:hover {
    background: var(--rd-hover);
    color: var(--rd-ink-1);
  }

  .chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--rd-ink-4);
    transform: rotate(-90deg);
    transition: transform 100ms ease;
  }

  .chevron.expanded {
    transform: rotate(0deg);
  }

  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .children {
    display: grid;
    gap: 1px;
  }

  .file-indent {
    padding-left: calc(var(--indent) + 14px);
  }
</style>
