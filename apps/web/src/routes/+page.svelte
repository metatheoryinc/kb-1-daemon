<script lang="ts">
  import { goto } from '$app/navigation';
  import { createDemoDocumentProvider, encodeVaultPath } from '$lib/yjs/demo-document-provider';
  import type {
    DemoDocumentProvider,
    DemoDocumentProviderStatus,
  } from '$lib/yjs/demo-document-provider';
  import { PlaintextEditor, type LivePath, type OrgPerson } from '@kb-2/editor';
  import {
    DocumentSaveBanner,
    LocalEditorShell,
    type AccentName,
    type LocalSearchResult,
    type LocalTreeAction,
    type LocalTreeNode,
  } from '@kb-2/ui';
  import type { DocumentSessionEvent } from '@kb-2/doc-session/protocol';
  import { onMount } from 'svelte';

  interface ApiFailure {
    ok: false;
    error?: string;
    message?: string;
  }

  interface TreeEntry {
    path: string;
    kind: 'file' | 'folder';
    metadata?: { color?: AccentName; icon?: string | null };
  }

  interface SearchHit {
    path: string;
    line: number;
    lineText: string;
    context?: {
      before?: string[];
      after?: string[];
    };
  }

  let provider = $state<DemoDocumentProvider | null>(null);
  let status = $state<DemoDocumentProviderStatus>('connecting');
  let error = $state<string | null>(null);
  let externalMergeVisible = $state(false);
  let externalChangeVisible = $state(false);
  let persistFailureActive = $state(false);
  let persistRecoveredVisible = $state(false);
  let docDeleted = $state(false);
  let documentPath = $state('hello-world.md');
  let vaultName = $state('Vault');
  let tree = $state<LocalTreeNode[]>([]);
  let expandedPaths = $state(new Set<string>());
  let searchValue = $state('');
  let searchResults = $state<LocalSearchResult[]>([]);
  let searchTotal = $state(0);
  let searchTruncated = $state(false);
  let searchLoading = $state(false);
  let colorMode = $state<'light' | 'dark'>('light');
  let mounted = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let externalMergeTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;

  const livePaths = $derived<LivePath[]>([
    { path: documentPath, noteId: documentPath },
  ]);

  const orgPeople: OrgPerson[] = [];

  const daemonLabel = $derived(
    status === 'open'
      ? 'Daemon · live'
      : status === 'connecting'
        ? 'Daemon · connecting'
        : status === 'error'
          ? 'Daemon · error'
          : 'Daemon · closed',
  );

  function handleSessionEvent(event: DocumentSessionEvent): void {
    if (event.kind === 'doc-moved') {
      const nextPath = event.toPath ?? event.path;
      documentPath = nextPath;
      docDeleted = false;
      void goto(`/${encodeVaultPath(nextPath)}`, { replaceState: true, noScroll: true, keepFocus: true });
      void refreshTree();
      return;
    }

    if (event.kind === 'doc-deleted') {
      docDeleted = true;
      persistFailureActive = false;
      externalChangeVisible = false;
      externalMergeVisible = false;
      void refreshTree();
      return;
    }

    if (event.kind === 'external-merge') {
      externalMergeVisible = true;
      if (externalMergeTimer) {
        clearTimeout(externalMergeTimer);
      }
      externalMergeTimer = setTimeout(() => {
        externalMergeVisible = false;
        externalMergeTimer = undefined;
      }, 4000);
      return;
    }

    if (event.kind === 'external-change') {
      externalChangeVisible = true;
      externalMergeVisible = false;
      if (externalMergeTimer) {
        clearTimeout(externalMergeTimer);
        externalMergeTimer = undefined;
      }
      return;
    }

    if (event.kind === 'persist-failure') {
      persistFailureActive = true;
      persistRecoveredVisible = false;
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = undefined;
      }
      return;
    }

    persistFailureActive = false;
    persistRecoveredVisible = true;
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
    }
    recoveryTimer = setTimeout(() => {
      persistRecoveredVisible = false;
      recoveryTimer = undefined;
    }, 3500);
  }

  function openProvider(path: string): void {
    provider?.destroy();
    status = 'connecting';
    error = null;
    docDeleted = false;
    const nextProvider = createDemoDocumentProvider({
      path,
      onStatus: (nextStatus) => {
        status = nextStatus;
      },
      onError: (caught) => {
        error = caught instanceof Error ? caught.message : String(caught);
      },
      onSessionEvent: handleSessionEvent,
    });
    provider = nextProvider;
  }

  async function openDocument(path: string): Promise<void> {
    if (path === documentPath) return;
    documentPath = path;
    openProvider(path);
    searchValue = '';
    searchResults = [];
    searchTotal = 0;
    searchTruncated = false;
    await goto(`/${encodeVaultPath(path)}`, { noScroll: true, keepFocus: true });
  }

  function toggleFolder(path: string): void {
    const next = new Set(expandedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    expandedPaths = next;
  }

  function toggleColorMode(): void {
    colorMode = colorMode === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', colorMode === 'dark');
  }

  function updateSearch(value: string): void {
    searchValue = value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      void runSearch(value);
    }, 250);
  }

  function clearSearch(): void {
    searchValue = '';
    searchResults = [];
    searchTotal = 0;
    searchTruncated = false;
  }

  async function runSearch(value: string): Promise<void> {
    const query = value.trim();
    if (!query) {
      clearSearch();
      return;
    }
    searchLoading = true;
    try {
      const response = await fetchJson<{ ok: true; results: SearchHit[]; total: number; truncated: boolean }>(
        `/api/search?q=${encodeURIComponent(query)}&limit=50`,
      );
      if (query !== searchValue.trim()) return;
      searchResults = response.results.map((hit) => ({
        path: hit.path,
        line: hit.line,
        lineText: hit.lineText,
        before: hit.context?.before ?? [],
        after: hit.context?.after ?? [],
      }));
      searchTotal = response.total;
      searchTruncated = response.truncated || response.total > response.results.length;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      searchLoading = false;
    }
  }

  async function refreshVaultInfo(): Promise<void> {
    try {
      const info = await fetchJson<{ ok: true; rootName: string }>('/api/vault');
      vaultName = info.rootName;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  async function refreshTree(): Promise<void> {
    try {
      const result = await fetchJson<{ ok: true; entries: TreeEntry[] }>('/api/tree');
      tree = buildTree(result.entries);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  async function handleTreeAction(action: LocalTreeAction): Promise<void> {
    try {
      if (action.kind === 'file') {
        await handleFileAction(action);
      } else {
        await handleFolderAction(action);
      }
      await refreshTree();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  async function handleFileAction(action: Extract<LocalTreeAction, { kind: 'file' }>): Promise<void> {
    if (action.action === 'delete') {
      if (!window.confirm(`Delete ${action.path}?`)) return;
      await fetchJson(`/api/files/${encodeVaultPath(action.path)}`, { method: 'DELETE' });
      return;
    }

    const nextPath = window.prompt(`${titleCase(action.action)} file`, action.path);
    if (!nextPath || nextPath === action.path) return;
    await fetchJson(`/api/files/${encodeVaultPath(action.path)}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: nextPath }),
    });
  }

  async function handleFolderAction(action: Extract<LocalTreeAction, { kind: 'folder' }>): Promise<void> {
    if (action.action === 'color') {
      await fetchJson(`/api/folders/${encodeVaultPath(action.path)}/metadata`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ color: action.color ?? null }),
      });
      return;
    }

    if (action.action === 'delete') {
      if (!window.confirm(`Delete ${action.path} and its contents?`)) return;
      await fetchJson(`/api/folders/${encodeVaultPath(action.path)}?recursive=true`, { method: 'DELETE' });
      return;
    }

    if (action.action === 'new-note') {
      const nextPath = window.prompt('New note path', `${action.path}/untitled.md`);
      if (!nextPath) return;
      await fetchJson(`/api/files/${encodeVaultPath(nextPath)}`, {
        method: 'PUT',
        headers: { 'content-type': 'text/markdown' },
        body: '',
      });
      await openDocument(nextPath);
      return;
    }

    if (action.action === 'new-folder') {
      const nextPath = window.prompt('New folder path', `${action.path}/untitled`);
      if (!nextPath) return;
      await fetchJson('/api/folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: nextPath }),
      });
      expandedPaths = new Set([...expandedPaths, action.path, nextPath]);
      return;
    }

    const nextPath = window.prompt(`${titleCase(action.action)} folder`, action.path);
    if (!nextPath || nextPath === action.path) return;
    await fetchJson(`/api/folders/${encodeVaultPath(action.path)}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: nextPath }),
    });
  }

  async function fetchJson<T extends { ok: true } = { ok: true }>(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<T> {
    const response = await fetch(input, init);
    const body = await response.json().catch(() => null) as (T | ApiFailure | null);
    if (!response.ok || !body || body.ok === false) {
      const failure = body && body.ok === false ? body : null;
      throw new Error(failure?.message ?? failure?.error ?? `Request failed (${response.status})`);
    }
    return body as T;
  }

  function buildTree(entries: TreeEntry[]): LocalTreeNode[] {
    const byPath = new Map<string, LocalTreeNode>();
    const roots: LocalTreeNode[] = [];

    for (const entry of [...entries].sort(compareEntries)) {
      const node: LocalTreeNode = entry.kind === 'folder'
        ? {
            kind: 'folder',
            path: entry.path,
            name: nameFromPath(entry.path),
            metadata: entry.metadata,
            children: [],
          }
        : {
            kind: 'file',
            path: entry.path,
            name: nameFromPath(entry.path),
          };
      byPath.set(entry.path, node);
    }

    for (const node of byPath.values()) {
      const parentPath = parentOf(node.path);
      const parent = parentPath ? byPath.get(parentPath) : undefined;
      if (parent?.kind === 'folder') {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return sortNodes(roots);
  }

  function compareEntries(left: TreeEntry, right: TreeEntry): number {
    return left.path.localeCompare(right.path);
  }

  function sortNodes(nodes: LocalTreeNode[]): LocalTreeNode[] {
    return nodes.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      return left.name.localeCompare(right.name);
    }).map((node) => {
      if (node.kind === 'folder') {
        node.children = sortNodes(node.children);
      }
      return node;
    });
  }

  function parentOf(path: string): string {
    const index = path.lastIndexOf('/');
    return index === -1 ? '' : path.slice(0, index);
  }

  function nameFromPath(path: string): string {
    return path.split('/').filter(Boolean).at(-1) ?? path;
  }

  function titleCase(value: string): string {
    return value.slice(0, 1).toUpperCase() + value.slice(1);
  }

  onMount(() => {
    mounted = true;
    const pathname = window.location.pathname;
    if (pathname === '/') {
      documentPath = 'hello-world.md';
      void goto('/hello-world.md', { replaceState: true, noScroll: true, keepFocus: true });
    } else {
      documentPath = decodeURIComponent(pathname.replace(/^\/+/, ''));
    }

    colorMode = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    openProvider(documentPath);
    void refreshVaultInfo();
    void refreshTree();

    return () => {
      mounted = false;
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = undefined;
      }
      if (externalMergeTimer) {
        clearTimeout(externalMergeTimer);
        externalMergeTimer = undefined;
      }
      if (recoveryTimer) {
        clearTimeout(recoveryTimer);
        recoveryTimer = undefined;
      }
      provider?.destroy();
      provider = null;
    };
  });
</script>

<svelte:head>
  <title>KB-2 Editor</title>
</svelte:head>

<LocalEditorShell
  {vaultName}
  {daemonLabel}
  {documentPath}
  {colorMode}
  {tree}
  {expandedPaths}
  {searchValue}
  {searchResults}
  {searchTotal}
  {searchTruncated}
  {searchLoading}
  onSearchInput={updateSearch}
  onSearchClear={clearSearch}
  onToggleColorMode={toggleColorMode}
  onToggleFolder={toggleFolder}
  onOpenFile={(path) => {
    void openDocument(path);
  }}
  onTreeAction={(action) => {
    void handleTreeAction(action);
  }}
>
  {#if externalMergeVisible || externalChangeVisible || persistFailureActive || persistRecoveredVisible || docDeleted}
    <section class="banner-strip" aria-label="Document save notifications">
      {#if externalMergeVisible}
        <DocumentSaveBanner
          variant="external-merge"
          title="External edit merged"
          message="Merged an edit made outside KB-2."
          ondismiss={() => {
            externalMergeVisible = false;
            if (externalMergeTimer) {
              clearTimeout(externalMergeTimer);
              externalMergeTimer = undefined;
            }
          }}
        />
      {/if}

      {#if externalChangeVisible}
        <DocumentSaveBanner
          variant="external-change"
          title="File changed outside KB-2"
          message="This file changed outside KB-2 and was reloaded from disk."
          ondismiss={() => {
            externalChangeVisible = false;
          }}
        />
      {/if}

      {#if persistFailureActive}
        <DocumentSaveBanner
          variant="persist-failure"
          title="Changes are NOT saving to disk."
          message="Keep this tab open. KB-2 will keep retrying until saving recovers."
        />
      {:else if persistRecoveredVisible}
        <DocumentSaveBanner
          variant="persist-recovered"
          title="Saving restored"
          message="KB-2 is saving changes to disk again."
        />
      {/if}

      {#if docDeleted}
        <DocumentSaveBanner
          variant="doc-deleted"
          title="Document deleted"
          message="This file was deleted or moved to trash. The editor is read-only."
        />
      {/if}
    </section>
  {/if}

  <section class="document-shell" aria-label="Markdown document">
    {#if provider}
      <PlaintextEditor
        ydoc={provider.doc}
        ytext={provider.text}
        livePaths={livePaths}
        orgPeople={orgPeople}
        readOnly={docDeleted}
        scroll="self"
      />
    {:else if mounted}
      <div class="loading">Opening document…</div>
    {/if}
  </section>

  {#if error}
    <p class="error">{error}</p>
  {/if}
</LocalEditorShell>

<style>
  .banner-strip {
    display: grid;
    gap: 8px;
    padding: 12px 22px 0;
    background: var(--rd-bg);
  }

  .banner-strip :global(.document-save-banner) {
    width: min(100%, 760px);
    justify-self: center;
  }

  .document-shell {
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-columns: minmax(24px, 1fr) minmax(0, 760px) minmax(24px, 1fr);
    overflow: hidden;
  }

  .document-shell :global(.kb2-editor-shell),
  .loading {
    grid-column: 2;
    min-width: 0;
    border-left: 1px solid var(--rd-rule);
    border-right: 1px solid var(--rd-rule);
    background: var(--rd-panel);
  }

  .document-shell :global(.plaintext-editor .cm-content) {
    padding-top: 28px;
    padding-left: 56px;
    padding-right: 32px;
    padding-bottom: 64px;
  }

  .loading {
    padding: 24px;
    color: var(--rd-ink-4);
    font-size: 13px;
  }

  .error {
    position: fixed;
    left: 296px;
    bottom: 16px;
    z-index: 30;
    margin: 0;
    max-width: min(520px, calc(100vw - 328px));
    border: 1px solid color-mix(in srgb, var(--destructive) 40%, transparent);
    border-radius: 6px;
    background: var(--rd-panel);
    color: var(--destructive);
    padding: 8px 10px;
    font-family: var(--rd-ui);
    font-size: 12px;
  }

  @media (max-width: 720px) {
    .document-shell {
      grid-template-columns: 12px minmax(0, 1fr) 12px;
    }

    .banner-strip {
      padding: 10px 12px 0;
    }

    .error {
      left: 16px;
      max-width: calc(100vw - 32px);
    }
  }
</style>
