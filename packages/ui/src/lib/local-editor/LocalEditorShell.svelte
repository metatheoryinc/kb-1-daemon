<script lang="ts">
  import FilesPanel from './FilesPanel.svelte';
  import StarredPanel from './StarredPanel.svelte';
  import DocumentHeader from './DocumentHeader.svelte';
  import PrimaryRail, { type RailNavId } from './primary-rail/PrimaryRail.svelte';
  import type { LocalSearchResult, LocalTreeAction, LocalTreeNode } from './types';

  interface Props {
    vaultName: string;
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
    expandedPaths?: Set<string>;
    searchResults?: LocalSearchResult[];
    searchTotal?: number;
    searchTruncated?: boolean;
    searchLoading?: boolean;
    onSelectNav?: (id: RailNavId) => void;
    onSearchInput?: (value: string) => void;
    onSearchClear?: () => void;
    onToggleColorMode?: () => void;
    onToggleFolder?: (path: string) => void;
    onOpenFile?: (path: string) => void;
    onTreeAction?: (action: LocalTreeAction) => void;
    children?: import('svelte').Snippet;
  }

  let {
    vaultName,
    daemonLabel,
    daemonStatus = 'open',
    documentPath,
    colorMode = 'light',
    colorModeChoice = 'system',
    activeNav = 'files',
    userLabel = 'Local user',
    searchValue = '',
    tree,
    expandedPaths = new Set<string>(),
    searchResults = [],
    searchTotal = searchResults.length,
    searchTruncated = false,
    searchLoading = false,
    onSelectNav,
    onSearchInput,
    onSearchClear,
    onToggleColorMode,
    onToggleFolder,
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
      {daemonLabel}
      {daemonStatus}
      {searchValue}
      {tree}
      activePath={documentPath}
      {expandedPaths}
      {searchResults}
      {searchTotal}
      {searchTruncated}
      {searchLoading}
      {onSearchInput}
      {onSearchClear}
      {onToggleFolder}
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
