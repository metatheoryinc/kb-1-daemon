<script lang="ts">
  import VaultGroup from './VaultGroup.svelte';
  import VaultFilterButton from './VaultFilterButton.svelte';
  import VaultFilterPopover from './VaultFilterPopover.svelte';
  import type { AccentName } from '../primitives/accent';
  import type { LocalTreeAction, LocalTreeNode, VaultFilterEntry } from './types';

  interface Props {
    vaultName: string;
    /** Stable vault id — seeds the tree's expansion keys. Defaults to
        the display name when the shell has nothing more durable. */
    vaultId?: string;
    /** Accent for the vault group's folder token. */
    vaultAccent?: AccentName;
    /** Full set of vaults the filter lists. Defaults to a single entry
        built from this panel's own vault so a caller that only wires the
        tree still gets a working filter. */
    vaults?: VaultFilterEntry[];
    /** Deny-list of vault ids the user has hidden. Owned by the app. */
    hiddenVaultIds?: string[];
    tree: LocalTreeNode[];
    activePath?: string;
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
    onOpenFile?: (path: string) => void;
    /** Navigate to a folder (the three-state row click's open branch). */
    onOpenFolder?: (key: string) => void;
    /** Navigate to the vault root. */
    onOpenVault?: (key: string) => void;
    onTreeAction?: (action: LocalTreeAction) => void;
    /** Add/remove a vault id from the hide-list. */
    onToggleVaultHidden?: (vaultId: string) => void;
  }

  let {
    vaultName,
    vaultId = vaultName,
    vaultAccent = 'slate',
    vaults,
    hiddenVaultIds = [],
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
    onOpenFolder,
    onOpenVault,
    onTreeAction,
    onToggleVaultHidden,
  }: Props = $props();

  let filterOpen = $state(false);

  // The filter lists the panel's own vault when no explicit set is given.
  const allVaults = $derived<VaultFilterEntry[]>(
    vaults ?? [{ id: vaultId, name: vaultName, accent: vaultAccent }],
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

  // The tree only renders vaults the user hasn't hidden. The local shell
  // has one vault, so hiding it empties the tree; the filter stays
  // available to bring it back.
  const vaultHidden = $derived(hidden.has(vaultId));
</script>

<aside class="files-panel" aria-label="Vault files">
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
    {#if vaultHidden || tree.length === 0}
      <p class="loading">No notes yet.</p>
    {:else}
      <nav class="tree" aria-label="Files">
        <VaultGroup
          {vaultId}
          {vaultName}
          accent={vaultAccent}
          {tree}
          {activePath}
          {activeFolderId}
          {activeVaultId}
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
        />
      </nav>
    {/if}
  </div>
</aside>

<style>
  .files-panel {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
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
