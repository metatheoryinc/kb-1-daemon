<script lang="ts">
  import Avatar from '../primitives/Avatar.svelte';
  import FolderIcon from '../primitives/FolderIcon.svelte';
  import Icon from '../primitives/Icon.svelte';
  import ContextMenu from '../menus/ContextMenu.svelte';
  import type { AccentName } from '../primitives/accent';
  import type { MenuItem } from '../menus/ContextMenu.svelte';
  import FileNode from './FileNode.svelte';
  import FolderNode from './FolderNode.svelte';
  import { vaultKey } from './expansion';
  import { ROOT_DEFAULT_COLOR, resolveFolderColor } from './folder-presentation';
  import {
    resolveLocalTreeDrop,
    type LocalTreeDragSource,
    type LocalTreeDropTarget,
  } from './tree-drag-drop';
  import type { LocalFolderMetadata, LocalTreeAction, LocalTreeNode } from './types';

  interface Props {
    /** Stable vault identifier — also the seed for every child folder's
        expansion key (`folder:<vaultId>:<path>`). */
    vaultId: string;
    /** Display name shown in the group header. */
    vaultName: string;
    /** Accent for the header's folder token. Defaults to a neutral slate. */
    accent?: AccentName;
    metadata?: LocalFolderMetadata;
    colorHex?: string | null;
    tree: LocalTreeNode[];
    activePath?: string;
    /** Currently-selected folder row key (when a folder is the active
        canvas). Threaded to folder rows for active highlighting. */
    activeFolderId?: string;
    /** Active vault key (`vault:<id>`) when the vault root itself is the
        active canvas. Highlights the header with the same active
        treatment as a selected folder row. */
    activeVaultId?: string;
    /** Allow-list of expanded folder keys, owned by the shell. */
    expandedFolderIds?: Set<string>;
    /** Set of vault keys (`vault:<id>`) currently expanded. The shell
        derives this as the complement of its collapsed deny-list, so a
        vault renders open by default. When omitted (Storybook without
        wiring) the group renders open. */
    expandedVaultIds?: Set<string>;
    /** Set of starred folder paths — threaded to folder rows' menus. */
    favoritedFolderPaths?: Set<string>;
    /** Set of starred note paths — threaded to file rows' menus. */
    favoritedNotePaths?: Set<string>;
    /** When true, the kebab (`…`) button is always visible on the vault
        header and every descendant row (mobile). When false (desktop), it
        appears on hover / focus only. */
    kebabAlwaysVisible?: boolean;
    onToggleFolder?: (key: string) => void;
    /** Toggle this vault group's expansion. Called with the vault key. */
    onToggleVault?: (key: string) => void;
    /** Open a file row. Called with the opaque row id
        (`note:<vaultId>:<path>`) so the host routes to the owning vault. */
    onOpenFile?: (key: string) => void;
    /** Navigate to the vault root. Called with the vault key on a header
        click, alongside the expansion toggle. When unset, the header
        click only toggles. */
    onOpenVault?: (key: string) => void;
    /** Navigate to a folder. Threaded to folder rows for the three-state
        row click. */
    onOpenFolder?: (key: string) => void;
    onTreeAction?: (action: LocalTreeAction) => void;
    dragSource?: LocalTreeDragSource | null;
    dragOverTarget?: LocalTreeDropTarget | null;
    onTreeDragStart?: (source: LocalTreeDragSource, event: DragEvent) => void;
    onTreeDragEnd?: () => void;
    onTreeDropTargetOver?: (target: LocalTreeDropTarget, event: DragEvent) => void;
    onTreeDropTargetLeave?: (target: LocalTreeDropTarget, event: DragEvent) => void;
    onTreeDropTargetDrop?: (target: LocalTreeDropTarget, event: DragEvent) => void;
  }

  let {
    vaultId,
    vaultName,
    accent = 'slate',
    metadata,
    colorHex = null,
    tree,
    activePath = '',
    activeFolderId,
    activeVaultId,
    expandedFolderIds = new Set<string>(),
    expandedVaultIds,
    favoritedFolderPaths,
    favoritedNotePaths,
    kebabAlwaysVisible = false,
    onToggleFolder,
    onToggleVault,
    onOpenFile,
    onOpenVault,
    onOpenFolder,
    onTreeAction,
    dragSource = null,
    dragOverTarget = null,
    onTreeDragStart,
    onTreeDragEnd,
    onTreeDropTargetOver,
    onTreeDropTargetLeave,
    onTreeDropTargetDrop,
  }: Props = $props();

  const key = $derived(vaultKey(vaultId));
  // Vaults default open: an undefined set (Storybook) renders open, and
  // a wired set means "open iff present" (the shell already complemented
  // its collapsed deny-list).
  const open = $derived(expandedVaultIds === undefined || expandedVaultIds.has(key));
  const active = $derived(activeVaultId === key);
  const inheritedColor = $derived(resolveFolderColor(metadata, ROOT_DEFAULT_COLOR));
  const customColor = $derived(colorHex ?? (metadata?.color && metadata.color !== 'inherit' ? metadata.color : null));
  const dropTarget = $derived<LocalTreeDropTarget>({
    kind: 'vault',
    vaultId,
    path: '',
  });
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

  // The kebab and right-click open the same menu; the kebab hangs from the
  // button rect (anchor) while right-click pins to the cursor.
  let menuPosition = $state<
    { mode: 'cursor'; x: number; y: number } | { mode: 'anchor'; rect: DOMRect } | null
  >(null);

  // Vault-menu items stamp THIS group's `vaultId` onto every action, so a
  // host listing more than one vault knows which one the menu acted on.
  const items = $derived<MenuItem[]>([
    { label: 'New Note', onSelect: () => onTreeAction?.({ kind: 'vault', action: 'new-note', vaultId }) },
    { label: 'New Folder', onSelect: () => onTreeAction?.({ kind: 'vault', action: 'new-folder', vaultId }) },
    { label: 'Customize', onSelect: () => onTreeAction?.({ kind: 'vault', action: 'customize', vaultId }) },
    { label: 'Rename', onSelect: () => onTreeAction?.({ kind: 'vault', action: 'rename', vaultId }) },
    {
      label: 'Delete',
      destructive: true,
      onSelect: () => onTreeAction?.({ kind: 'vault', action: 'delete', vaultId })
    }
  ]);

  // Header click toggles expansion and navigates to the vault root — the
  // expansion always flips, the navigate is a no-op when unwired.
  function handleClick(): void {
    onToggleVault?.(key);
    onOpenVault?.(key);
  }

  function openMenu(event: MouseEvent): void {
    event.preventDefault();
    menuPosition = { mode: 'cursor', x: event.clientX, y: event.clientY };
  }

  function openKebabMenu(event: MouseEvent): void {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menuPosition = { mode: 'anchor', rect };
  }
</script>

<div class="vault-block">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="vault-header"
    class:active
    class:drop-valid={dropState === 'valid'}
    class:drop-invalid={dropState === 'invalid'}
    data-testid="vault-row"
    oncontextmenu={openMenu}
    ondragover={(event) => onTreeDropTargetOver?.(dropTarget, event)}
    ondragleave={(event) => onTreeDropTargetLeave?.(dropTarget, event)}
    ondrop={(event) => onTreeDropTargetDrop?.(dropTarget, event)}
  >
    <button
      type="button"
      class="activate"
      onclick={handleClick}
      aria-expanded={open}
      aria-current={active ? 'page' : undefined}
      draggable="false"
    >
      <span class="chev" class:collapsed={!open} aria-hidden="true">
        <Icon name="chevron-down" size={12} weight="bold" />
      </span>
      {#if customColor}
        <FolderIcon color={customColor} size="sm" label={vaultName} />
      {:else}
        <Avatar kind="folder" {accent} size={16} />
      {/if}
      <span class="name">{vaultName}</span>
    </button>
    <button
      type="button"
      class="kebab"
      class:always-visible={kebabAlwaysVisible}
      aria-label={`Actions for ${vaultName}`}
      title={`Actions for ${vaultName}`}
      draggable="false"
      onclick={openKebabMenu}
    >
      <Icon name="dots" size={16} weight="bold" />
    </button>
  </div>

  {#if open}
    <div class="children">
      {#each tree as node (node.path)}
        {#if node.kind === 'folder'}
          <FolderNode
            {node}
            {vaultId}
            {activePath}
            {activeFolderId}
            {expandedFolderIds}
            {inheritedColor}
            {favoritedFolderPaths}
            {favoritedNotePaths}
            {kebabAlwaysVisible}
            {onToggleFolder}
            onOpen={onOpenFile}
            {onOpenFolder}
            onAction={onTreeAction}
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
            {node}
            {vaultId}
            {activePath}
            {favoritedNotePaths}
            {kebabAlwaysVisible}
            onOpen={onOpenFile}
            onAction={onTreeAction}
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
      {items}
      position={menuPosition}
      ariaLabel={`Vault actions for ${vaultName}`}
      onclose={() => {
        menuPosition = null;
      }}
    />
  {/if}
</div>

<style>
  .vault-block {
    margin: 4px 0 6px;
  }

  .vault-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 6px;
    border-radius: 6px;
    background: transparent;
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
    font-size: 12.5px;
    font-weight: 500;
  }

  .vault-header:hover:not(.active) {
    background: var(--rd-hover);
  }

  .vault-header.active {
    background: var(--rd-active);
    color: var(--rd-ink-1);
  }

  .vault-header.drop-valid {
    background: color-mix(in srgb, var(--rd-active) 78%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rd-ink-3) 34%, transparent);
  }

  .vault-header.drop-invalid {
    background: color-mix(in srgb, var(--rd-danger-ink, #a13a3a) 12%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rd-danger-ink, #a13a3a) 42%, transparent);
  }

  .vault-header.drop-invalid .activate {
    cursor: not-allowed;
  }

  .activate {
    display: flex;
    align-items: center;
    gap: 8px;
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

  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Kebab (`…`) trigger. Toggled via opacity + pointer-events (the vault
     header always reserves the slot, so the layout doesn't shift). Size 22
     matches the vault row's slightly chunkier register. */
  .kebab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    margin-left: 2px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--rd-ink-3);
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 80ms ease, background 80ms ease;
  }

  .vault-header:hover .kebab,
  .kebab:focus-visible,
  .kebab.always-visible {
    opacity: 1;
    pointer-events: auto;
  }

  .kebab:hover {
    background: var(--rd-panel-alt);
    color: var(--rd-ink-1);
  }

  /* At/below the mobile breakpoint (760px, the desktop-shell breakpoint)
     the kebab is always visible — touch users have no right-click. */
  @media (max-width: 760px) {
    .kebab {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .children {
    padding-left: 12px;
    display: grid;
    gap: 1px;
  }
</style>
