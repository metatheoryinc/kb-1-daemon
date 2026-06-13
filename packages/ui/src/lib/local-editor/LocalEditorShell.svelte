<script lang="ts">
  import FilesPanel from './FilesPanel.svelte';
  import DocumentHeader from './DocumentHeader.svelte';
  import type { LocalSearchResult, LocalTreeAction, LocalTreeNode } from './types';

  interface Props {
    vaultName: string;
    daemonLabel: string;
    daemonStatus?: 'open' | 'connecting' | 'closed' | 'error';
    documentPath: string;
    colorMode?: 'light' | 'dark';
    searchValue?: string;
    tree: LocalTreeNode[];
    expandedPaths?: Set<string>;
    searchResults?: LocalSearchResult[];
    searchTotal?: number;
    searchTruncated?: boolean;
    searchLoading?: boolean;
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
    searchValue = '',
    tree,
    expandedPaths = new Set<string>(),
    searchResults = [],
    searchTotal = searchResults.length,
    searchTruncated = false,
    searchLoading = false,
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
  <FilesPanel
    {vaultName}
    {daemonLabel}
    {daemonStatus}
    {colorMode}
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
    {onToggleColorMode}
    {onToggleFolder}
    {onOpenFile}
    {onTreeAction}
  />

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
    grid-template-columns: minmax(240px, 280px) minmax(0, 1fr);
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
      grid-template-columns: minmax(176px, 42vw) minmax(0, 1fr);
    }
  }
</style>
