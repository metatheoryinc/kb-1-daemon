<script lang="ts">
  import VaultGroup from './VaultGroup.svelte';
  import VaultFilterButton from './VaultFilterButton.svelte';
  import VaultFilterPopover from './VaultFilterPopover.svelte';
  import FilesPanelFooter from './FilesPanelFooter.svelte';
  import type { AccentName } from '../primitives/accent';
  import {
    LOCAL_TREE_DRAG_MIME,
    parseLocalTreeDragSource,
    resolveLocalTreeDrop,
    serializeLocalTreeDragSource,
    type LocalTreeDragSource,
    type LocalTreeDropTarget,
    type LocalTreeMoveDrop,
  } from './tree-drag-drop';
  import type {
    LocalTreeAction,
    LocalTreeNode,
    VaultFilterEntry,
    VaultGroupData,
  } from './types';

  interface Props {
    vaultName: string;
    /** Stable vault id — seeds the tree's expansion keys. Defaults to
        the display name when the shell has nothing more durable. */
    vaultId?: string;
    /** Accent for the vault group's folder token. */
    vaultAccent?: AccentName;
    /** The vaults the rail groups by, each with its own tree. When given,
        the panel renders one group per vault (the multi-vault rail). When
        omitted, the panel synthesizes a single group from the
        `vaultName`/`vaultId`/`vaultAccent`/`tree` props — the
        backward-compatible single-vault shape. */
    vaultGroups?: VaultGroupData[];
    /** Full set of vaults the filter lists. Defaults to the set derived
        from `vaultGroups` (or this panel's own single vault) so a caller
        that only wires the tree still gets a working filter. */
    vaults?: VaultFilterEntry[];
    /** Deny-list of vault ids the user has hidden. Owned by the app. */
    hiddenVaultIds?: string[];
    tree?: LocalTreeNode[];
    activePath?: string;
    /** Which vault the active path belongs to — scopes the active-row
        highlight + favorite menus to that vault's group. Defaults to the
        single vault when there's only one. */
    activeVaultIdForPath?: string;
    /** Active folder row key when a folder is the active canvas. */
    activeFolderId?: string;
    /** Active vault key when the vault root is the active canvas. */
    activeVaultId?: string;
    /** Allow-list of expanded folder keys (`folder:<vaultId>:<path>`). */
    expandedFolderIds?: Set<string>;
    /** Set of expanded vault keys (`vault:<id>`). Omit to render open. */
    expandedVaultIds?: Set<string>;
    /** Set of starred folder paths — threaded to folder rows' menus. */
    favoritedFolderPaths?: Set<string>;
    /** Set of starred note paths — threaded to file rows' menus. */
    favoritedNotePaths?: Set<string>;
    /** When true (mobile), tree-row kebab buttons are always visible. When
        false (desktop), they appear on hover / focus only. */
    kebabAlwaysVisible?: boolean;
    onToggleFolder?: (key: string) => void;
    onToggleVault?: (key: string) => void;
    /** Open a file row — called with the opaque row id
        (`note:<vaultId>:<path>`). */
    onOpenFile?: (key: string) => void;
    /** Navigate to a folder (the three-state row click's open branch). */
    onOpenFolder?: (key: string) => void;
    /** Navigate to the vault root. */
    onOpenVault?: (key: string) => void;
    onTreeAction?: (action: LocalTreeAction) => void;
    onTreeMoveDrop?: (move: LocalTreeMoveDrop) => void;
    /** Add/remove a vault id from the hide-list. */
    onToggleVaultHidden?: (vaultId: string) => void;
    /** Create a new vault (footer affordance). The host collects a name. */
    onNewVault?: () => void;
  }

  let {
    vaultName,
    vaultId = vaultName,
    vaultAccent = 'slate',
    vaultGroups,
    vaults,
    hiddenVaultIds = [],
    tree,
    activePath = '',
    activeVaultIdForPath,
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
    onOpenFolder,
    onOpenVault,
    onTreeAction,
    onTreeMoveDrop,
    onToggleVaultHidden,
    onNewVault,
  }: Props = $props();

  let filterOpen = $state(false);
  let dragSource = $state<LocalTreeDragSource | null>(null);
  let dragOverTarget = $state<LocalTreeDropTarget | null>(null);

  // The vault groups the rail renders. When the host supplies an explicit
  // set, use it (the multi-vault rail); otherwise synthesize a single
  // group from the single-vault props (the backward-compatible shape).
  const groups = $derived<VaultGroupData[]>(
    vaultGroups ?? [
      { id: vaultId, name: vaultName, accent: vaultAccent, tree: tree ?? [] },
    ],
  );
  // Which vault owns the active path. Defaults to the lone group when the
  // host hasn't said (single-vault callers don't need to).
  const activePathVaultId = $derived(
    activeVaultIdForPath ?? (groups.length === 1 ? groups[0].id : undefined),
  );

  // The filter lists every group unless the host overrides the set.
  const allVaults = $derived<VaultFilterEntry[]>(
    vaults ??
      groups.map((g) => ({
        id: g.id,
        name: g.name,
        accent: g.accent,
        metadata: g.metadata,
        colorHex: g.colorHex,
      })),
  );
  const totalVaults = $derived(allVaults.length);
  const hidden = $derived(new Set(hiddenVaultIds));
  // Visible = everything not in the hide-list. Drives the popover's
  // checked state and the "showing N of M" count.
  const selectedIds = $derived(allVaults.map((v) => v.id).filter((id) => !hidden.has(id)));
  const visibleCount = $derived(selectedIds.length);
  const filterLabel = $derived(
    hidden.size === 0
      ? 'All vaults'
      : `${visibleCount} vault${visibleCount === 1 ? '' : 's'}`,
  );

  // The rail renders only the groups the user hasn't hidden. Hiding every
  // vault empties the body; the filter stays available to bring them back.
  const visibleGroups = $derived(groups.filter((g) => !hidden.has(g.id)));

  function isSameDropTarget(
    left: LocalTreeDropTarget | null,
    right: LocalTreeDropTarget,
  ): boolean {
    return left?.kind === right.kind && left.vaultId === right.vaultId && left.path === right.path;
  }

  function readTreeDragSource(event: DragEvent): LocalTreeDragSource | null {
    if (dragSource) return dragSource;
    return parseLocalTreeDragSource(event.dataTransfer?.getData(LOCAL_TREE_DRAG_MIME) ?? null);
  }

  function clearTreeDragState(): void {
    dragSource = null;
    dragOverTarget = null;
  }

  function handleTreeDragStart(source: LocalTreeDragSource, event: DragEvent): void {
    dragSource = source;
    dragOverTarget = null;
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(LOCAL_TREE_DRAG_MIME, serializeLocalTreeDragSource(source));
    event.dataTransfer.setData('text/plain', source.path);
  }

  function handleTreeDropTargetOver(target: LocalTreeDropTarget, event: DragEvent): void {
    const source = readTreeDragSource(event);
    if (!source || !event.dataTransfer) return;

    event.preventDefault();
    event.stopPropagation();
    dragOverTarget = target;
    event.dataTransfer.dropEffect = resolveLocalTreeDrop(source, target).valid ? 'move' : 'none';
  }

  function handleTreeDropTargetLeave(target: LocalTreeDropTarget, event: DragEvent): void {
    event.stopPropagation();
    const currentTarget = event.currentTarget;
    const relatedTarget = event.relatedTarget;
    if (
      currentTarget instanceof Node &&
      relatedTarget instanceof Node &&
      currentTarget.contains(relatedTarget)
    ) {
      return;
    }
    if (isSameDropTarget(dragOverTarget, target)) dragOverTarget = null;
  }

  function handleTreeDropTargetDrop(target: LocalTreeDropTarget, event: DragEvent): void {
    const source = readTreeDragSource(event);
    event.preventDefault();
    event.stopPropagation();
    clearTreeDragState();
    if (!source) return;

    const resolution = resolveLocalTreeDrop(source, target);
    if (resolution.valid) onTreeMoveDrop?.(resolution.move);
  }

  function handlePanelDragOver(event: DragEvent): void {
    if (!dragSource || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
  }

  function handlePanelDrop(event: DragEvent): void {
    if (!dragSource) return;
    event.preventDefault();
    clearTreeDragState();
  }
</script>

<aside
  class="files-panel"
  aria-label="Vault files"
  ondragover={handlePanelDragOver}
  ondrop={handlePanelDrop}
>
  <header class="panel-header">
    <div class="title-row">
      <h2>Files &amp; Vaults</h2>
    </div>

    <div class="filter-row">
      <VaultFilterButton
        open={filterOpen}
        label={filterLabel}
        onclick={() => (filterOpen = !filterOpen)}
      />
      <span class="counts">showing {visibleCount} of {totalVaults}</span>
    </div>

    {#if filterOpen}
      <VaultFilterPopover
        vaults={allVaults}
        {selectedIds}
        onToggle={(id) => onToggleVaultHidden?.(id)}
        onClose={() => (filterOpen = false)}
      />
    {/if}
  </header>

  <div class="panel-body">
    {#if visibleGroups.length === 0}
      <p class="loading">No vaults to show.</p>
    {:else}
      <nav class="tree" aria-label="Files">
        {#each visibleGroups as group (group.id)}
          <VaultGroup
            vaultId={group.id}
            vaultName={group.name}
            accent={group.accent}
            metadata={group.metadata}
            colorHex={group.colorHex}
            tree={group.tree}
            activePath={group.id === activePathVaultId ? activePath : ''}
            activeFolderId={group.id === activePathVaultId ? activeFolderId : undefined}
            activeVaultId={group.id === activePathVaultId ? activeVaultId : undefined}
            {expandedFolderIds}
            {expandedVaultIds}
            {favoritedFolderPaths}
            {favoritedNotePaths}
            {kebabAlwaysVisible}
            {onToggleFolder}
            {onToggleVault}
            {onOpenFile}
            {onOpenFolder}
            {onOpenVault}
            {onTreeAction}
            {dragSource}
            {dragOverTarget}
            onTreeDragStart={handleTreeDragStart}
            onTreeDragEnd={clearTreeDragState}
            onTreeDropTargetOver={handleTreeDropTargetOver}
            onTreeDropTargetLeave={handleTreeDropTargetLeave}
            onTreeDropTargetDrop={handleTreeDropTargetDrop}
          />
        {/each}
      </nav>
    {/if}
  </div>

  <FilesPanelFooter {onNewVault} />
</aside>

<style>
  .files-panel {
    display: grid;
    /* header | scrollable tree | footer (New vault). */
    grid-template-rows: auto minmax(0, 1fr) auto;
    /* Self-sizing secondary panel: holds the resize-handle width and
       refuses to shrink, so the flex-row workspace absorbs the slack. */
    flex-shrink: 0;
    width: var(--rd-mid-w, 282px);
    height: 100%;
    min-width: 0;
    min-height: 0;
    /* Intentional deviation from the reference: no border between the files
       rail and the content canvas — they sit flush, no seam. The resize
       handle still reveals its hairline on hover. */
    background: var(--rd-panel);
  }

  .panel-header {
    position: relative;
    display: grid;
    gap: 10px;
    padding: 14px 14px 12px;
    border-bottom: 1px solid var(--rd-rule);
  }

  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  h2 {
    margin: 0;
    overflow: hidden;
    color: var(--rd-ink-1);
    font-family: var(--rd-ui);
    font-size: 14.5px;
    font-weight: 600;
    letter-spacing: -0.015em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .filter-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .counts {
    color: var(--rd-ink-4);
    font-family: var(--rd-ui);
    font-size: 11px;
  }

  .panel-body {
    min-height: 0;
    overflow: auto;
    padding: 6px;
  }

  .tree {
    display: grid;
    gap: 1px;
  }

  .loading {
    margin: 8px;
    color: var(--rd-ink-4);
    font-family: var(--rd-ui);
    font-size: 12px;
  }
</style>
