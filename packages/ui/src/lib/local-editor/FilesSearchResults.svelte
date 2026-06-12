<script lang="ts">
  import type { LocalSearchResult } from './types';

  interface Props {
    query: string;
    results: LocalSearchResult[];
    total?: number;
    truncated?: boolean;
    onOpen?: (path: string) => void;
  }

  let { query, results, total = results.length, truncated = false, onOpen }: Props = $props();
  const moreCount = $derived(Math.max(0, total - results.length));
</script>

<section class="search-results" aria-label="Search results">
  {#if query.trim().length === 0}
    <p class="empty">Type to search this vault.</p>
  {:else if results.length === 0}
    <p class="empty">No matches for "{query}".</p>
  {:else}
    <div class="summary">{total} {total === 1 ? 'result' : 'results'}</div>
    <div class="rows">
      {#each results as result (`${result.path}:${result.line}`)}
        <button type="button" class="result" onclick={() => onOpen?.(result.path)}>
          <span class="path">{result.path}</span>
          <span class="line">Line {result.line}</span>
          <span class="snippet">{result.lineText}</span>
        </button>
      {/each}
    </div>
    {#if truncated || moreCount > 0}
      <p class="more">More results available. Narrow the search to refine.</p>
    {/if}
  {/if}
</section>

<style>
  .search-results {
    min-height: 0;
    overflow: auto;
    padding: 6px;
  }

  .summary,
  .empty,
  .more {
    margin: 8px 6px;
    color: var(--rd-ink-4);
    font-family: var(--rd-ui);
    font-size: 12px;
  }

  .rows {
    display: grid;
    gap: 4px;
  }

  .result {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 3px 8px;
    width: 100%;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--rd-ink-2);
    padding: 8px;
    font-family: var(--rd-ui);
    text-align: left;
    cursor: pointer;
  }

  .result:hover {
    background: var(--rd-hover);
    color: var(--rd-ink-1);
  }

  .path {
    min-width: 0;
    overflow: hidden;
    color: var(--rd-ink-1);
    font-size: 12px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .line {
    color: var(--rd-ink-4);
    font-size: 11px;
  }

  .snippet {
    grid-column: 1 / -1;
    display: -webkit-box;
    overflow: hidden;
    color: var(--rd-ink-3);
    font-size: 12px;
    line-height: 1.35;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
</style>
