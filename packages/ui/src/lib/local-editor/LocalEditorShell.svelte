<script lang="ts">
  import FilesPanel from './FilesPanel.svelte';
  import StarredPanel from './StarredPanel.svelte';
  import DocumentHeader from './DocumentHeader.svelte';
  import PrimaryRail, { type RailNavId } from './primary-rail/PrimaryRail.svelte';
  import type { AccentName } from '../primitives/accent';
  import type { LocalSearchResult, LocalTreeAction, LocalTreeNode } from './types';

  interface Props {
    vaultName: string;
    /** Stable vault id seeding the tree's expansion keys. */
    vaultId?: string;
    /** Accent for the vault group's folder token. */
    vaultAccent?: AccentName;
    daemonLabel: string;
    daemonStatus?: 'open' | 'connecting' | 'closed' | 'error';
    documentPath: string;
    colorMode?: 'light' | 'dark';
    /** Persisted color-mode preference (light / dark / system). Drives the
        rail toggle's icon; the resolved `colorMode` above drives surfaces
        that need a concrete light-or-dark value. */
    colorModeChoice?: 'light' | 'dark' | 'system';
    /** Which secondary panel is shown — the files tree or the starred view. */
    activeNav?: RailNavId;
    userLabel?: string;
    searchValue?: string;
    tree: LocalTreeNode[];
    /** Allow-list of expanded folder keys (`folder:<vaultId>:<path>`). */
    expandedFolderIds?: Set<string>;
    /** Set of expanded vault keys. Omit to render the vault open. */
    expandedVaultIds?: Set<string>;
    searchResults?: LocalSearchResult[];
    searchTotal?: number;
    searchTruncated?: boolean;
    searchLoading?: boolean;
    onSelectNav?: (id: RailNavId) => void;
    onSearchInput?: (value: string) => void;
    onSearchClear?: () => void;
    onToggleColorMode?: () => void;
    onToggleFolder?: (key: string) => void;
    onToggleVault?: (key: string) => void;
    onOpenFile?: (path: string) => void;
    onTreeAction?: (action: LocalTreeAction) => void;
    children?: import('svelte').Snippet;
  }

  let {
    vaultName,
    vaultId = vaultName,
    vaultAccent = 'slate',
    daemonLabel,
    daemonStatus = 'open',
    documentPath,
    colorMode = 'light',
    colorModeChoice = 'system',
    activeNav = 'files',
    userLabel = 'Local user',
    searchValue = '',
    tree,
    expandedFolderIds = new Set<string>(),
    expandedVaultIds,
    searchResults = [],
    searchTotal = searchResults.length,
    searchTruncated = false,
    searchLoading = false,
    onSelectNav,
    onSearchInput,
    onSearchClear,
    onToggleColorMode,
    onToggleFolder,
    onToggleVault,
    onOpenFile,
    onTreeAction,
    children,
  }: Props = $props();
</script>

<main class="local-editor-shell">
  <PrimaryRail
    {activeNav}
    colorMode={colorModeChoice}
    {userLabel}
    {onSelectNav}
    {onToggleColorMode}
  />

  {#if activeNav === 'starred'}
    <StarredPanel />
  {:else}
    <FilesPanel
      {vaultName}
      {vaultId}
      {vaultAccent}
      {daemonLabel}
      {daemonStatus}
      {searchValue}
      {tree}
      activePath={documentPath}
      {expandedFolderIds}
      {expandedVaultIds}
      {searchResults}
      {searchTotal}
      {searchTruncated}
      {searchLoading}
      {onSearchInput}
      {onSearchClear}
      {onToggleFolder}
      {onToggleVault}
      {onOpenFile}
      {onTreeAction}
    />
  {/if}

  <section class="workspace" aria-label="Document workspace">
    <DocumentHeader {vaultName} path={documentPath} />
    <div class="editor-region">
      {@render children?.()}
    </div>
  </section>
</main>

<style>
  .local-editor-shell {
    display: grid;
    grid-template-columns: var(--rd-rail-w-collapsed) minmax(240px, 280px) minmax(0, 1fr);
    width: 100%;
    min-height: 100vh;
    max-height: 100vh;
    background: var(--rd-bg);
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
    overflow: hidden;
  }

  .workspace {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
  }

  .editor-region {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  @media (max-width: 760px) {
    .local-editor-shell {
      grid-template-columns: var(--rd-rail-w-collapsed) minmax(176px, 42vw) minmax(0, 1fr);
    }
  }
</style>
