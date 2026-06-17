<script lang="ts">
  import Avatar from '../primitives/Avatar.svelte';
  import Icon from '../primitives/Icon.svelte';
  import ContextMenu from '../menus/ContextMenu.svelte';
  import type { AccentName } from '../primitives/accent';
  import type { MenuItem } from '../menus/ContextMenu.svelte';
  import FileNode from './FileNode.svelte';
  import FolderNode from './FolderNode.svelte';
  import { vaultKey } from './expansion';
  import type { LocalTreeAction, LocalTreeNode } from './types';

  interface Props {
    /** Stable vault identifier — also the seed for every child folder's
        expansion key (`folder:<vaultId>:<path>`). */
    vaultId: string;
    /** Display name shown in the group header. */
    vaultName: string;
    /** Accent for the header's folder token. Defaults to a neutral slate. */
    accent?: AccentName;
    tree: LocalTreeNode[];
    activePath?: string;
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
    onOpenFile?: (path: string) => void;
    onTreeAction?: (action: LocalTreeAction) => void;
  }

  let {
    vaultId,
    vaultName,
    accent = 'slate',
    tree,
    activePath = '',
    expandedFolderIds = new Set<string>(),
    expandedVaultIds,
    favoritedFolderPaths,
    favoritedNotePaths,
    kebabAlwaysVisible = false,
    onToggleFolder,
    onToggleVault,
    onOpenFile,
    onTreeAction,
  }: Props = $props();

  const key = $derived(vaultKey(vaultId));
  // Vaults default open: an undefined set (Storybook) renders open, and
  // a wired set means "open iff present" (the shell already complemented
  // its collapsed deny-list).
  const open = $derived(expandedVaultIds === undefined || expandedVaultIds.has(key));

  // The kebab and right-click open the same menu; the kebab hangs from the
  // button rect (anchor) while right-click pins to the cursor.
  let menuPosition = $state<
    { mode: 'cursor'; x: number; y: number } | { mode: 'anchor'; rect: DOMRect } | null
  >(null);

  const items = $derived<MenuItem[]>([
    { label: 'New Note', onSelect: () => onTreeAction?.({ kind: 'vault', action: 'new-note' }) },
    { label: 'New Folder', onSelect: () => onTreeAction?.({ kind: 'vault', action: 'new-folder' }) },
    { label: 'Rename', onSelect: () => onTreeAction?.({ kind: 'vault', action: 'rename' }) },
    {
      label: 'Delete',
      destructive: true,
      onSelect: () => onTreeAction?.({ kind: 'vault', action: 'delete' })
    }
  ]);

  function toggle(): void {
    onToggleVault?.(key);
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
  <div class="vault-header" data-testid="vault-row" oncontextmenu={openMenu}>
    <button type="button" class="activate" onclick={toggle} aria-expanded={open}>
      <span class="chev" class:collapsed={!open} aria-hidden="true">
        <Icon name="chevron-down" size={12} weight="bold" />
      </span>
      <Avatar kind="folder" {accent} size={16} />
      <span class="name">{vaultName}</span>
    </button>
    <button
      type="button"
      class="kebab"
      class:always-visible={kebabAlwaysVisible}
      aria-label={`Actions for ${vaultName}`}
      title={`Actions for ${vaultName}`}
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
            {expandedFolderIds}
            {favoritedFolderPaths}
            {favoritedNotePaths}
            {kebabAlwaysVisible}
            {onToggleFolder}
            onOpen={onOpenFile}
            onAction={onTreeAction}
          />
        {:else}
          <FileNode
            {node}
            {activePath}
            {favoritedNotePaths}
            {kebabAlwaysVisible}
            onOpen={onOpenFile}
            onAction={onTreeAction}
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

  .vault-header:hover {
    background: var(--rd-hover);
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
