<script lang="ts">
  import IconButton from '../primitives/IconButton.svelte';
  import Icon from '../primitives/Icon.svelte';
  import LiveStatusChip from '../primitives/LiveStatusChip.svelte';
  import SearchInput from '../primitives/SearchInput.svelte';
  import FileNode from './FileNode.svelte';
  import FolderNode from './FolderNode.svelte';
  import FilesSearchResults from './FilesSearchResults.svelte';
  import type { LocalSearchResult, LocalTreeAction, LocalTreeNode } from './types';

  interface Props {
    vaultName: string;
    daemonLabel: string;
    colorMode?: 'light' | 'dark';
    searchValue?: string;
    tree: LocalTreeNode[];
    activePath?: string;
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
  }

  let {
    vaultName,
    daemonLabel,
    colorMode = 'light',
    searchValue = '',
    tree,
    activePath = '',
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
  }: Props = $props();

  const searching = $derived(searchValue.trim().length > 0);
</script>

<aside class="files-panel" aria-label="Vault files">
  <header class="panel-header">
    <div class="title-row">
      <div class="vault-title">
        <span>Vault</span>
        <strong>{vaultName}</strong>
      </div>
      <IconButton
        title={colorMode === 'dark' ? 'Use light mode' : 'Use dark mode'}
        size="sm"
        variant="quiet"
        onclick={onToggleColorMode}
      >
        <Icon name={colorMode === 'dark' ? 'sun' : 'moon'} size={14} />
      </IconButton>
    </div>
    <LiveStatusChip label={daemonLabel} />
    <SearchInput
      value={searchValue}
      placeholder="Search files"
      onInput={onSearchInput}
      onClear={onSearchClear}
    />
  </header>

  <div class="panel-body">
    {#if searching}
      {#if searchLoading}
        <p class="loading">Searching…</p>
      {/if}
      <FilesSearchResults
        query={searchValue}
        results={searchResults}
        total={searchTotal}
        truncated={searchTruncated}
        onOpen={onOpenFile}
      />
    {:else if tree.length === 0}
      <p class="loading">No notes yet.</p>
    {:else}
      <nav class="tree" aria-label="Files">
        {#each tree as node (node.path)}
          {#if node.kind === 'folder'}
            <FolderNode
              {node}
              {activePath}
              {expandedPaths}
              onToggle={onToggleFolder}
              onOpen={onOpenFile}
              onAction={onTreeAction}
            />
          {:else}
            <FileNode node={node} {activePath} onOpen={onOpenFile} onAction={onTreeAction} />
          {/if}
        {/each}
      </nav>
    {/if}
  </div>
</aside>

<style>
  .files-panel {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--rd-rule);
    background: var(--rd-panel);
  }

  .panel-header {
    display: grid;
    gap: 10px;
    padding: 14px 12px 12px;
    border-bottom: 1px solid var(--rd-rule);
  }

  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .vault-title {
    display: grid;
    min-width: 0;
    gap: 2px;
    font-family: var(--rd-ui);
  }

  .vault-title span {
    color: var(--rd-ink-4);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .vault-title strong {
    overflow: hidden;
    color: var(--rd-ink-1);
    font-size: 14px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
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
