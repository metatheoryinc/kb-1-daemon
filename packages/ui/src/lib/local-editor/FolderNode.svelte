<script lang="ts">
  import ContextMenu from '../menus/ContextMenu.svelte';
  import FolderIcon from '../primitives/FolderIcon.svelte';
  import Icon from '../primitives/Icon.svelte';
  import FileNode from './FileNode.svelte';
  import FolderNode from './FolderNode.svelte';
  import { folderKey } from './expansion';
  import { ROOT_DEFAULT_COLOR, resolveFolderColor } from './folder-presentation';
  import {
    resolveLocalTreeDrop,
    type LocalTreeDragSource,
    type LocalTreeDropTarget,
  } from './tree-drag-drop';
  import type { LocalFolderNode, LocalTreeAction, LocalTreeNode } from './types';
  import type { MenuItem } from '../menus/ContextMenu.svelte';

  // Recursively count notes under a set of tree nodes — descendants
  // included, not just direct children.
  function countNotes(children: LocalTreeNode[]): number {
    let total = 0;
    for (const child of children) {
      if (child.kind === 'file') total += 1;
      else total += countNotes(child.children);
    }
    return total;
  }

  interface Props {
    node: LocalFolderNode;
    /** Vault id the row belongs to. Used to mint the opaque expansion
        key (`folder:<vaultId>:<path>`) the shell's store reads. */
    vaultId: string;
    activePath?: string;
    /** Currently-selected folder row key (when the canvas is a folder
        view). Highlights the matching row, same active treatment as a
        file row. Keyed by the opaque folder key (`folder:<vaultId>:<path>`),
        the same identity the expansion set uses. */
    activeFolderId?: string;
    /** Allow-list of expanded folder keys. The single source of truth
        for whether a row is open — the shell owns this set. */
    expandedFolderIds?: Set<string>;
    depth?: number;
    inheritedColor?: string;
    /** Set of starred folder paths — drives this row's menu item. */
    favoritedFolderPaths?: Set<string>;
    /** Set of starred note paths — threaded to descendant file rows. */
    favoritedNotePaths?: Set<string>;
    /** When true, the kebab (`…`) button is always visible on this row and
        all descendant rows (mobile). When false (desktop), it appears on
        hover / focus only. */
    kebabAlwaysVisible?: boolean;
    /** Toggle a folder row. Called with the row's opaque key. */
    onToggleFolder?: (key: string) => void;
    onOpen?: (path: string) => void;
    /** Navigate to the folder itself (the open-folder destination).
        Called with the row's opaque key. Part of the three-state row
        click: an already-open, not-active folder activates instead of
        collapsing. When unset, that branch is a no-op. */
    onOpenFolder?: (key: string) => void;
    onAction?: (action: LocalTreeAction) => void;
    dragSource?: LocalTreeDragSource | null;
    dragOverTarget?: LocalTreeDropTarget | null;
    onTreeDragStart?: (source: LocalTreeDragSource, event: DragEvent) => void;
    onTreeDragEnd?: () => void;
    onTreeDropTargetOver?: (target: LocalTreeDropTarget, event: DragEvent) => void;
    onTreeDropTargetLeave?: (target: LocalTreeDropTarget, event: DragEvent) => void;
    onTreeDropTargetDrop?: (target: LocalTreeDropTarget, event: DragEvent) => void;
  }

  let {
    node,
    vaultId,
    activePath = '',
    activeFolderId,
    expandedFolderIds = new Set<string>(),
    depth = 0,
    inheritedColor = ROOT_DEFAULT_COLOR,
    favoritedFolderPaths,
    favoritedNotePaths,
    kebabAlwaysVisible = false,
    onToggleFolder,
    onOpen,
    onOpenFolder,
    onAction,
    dragSource = null,
    dragOverTarget = null,
    onTreeDragStart,
    onTreeDragEnd,
    onTreeDropTargetOver,
    onTreeDropTargetLeave,
    onTreeDropTargetDrop,
  }: Props = $props();

  // The kebab and right-click open the same menu; the kebab hangs from the
  // button rect (anchor) while right-click pins to the cursor.
  let menuPosition = $state<
    { mode: 'cursor'; x: number; y: number } | { mode: 'anchor'; rect: DOMRect } | null
  >(null);
  const key = $derived(folderKey(vaultId, node.path));
  const open = $derived(expandedFolderIds.has(key));
  const active = $derived(activeFolderId === key);
  const favorited = $derived(favoritedFolderPaths?.has(node.path) ?? false);
  const indent = $derived(12 + depth * 14);
  // Recursive note count under this folder — every descendant note, not
  // just direct children. Answers "how big is this folder?", matching the
  // count shown on the folder row.
  const count = $derived(countNotes(node.children));
  const folderColor = $derived(resolveFolderColor(node.metadata, inheritedColor));
  const source = $derived<LocalTreeDragSource>({
    kind: 'folder',
    vaultId,
    path: node.path,
  });
  const dropTarget = $derived<LocalTreeDropTarget>({
    kind: 'folder',
    vaultId,
    path: node.path,
  });
  const dragging = $derived(
    dragSource?.kind === source.kind &&
      dragSource.vaultId === source.vaultId &&
      dragSource.path === source.path,
  );
  const dropState = $derived.by<'valid' | 'invalid' | null>(() => {
    if (!dragSource || !dragOverTarget) return null;
    if (
      dragOverTarget.kind !== dropTarget.kind ||
      dragOverTarget.vaultId !== dropTarget.vaultId ||
      dragOverTarget.path !== dropTarget.path
    ) {
      return null;
    }
    return resolveLocalTreeDrop(dragSource, dropTarget).valid ? 'valid' : 'invalid';
  });

  const items = $derived<MenuItem[]>([
    { label: 'New Note', onSelect: () => onAction?.({ kind: 'folder', action: 'new-note', path: node.path }) },
    { label: 'New Folder', onSelect: () => onAction?.({ kind: 'folder', action: 'new-folder', path: node.path }) },
    { label: 'Customize', onSelect: () => onAction?.({ kind: 'folder', action: 'customize', path: node.path }) },
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

  function openKebabMenu(event: MouseEvent): void {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menuPosition = { mode: 'anchor', rect };
  }

  // Three-state folder-row click:
  //   closed              → expand only (no nav)
  //   open + not active   → activate (route to the folder)
  //   open + active       → collapse
  // The caret is a separate path that ONLY toggles, never navigates — so
  // a user who just wants to expand or collapse a folder doesn't trip the
  // navigate branch.
  function handleClick(): void {
    if (!open) {
      onToggleFolder?.(key);
      return;
    }
    if (active) {
      onToggleFolder?.(key);
      return;
    }
    onOpenFolder?.(key);
  }

  function handleCaretClick(event: MouseEvent): void {
    event.stopPropagation();
    onToggleFolder?.(key);
  }
</script>

<div class="folder-node" style:--depth={depth}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="row"
    class:active
    class:dragging
    class:drop-valid={dropState === 'valid'}
    class:drop-invalid={dropState === 'invalid'}
    draggable="true"
    style="padding-left: {indent}px;"
    oncontextmenu={openMenu}
    ondragstart={(event) => onTreeDragStart?.(source, event)}
    ondragend={() => onTreeDragEnd?.()}
    ondragover={(event) => onTreeDropTargetOver?.(dropTarget, event)}
    ondragleave={(event) => onTreeDropTargetLeave?.(dropTarget, event)}
    ondrop={(event) => onTreeDropTargetDrop?.(dropTarget, event)}
  >
    <button
      type="button"
      class="caret"
      aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
      aria-expanded={open}
      draggable="false"
      onclick={handleCaretClick}
    >
      <span class="chev" class:collapsed={!open} aria-hidden="true">
        <Icon name="chevron-down" size={12} weight="bold" />
      </span>
    </button>
    <button
      type="button"
      class="activate"
      aria-current={active ? 'page' : undefined}
      draggable="false"
      onclick={handleClick}
    >
      <FolderIcon color={folderColor} size="sm" variant="filled" label={`${node.name} folder`} />
      <span class="name">{node.name}</span>
    </button>
    <span class="count">{count}</span>
    <button
      type="button"
      class="kebab"
      class:always-visible={kebabAlwaysVisible}
      aria-label={`Actions for ${node.name}`}
      title={`Actions for ${node.name}`}
      draggable="false"
      onclick={openKebabMenu}
    >
      <Icon name="dots" size={14} weight="bold" />
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
            {activeFolderId}
            {expandedFolderIds}
            depth={depth + 1}
            inheritedColor={folderColor}
            {favoritedFolderPaths}
            {favoritedNotePaths}
            {kebabAlwaysVisible}
            {onToggleFolder}
            {onOpen}
            {onOpenFolder}
            {onAction}
            {dragSource}
            {dragOverTarget}
            {onTreeDragStart}
            {onTreeDragEnd}
            {onTreeDropTargetOver}
            {onTreeDropTargetLeave}
            {onTreeDropTargetDrop}
          />
        {:else}
          <FileNode
            node={child}
            {vaultId}
            depth={depth + 1}
            {activePath}
            {favoritedNotePaths}
            {kebabAlwaysVisible}
            {onOpen}
            {onAction}
            {dragSource}
            {onTreeDragStart}
            {onTreeDragEnd}
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
    box-sizing: border-box;
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
  }

  .row.active {
    background: var(--rd-active);
    color: var(--rd-ink-1);
    font-weight: 500;
  }

  .row.dragging {
    opacity: 0.48;
  }

  .row.drop-valid {
    background: color-mix(in srgb, var(--rd-active) 78%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rd-ink-3) 34%, transparent);
  }

  .row.drop-invalid {
    background: color-mix(in srgb, var(--rd-danger-ink, #a13a3a) 12%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rd-danger-ink, #a13a3a) 42%, transparent);
  }

  .row.dragging .activate {
    cursor: grabbing;
  }

  .row.drop-invalid .activate {
    cursor: not-allowed;
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

  /* Recursive note count, dimmed + monospaced, sitting at the row's
     trailing edge. */
  .count {
    flex-shrink: 0;
    color: var(--rd-ink-4);
    font-family: var(--rd-mono);
    font-size: 10px;
  }

  /* Kebab (`…`) trigger — same visibility model as FileNode. Hidden via
     `display: none` so it claims no flex space until hover / focus; when
     it appears the trailing count slides left to make room. */
  .kebab {
    display: none;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    margin-left: 2px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--rd-ink-3);
    cursor: pointer;
    transition: background 80ms ease;
  }

  .row:hover .kebab,
  .kebab:focus-visible,
  .kebab.always-visible {
    display: inline-flex;
  }

  .kebab:hover {
    background: var(--rd-panel-alt);
    color: var(--rd-ink-1);
  }

  /* At/below the mobile breakpoint (760px, the desktop-shell breakpoint)
     the kebab is always visible — touch users have no right-click. */
  @media (max-width: 760px) {
    .kebab {
      display: inline-flex;
    }
  }

  .children {
    display: grid;
    gap: 1px;
  }
</style>
