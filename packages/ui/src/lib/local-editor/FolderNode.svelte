<script lang="ts">
  import ContextMenu from '../menus/ContextMenu.svelte';
  import FolderIcon from '../primitives/FolderIcon.svelte';
  import Icon from '../primitives/Icon.svelte';
  import { accentHex } from '../primitives/accent';
  import FileNode from './FileNode.svelte';
  import FolderNode from './FolderNode.svelte';
  import { folderKey } from './expansion';
  import type { LocalFolderNode, LocalTreeAction } from './types';
  import type { MenuItem } from '../menus/ContextMenu.svelte';

  interface Props {
    node: LocalFolderNode;
    /** Vault id the row belongs to. Used to mint the opaque expansion
        key (`folder:<vaultId>:<path>`) the shell's store reads. */
    vaultId: string;
    activePath?: string;
    /** Allow-list of expanded folder keys. The single source of truth
        for whether a row is open — the shell owns this set. */
    expandedFolderIds?: Set<string>;
    depth?: number;
    /** Set of starred folder paths — drives this row's menu item. */
    favoritedFolderPaths?: Set<string>;
    /** Set of starred note paths — threaded to descendant file rows. */
    favoritedNotePaths?: Set<string>;
    /** Toggle a folder row. Called with the row's opaque key. */
    onToggleFolder?: (key: string) => void;
    onOpen?: (path: string) => void;
    onAction?: (action: LocalTreeAction) => void;
  }

  let {
    node,
    vaultId,
    activePath = '',
    expandedFolderIds = new Set<string>(),
    depth = 0,
    favoritedFolderPaths,
    favoritedNotePaths,
    onToggleFolder,
    onOpen,
    onAction,
  }: Props = $props();

  let menuPosition = $state<{ mode: 'cursor'; x: number; y: number } | null>(null);
  const key = $derived(folderKey(vaultId, node.path));
  const open = $derived(expandedFolderIds.has(key));
  const favorited = $derived(favoritedFolderPaths?.has(node.path) ?? false);
  const indent = $derived(12 + depth * 14);
  const folderColor = $derived(accentHex[node.metadata?.color ?? 'slate']);
  const folderIcon = $derived(node.metadata?.icon ?? null);

  const items = $derived<MenuItem[]>([
    { label: 'New Note', onSelect: () => onAction?.({ kind: 'folder', action: 'new-note', path: node.path }) },
    { label: 'New Folder', onSelect: () => onAction?.({ kind: 'folder', action: 'new-folder', path: node.path }) },
    favorited
      ? { label: 'Unfavorite', onSelect: () => onAction?.({ kind: 'folder', action: 'unfavorite', path: node.path }) }
      : { label: 'Favorite', onSelect: () => onAction?.({ kind: 'folder', action: 'favorite', path: node.path }) },
    { label: 'Rename', onSelect: () => onAction?.({ kind: 'folder', action: 'rename', path: node.path }) },
    { label: 'Move', onSelect: () => onAction?.({ kind: 'folder', action: 'move', path: node.path }) },
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

  function toggle(): void {
    onToggleFolder?.(key);
  }

  // Caret click toggles without opening the canvas; the row body click
  // toggles too — a single-vault tree has no separate folder canvas, so
  // both affordances collapse to the same toggle.
  function handleCaretClick(event: MouseEvent): void {
    event.stopPropagation();
    toggle();
  }
</script>

<div class="folder-node" style:--depth={depth}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="row"
    style="padding-left: {indent}px;"
    oncontextmenu={openMenu}
  >
    <button
      type="button"
      class="caret"
      aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
      aria-expanded={open}
      onclick={handleCaretClick}
    >
      <span class="chev" class:collapsed={!open} aria-hidden="true">
        <Icon name="chevron-down" size={12} weight="bold" />
      </span>
    </button>
    <button type="button" class="activate" onclick={toggle}>
      <FolderIcon color={folderColor} icon={folderIcon} size="sm" variant="filled" label={`${node.name} folder`} />
      <span class="name">{node.name}</span>
    </button>
  </div>

  {#if open}
    <div class="children">
      {#each node.children as child (child.path)}
        {#if child.kind === 'folder'}
          <FolderNode
            node={child}
            {vaultId}
            {activePath}
            {expandedFolderIds}
            depth={depth + 1}
            {favoritedFolderPaths}
            {favoritedNotePaths}
            {onToggleFolder}
            {onOpen}
            {onAction}
          />
        {:else}
          <FileNode
            node={child}
            depth={depth + 1}
            {activePath}
            {favoritedNotePaths}
            {onOpen}
            {onAction}
          />
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

  .row:hover {
    background: var(--rd-hover);
    color: var(--rd-ink-1);
  }

  .caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: inherit;
    padding: 0;
    cursor: pointer;
  }

  .chev {
    display: inline-flex;
    align-items: center;
    color: var(--rd-ink-3);
    opacity: 0.85;
    transition: transform 200ms ease;
  }

  .chev.collapsed {
    transform: rotate(-90deg);
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

  .name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .children {
    display: grid;
    gap: 1px;
  }
</style>
