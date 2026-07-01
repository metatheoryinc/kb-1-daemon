<script lang="ts">
  import Icon from "../primitives/Icon.svelte";

  // Borrowed from KB-1's components/history/HistoryList.svelte and
  // components/history/HistoryRow.svelte. This port renders content-version
  // snapshots instead of KB-1's change-feed because FC-7496 Part 1 stores a
  // daemon-owned per-file content-version log.
  export type DocumentHistoryOperation = "create" | "update" | "move" | "rename";

  export type DocumentHistoryActor = {
    kind: string;
    id?: string;
    name?: string;
    client?: string;
    avatarUrl?: string | null;
  };

  export interface DocumentHistoryEntry {
    id: string;
    path: string;
    operation: DocumentHistoryOperation;
    actor: DocumentHistoryActor;
    integrationId?: string;
    createdAt: string;
    updatedAt: string;
    content?: string;
    size: number;
    contentHash: string;
  }

  interface Props {
    path: string;
    entries: readonly DocumentHistoryEntry[];
    loading?: boolean;
    loadingMore?: boolean;
    error?: string | null;
    hasMore?: boolean;
    onClose?: () => void;
    onLoadMore?: () => void;
    now?: number;
    class?: string;
  }

  let {
    path,
    entries,
    loading = false,
    loadingMore = false,
    error = null,
    hasMore = false,
    onClose,
    onLoadMore,
    now = Date.now(),
    class: className,
  }: Props = $props();

  const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  function fileLabel(filePath: string): string {
    const leaf = filePath.split("/").filter(Boolean).at(-1);
    return leaf && leaf.length > 0 ? leaf : "Untitled";
  }

  function operationLabel(operation: DocumentHistoryOperation): string {
    switch (operation) {
      case "create":
        return "Created";
      case "move":
        return "Moved";
      case "rename":
        return "Renamed";
      default:
        return "Updated";
    }
  }

  function operationClass(operation: DocumentHistoryOperation): string {
    switch (operation) {
      case "create":
        return "is-create";
      case "move":
      case "rename":
        return "is-move";
      default:
        return "is-update";
    }
  }

  function actorName(actor: DocumentHistoryActor): string {
    if (actor.name && actor.name.length > 0) return actor.name;
    if (actor.id && actor.id.length > 0) return actor.id;
    if (actor.kind === "agent" || actor.client) return "local agent";
    return "local user";
  }

  function actorDetail(entry: DocumentHistoryEntry): string | null {
    if (entry.actor.client && entry.actor.client.length > 0) {
      return entry.actor.client;
    }
    if (entry.integrationId && entry.integrationId.length > 0) {
      return entry.integrationId;
    }
    return null;
  }

  function formatWhen(value: string): string {
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return "Unknown time";
    const diff = Math.max(0, now - time);
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 5) return "<5m";
    if (minutes < 60) return "<1h";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    return absoluteFormatter.format(new Date(time));
  }
</script>

<aside
  class={["history-panel", className].filter(Boolean).join(" ")}
  aria-label="Note history"
  data-testid="document-history-panel"
>
  <header class="panel-head">
    <div class="heading">
      <div class="eyebrow">History</div>
      <h2>{fileLabel(path)}</h2>
      <div class="path" title={path}>{path}</div>
    </div>
    {#if onClose}
      <button
        type="button"
        class="close"
        aria-label="Close history"
        onclick={onClose}
      >
        <Icon name="x" size={15} weight="regular" />
      </button>
    {/if}
  </header>

  <div class="panel-body">
    {#if error !== null && entries.length === 0}
      <div class="state error">{error}</div>
    {:else if loading && entries.length === 0}
      <div class="state">Loading history...</div>
    {:else if entries.length === 0}
      <div class="state">No history yet.</div>
    {:else}
      <ol class="entries">
        {#each entries as entry (entry.id)}
          <li class="entry" data-testid="document-history-entry">
            <div class="marker" aria-hidden="true">
              <Icon name="history" size={14} weight="regular" />
            </div>
            <div class="entry-main">
              <div class="entry-meta">
                <span class="actor">{actorName(entry.actor)}</span>
                {#if actorDetail(entry)}
                  <span class="detail">· {actorDetail(entry)}</span>
                {/if}
                <span class={`operation ${operationClass(entry.operation)}`}>
                  {operationLabel(entry.operation).toLowerCase()}
                </span>
                <time datetime={entry.updatedAt}>
                  {formatWhen(entry.updatedAt)}
                </time>
              </div>
            </div>
          </li>
        {/each}
      </ol>

      {#if hasMore}
        <button
          type="button"
          class="load-more"
          disabled={loadingMore}
          onclick={() => onLoadMore?.()}
        >
          {loadingMore ? "Loading..." : "Load older"}
        </button>
      {/if}

      {#if error !== null}
        <div class="state error inline">{error}</div>
      {/if}
    {/if}
  </div>
</aside>

<style>
  .history-panel {
    width: min(340px, 100%);
    max-height: calc(100vh - 148px);
    display: flex;
    flex-direction: column;
    border-left: 1px solid color-mix(in srgb, var(--rd-ink-5) 36%, transparent);
    padding: 30px 0 0 24px;
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
  }

  .panel-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding-bottom: 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--rd-ink-5) 28%, transparent);
  }

  .heading {
    min-width: 0;
    flex: 1;
  }

  .eyebrow {
    color: var(--rd-ink-4);
    font-family: var(--rd-mono);
    font-size: 10px;
    text-transform: uppercase;
  }

  h2 {
    margin: 4px 0 2px;
    color: var(--rd-ink-1);
    font-size: 15px;
    line-height: 1.25;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--rd-ink-4);
    font-family: var(--rd-mono);
    font-size: 11px;
  }

  .close {
    width: 26px;
    height: 26px;
    display: inline-grid;
    place-items: center;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--rd-ink-3);
    cursor: pointer;
  }

  .close:hover {
    border-color: color-mix(in srgb, var(--rd-ink-5) 42%, transparent);
    background: color-mix(in srgb, var(--rd-ink-5) 10%, transparent);
    color: var(--rd-ink-1);
  }

  .panel-body {
    min-height: 0;
    overflow: auto;
    padding: 14px 2px 32px 0;
  }

  .state {
    padding: 12px 0;
    color: var(--rd-ink-4);
    font-size: 12px;
    line-height: 1.45;
  }

  .state.error {
    color: rgb(185 28 28);
  }

  .state.inline {
    padding-top: 8px;
  }

  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .entry {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 10px;
    padding: 0 0 18px;
  }

  .marker {
    margin-top: 2px;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--rd-ink-4);
    background: color-mix(in srgb, var(--rd-panel) 90%, var(--rd-ink-5));
  }

  .entry-main {
    min-width: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--rd-ink-5) 22%, transparent);
    padding-bottom: 16px;
  }

  .entry-meta {
    display: flex;
    align-items: baseline;
    gap: 5px;
    min-width: 0;
    color: var(--rd-ink-3);
    font-size: 12px;
    line-height: 1.35;
  }

  .actor {
    min-width: 0;
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--rd-ink-1);
    font-weight: 600;
  }

  .detail {
    min-width: 0;
    max-width: 96px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--rd-ink-4);
  }

  .operation {
    margin-left: 2px;
    font-weight: 600;
  }

  .operation.is-create {
    color: rgb(4 120 87);
  }

  .operation.is-update {
    color: rgb(3 105 161);
  }

  .operation.is-move {
    color: rgb(180 83 9);
  }

  time {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--rd-ink-4);
    font-family: var(--rd-mono);
    font-size: 11px;
  }

  .load-more {
    width: 100%;
    height: 30px;
    border: 1px solid color-mix(in srgb, var(--rd-ink-5) 42%, transparent);
    border-radius: 5px;
    background: transparent;
    color: var(--rd-ink-3);
    font: 12px var(--rd-ui);
    cursor: pointer;
  }

  .load-more:hover:not(:disabled) {
    background: color-mix(in srgb, var(--rd-ink-5) 10%, transparent);
    color: var(--rd-ink-1);
  }

  .load-more:disabled {
    cursor: default;
    opacity: 0.6;
  }

  @media (max-width: 1180px) {
    .history-panel {
      width: 100%;
      max-height: none;
      border-left: 0;
      border-top: 1px solid color-mix(in srgb, var(--rd-ink-5) 36%, transparent);
      margin-top: 28px;
      padding: 22px 0 0;
    }
  }
</style>
