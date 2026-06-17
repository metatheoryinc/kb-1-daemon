<script lang="ts">
  import LiveDot from '../primitives/LiveDot.svelte';
  import SearchInput from '../primitives/SearchInput.svelte';
  import VaultGroup from './VaultGroup.svelte';
  import FilesSearchResults from './FilesSearchResults.svelte';
  import type { AccentName } from '../primitives/accent';
  import type { LocalSearchResult, LocalTreeAction, LocalTreeNode } from './types';

  interface Props {
    vaultName: string;
    /** Stable vault id — seeds the tree's expansion keys. Defaults to
        the display name when the shell has nothing more durable. */
    vaultId?: string;
    /** Accent for the vault group's folder token. */
    vaultAccent?: AccentName;
    daemonLabel: string;
    daemonStatus?: 'open' | 'connecting' | 'closed' | 'error';
    searchValue?: string;
    tree: LocalTreeNode[];
    activePath?: string;
    /** Allow-list of expanded folder keys (`folder:<vaultId>:<path>`). */
    expandedFolderIds?: Set<string>;
    /** Set of expanded vault keys (`vault:<id>`). Omit to render open. */
    expandedVaultIds?: Set<string>;
    searchResults?: LocalSearchResult[];
    searchTotal?: number;
    searchTruncated?: boolean;
    searchLoading?: boolean;
    onSearchInput?: (value: string) => void;
    onSearchClear?: () => void;
    onToggleFolder?: (key: string) => void;
    onToggleVault?: (key: string) => void;
    onOpenFile?: (path: string) => void;
    onTreeAction?: (action: LocalTreeAction) => void;
  }

  let {
    vaultName,
    vaultId = vaultName,
    vaultAccent = 'slate',
    daemonLabel,
    daemonStatus = 'open',
    searchValue = '',
    tree,
    activePath = '',
    expandedFolderIds = new Set<string>(),
    expandedVaultIds,
    searchResults = [],
    searchTotal = searchResults.length,
    searchTruncated = false,
    searchLoading = false,
    onSearchInput,
    onSearchClear,
    onToggleFolder,
    onToggleVault,
    onOpenFile,
    onTreeAction,
  }: Props = $props();

  const searching = $derived(searchValue.trim().length > 0);
  const dotColor = $derived(
    daemonStatus === 'open'
      ? '#1f8a4d'
      : daemonStatus === 'connecting'
        ? '#c27a14'
        : '#c74436',
  );
  const dotPulse = $derived(daemonStatus === 'connecting');
</script>

<aside class="files-panel" aria-label="Vault files">
  <header class="panel-header">
    <div class="title-row">
      <div class="vault-title">
        <span>Vault</span>
        <div class="vault-name">
          <strong>{vaultName}</strong>
          <LiveDot size={8} color={dotColor} pulse={dotPulse} title={daemonLabel} />
        </div>
      </div>
    </div>
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
        <VaultGroup
          {vaultId}
          {vaultName}
          accent={vaultAccent}
          {tree}
          {activePath}
          {expandedFolderIds}
          {expandedVaultIds}
          {onToggleFolder}
          {onToggleVault}
          {onOpenFile}
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

  .vault-name {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 7px;
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
