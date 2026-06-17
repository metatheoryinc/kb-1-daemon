<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import {
    createDemoDocumentProvider,
    encodeVaultPath,
    isDemoDocumentProviderOpenError,
  } from '$lib/yjs/demo-document-provider';
  import type {
    DemoDocumentProvider,
    DemoDocumentProviderStatus,
  } from '$lib/yjs/demo-document-provider';
  import {
    PlaintextEditor,
    parseWikilinkInner,
    resolveLinkTarget,
    type LivePath,
    type OrgPerson,
  } from '@kb-2/editor';
  import {
    DocumentNotFoundState,
    EditorSaveNotifications,
    LocalEditorShell,
    type AccentName,
    type LocalSearchResult,
    type LocalTreeAction,
    type LocalTreeNode,
    type RailNavId,
  } from '@kb-2/ui';
  import type { DocumentSessionEvent } from '@kb-2/doc-session/protocol';
  import {
    useAppState,
    ancestorKeysForPath,
    expansionKey,
    type ColorMode,
  } from '$lib/app-state';
  import { onMount, untrack } from 'svelte';

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
  let providerGeneration = 0;
  let providerSynced = $state(false);
  let status = $state<DemoDocumentProviderStatus>('connecting');
  let error = $state<string | null>(null);
  let externalMergeVisible = $state(false);
  let externalChangeVisible = $state(false);
  let persistFailureActive = $state(false);
  let persistRecoveredVisible = $state(false);
  let docDeleted = $state(false);
  let notFoundPath = $state<string | null>(null);
  let documentPath = $state('hello-world.md');
  let vaultName = $state('Vault');
  let tree = $state<LocalTreeNode[]>([]);
  // Stable id seeding the tree's expansion keys. The single local vault
  // has no durable id of its own, so the vault name stands in.
  const vaultId = $derived(vaultName);
  let searchValue = $state('');
  let searchResults = $state<LocalSearchResult[]>([]);
  let searchTotal = $state(0);
  let searchTruncated = $state(false);
  let searchLoading = $state(false);
  let mounted = $state(false);
  // Which secondary panel the rail has selected. 'files' shows the tree;
  // 'starred' shows the (currently empty) starred view.
  let activeNav = $state<RailNavId>('files');

  // The app-state store owns the persisted light / dark / system choice
  // and the root layout applies it to the DOM. The FilesPanel toggle is
  // prop-driven on a *resolved* mode, so mirror the store's choice and
  // resolve `'system'` against `prefers-color-scheme` here for the icon.
  const appState = useAppState();
  let colorModePref = $state<ColorMode>(appState.getState().colorMode);
  // Tree expansion lives in the persisted app-state store. Mirror the
  // two sets into local `$state` so the template tracks them; the store
  // owns mutation and localStorage persistence.
  let expandedFolderIds = $state<Set<string>>(appState.getState().expandedFolderIds);
  let collapsedVaultIds = $state<Set<string>>(appState.getState().collapsedVaultIds);
  // Vaults default open: the persisted shape is a collapse deny-list, so
  // the expanded set is its complement over the one local vault.
  const expandedVaultIds = $derived.by<Set<string>>(() => {
    const out = new Set<string>();
    if (!collapsedVaultIds.has(vaultId)) out.add(expansionKey('vault', vaultId));
    return out;
  });
  let systemPrefersDark = $state(false);
  const colorMode = $derived<'light' | 'dark'>(
    colorModePref === 'system'
      ? systemPrefersDark
        ? 'dark'
        : 'light'
      : colorModePref,
  );
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let externalMergeTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;

  // Flatten the vault tree's file nodes into the editor's wikilink
  // resolution snapshot. Every file path is a candidate target so
  // `[[note]]` links resolve across the whole vault (not just the open
  // doc). The single local vault has no durable note id, so the path
  // stands in as the id. Falls back to the open document while the tree
  // is still loading.
  const livePaths = $derived<LivePath[]>(
    tree.length > 0
      ? collectFilePaths(tree)
      : [{ path: documentPath, noteId: documentPath }],
  );

  function collectFilePaths(nodes: LocalTreeNode[]): LivePath[] {
    const out: LivePath[] = [];
    const walk = (list: LocalTreeNode[]): void => {
      for (const node of list) {
        if (node.kind === 'folder') {
          walk(node.children);
        } else {
          out.push({ path: node.path, noteId: node.path });
        }
      }
    };
    walk(nodes);
    return out;
  }

  const orgPeople: OrgPerson[] = [];

  const editorSaveNotificationCopy = {
    externalMerge: {
      title: 'External edit merged',
      message: 'Merged an edit made outside KB-2.',
    },
    externalChange: {
      title: 'File changed outside KB-2',
      message: 'This file changed outside KB-2 and was reloaded from disk.',
    },
    persistFailure: {
      title: 'Changes are NOT saving to disk.',
      message: 'Keep this tab open. KB-2 will keep retrying until saving recovers.',
    },
    docDeleted: {
      title: 'Document deleted',
      message: 'This file was deleted or moved to trash. The editor is read-only.',
    },
  };

  const daemonLabel = $derived(
    status === 'open'
      ? 'Daemon · live'
      : status === 'syncing'
        ? 'Daemon · syncing'
      : status === 'connecting'
        ? 'Daemon · connecting'
        : status === 'error'
          ? 'Daemon · error'
          : 'Daemon · closed',
  );
  const daemonStatus = $derived<'open' | 'connecting' | 'closed' | 'error'>(
    persistFailureActive || status === 'error'
      ? 'error'
      : status === 'open'
        ? 'open'
        : status === 'connecting' || status === 'syncing'
          ? 'connecting'
          : 'closed',
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
    const generation = providerGeneration + 1;
    providerGeneration = generation;
    providerSynced = false;
    status = 'connecting';
    error = null;
    notFoundPath = null;
    docDeleted = false;
    const nextProvider = createDemoDocumentProvider({
      path,
      onStatus: (nextStatus) => {
        if (generation !== providerGeneration) return;
        status = nextStatus;
      },
      onError: (caught) => {
        if (generation !== providerGeneration) return;
        if (isDemoDocumentProviderOpenError(caught)) {
          notFoundPath = path;
          providerSynced = false;
          error = null;
          return;
        }
        error = caught instanceof Error ? caught.message : String(caught);
      },
      onSessionEvent: (event) => {
        if (generation !== providerGeneration) return;
        handleSessionEvent(event);
      },
      onSynced: () => {
        if (generation !== providerGeneration) return;
        providerSynced = true;
      },
    });
    provider = nextProvider;
  }

  async function openDocument(path: string): Promise<void> {
    if (path === documentPath && notFoundPath !== path) return;
    rebindDocument(path, { resetSearch: true });
    await goto(`/${encodeVaultPath(path)}`, { noScroll: true, keepFocus: true });
  }

  // Wikilink navigation. The editor fires with the URL-encoded target;
  // decode, parse the `[[target#heading|alias]]` inner, resolve against
  // the live tree, and open the note. Unresolved targets fall back to
  // the raw target (adding `.md` when it has no extension) so a click
  // can still create-then-open a not-yet-existing note.
  function handleWikilinkClick(encodedTarget: string): void {
    let decoded: string;
    try {
      decoded = decodeURIComponent(encodedTarget);
    } catch {
      return;
    }
    const parts = parseWikilinkInner(decoded);
    if (parts === null) return;
    const rawTarget = parts.target;
    const resolved = resolveLinkTarget({ raw: rawTarget, livePaths });
    const targetPath = resolved
      ? resolved.path
      : /\.[^/]+$/.test(rawTarget)
        ? rawTarget
        : `${rawTarget}.md`;
    void openDocument(targetPath);
  }

  function rebindDocument(path: string, options: { resetSearch?: boolean } = {}): void {
    documentPath = path;
    openProvider(path);
    if (options.resetSearch === true) {
      searchValue = '';
      searchResults = [];
      searchTotal = 0;
      searchTruncated = false;
    }
  }

  function toggleFolder(key: string): void {
    appState.toggleFolderExpanded(key);
  }

  function toggleVault(key: string): void {
    // The vault key encodes the id (`vault:<id>`); the deny-list is
    // keyed by raw id, so collapse iff the vault is currently expanded.
    appState.setVaultCollapsed(vaultId, expandedVaultIds.has(key));
  }

  function toggleColorMode(): void {
    appState.cycleColorMode();
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
      // Unfurl the parent and the new folder so the addition is visible.
      appState.expandFolders([
        expansionKey('folder', vaultId, action.path),
        expansionKey('folder', vaultId, nextPath),
      ]);
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

  function documentPathFromUrl(url: URL): string {
    if (url.pathname === '/') {
      return 'hello-world.md';
    }
    return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  }

  // Mirror the store's persisted choice so the toggle icon reflects the
  // live preference. The root layout owns applying the mode to the DOM.
  $effect(() => {
    colorModePref = appState.getState().colorMode;
    return appState.subscribe((s) => {
      colorModePref = s.colorMode;
    });
  });

  // Mirror the store's expansion sets so the template re-renders when a
  // toggle (or the ancestor auto-expand) mutates them.
  $effect(() => {
    const snapshot = appState.getState();
    expandedFolderIds = snapshot.expandedFolderIds;
    collapsedVaultIds = snapshot.collapsedVaultIds;
    return appState.subscribe((s) => {
      expandedFolderIds = s.expandedFolderIds;
      collapsedVaultIds = s.collapsedVaultIds;
    });
  });

  // On load and on navigation, walk the active file's ancestor chain
  // into the expanded set so a deep-linked note's row is visible. The
  // vault un-collapse keeps a refresh-into-a-collapsed-vault honest.
  // `untrack` keeps the store writes from re-triggering this effect.
  $effect(() => {
    const path = documentPath;
    const id = vaultId;
    untrack(() => {
      appState.setVaultCollapsed(id, false);
      const keys = ancestorKeysForPath(path, id);
      if (keys.length > 0) appState.expandFolders(keys);
    });
  });

  // Track the OS preference so the toggle icon resolves `'system'`
  // correctly. Only meaningful while the preference is `'system'`, but
  // kept current unconditionally so the derived mode is always right.
  $effect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    systemPrefersDark = mql.matches;
    const listener = () => {
      systemPrefersDark = mql.matches;
    };
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  });

  afterNavigate((navigation) => {
    if (!mounted || !navigation.to?.url) return;
    const nextPath = documentPathFromUrl(navigation.to.url);
    if (nextPath === documentPath) return;
    rebindDocument(nextPath, { resetSearch: true });
  });

  onMount(() => {
    mounted = true;
    const initialPath = documentPathFromUrl(new URL(window.location.href));
    if (window.location.pathname === '/') {
      documentPath = 'hello-world.md';
      void goto('/hello-world.md', { replaceState: true, noScroll: true, keepFocus: true });
    } else {
      documentPath = initialPath;
    }

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
      providerSynced = false;
    };
  });
</script>

<svelte:head>
  <title>KB-2 Editor</title>
</svelte:head>

<LocalEditorShell
  {vaultName}
  {vaultId}
  {daemonLabel}
  {daemonStatus}
  {documentPath}
  {colorMode}
  colorModeChoice={colorModePref}
  {activeNav}
  {tree}
  {expandedFolderIds}
  {expandedVaultIds}
  {searchValue}
  {searchResults}
  {searchTotal}
  {searchTruncated}
  {searchLoading}
  onSelectNav={(id) => {
    activeNav = id;
  }}
  onSearchInput={updateSearch}
  onSearchClear={clearSearch}
  onToggleColorMode={toggleColorMode}
  onToggleFolder={toggleFolder}
  onToggleVault={toggleVault}
  onOpenFile={(path) => {
    void openDocument(path);
  }}
  onTreeAction={(action) => {
    void handleTreeAction(action);
  }}
>
  <EditorSaveNotifications
    externalMergeVisible={externalMergeVisible}
    externalChangeVisible={externalChangeVisible}
    persistFailureActive={persistFailureActive}
    persistRecoveredVisible={persistRecoveredVisible}
    docDeleted={docDeleted}
    copy={editorSaveNotificationCopy}
    onDismissExternalMerge={() => {
      externalMergeVisible = false;
      if (externalMergeTimer) {
        clearTimeout(externalMergeTimer);
        externalMergeTimer = undefined;
      }
    }}
    onDismissExternalChange={() => {
      externalChangeVisible = false;
    }}
  />

  <section class="document-shell" aria-label="Markdown document">
    {#if notFoundPath === documentPath}
      <DocumentNotFoundState path={documentPath} />
    {:else if provider && providerSynced}
      {#key provider}
        <PlaintextEditor
          ydoc={provider.doc}
          ytext={provider.text}
          livePaths={livePaths}
          orgPeople={orgPeople}
          readOnly={docDeleted}
          scroll="self"
          onWikilinkClick={handleWikilinkClick}
        />
      {/key}
    {:else if mounted}
      <div class="loading">Opening document…</div>
    {/if}
  </section>

  {#if error}
    <p class="error">{error}</p>
  {/if}
</LocalEditorShell>

<style>
  .document-shell {
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-columns: minmax(24px, 1fr) minmax(0, 760px) minmax(24px, 1fr);
    /* A single bounded row so the editor host in column 2 inherits a
       definite height. Without this the implicit grid row is auto-sized
       to the editor's intrinsic content height, so a long document
       grows the editor past the viewport (only arrow keys scroll)
       instead of scrolling inside the `scroll="self"` CM6 scroller. */
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
  }

  .document-shell :global(.kb2-editor-shell),
  .document-shell :global(.document-not-found),
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
    left: 360px;
    bottom: 16px;
    z-index: 30;
    margin: 0;
    max-width: min(520px, calc(100vw - 392px));
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

    .error {
      left: 16px;
      max-width: calc(100vw - 32px);
    }
  }
</style>
