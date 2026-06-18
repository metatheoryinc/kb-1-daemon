<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    createDemoDocumentProvider,
    isDemoDocumentProviderOpenError,
    parseVaultRoute,
    vaultRoute,
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
    ConfirmDialog,
    DocumentNotFoundState,
    EditorSaveNotifications,
    EmptyVaultsState,
    FolderCanvas,
    LocalEditorShell,
    LocalEditorMobileShell,
    MovePickerDialog,
    NewVaultDialog,
    TextInputDialog,
    type AccentName,
    type BreadcrumbItem,
    type DialogField,
    type LocalFolderNode,
    type LocalTreeAction,
    type LocalTreeNode,
    type NewVaultSubmit,
    type RailNavId,
    type VaultFilterEntry,
    type VaultGroupData,
  } from '@kb-2/ui';
  import { kbService, type VaultSummary } from '$lib/kb-service';
  import type { DocumentSessionEvent } from '@kb-2/doc-session/protocol';
  import {
    useAppState,
    ancestorKeysForPath,
    expansionKey,
    type ColorMode,
    type FavoriteEntry,
  } from '$lib/app-state';
  import { buildStarredViewData } from '$lib/favorites-data';
  import { createViewportStore } from '$lib/viewport.svelte';
  import { onMount, untrack } from 'svelte';

  interface TreeEntry {
    path: string;
    kind: 'file' | 'folder';
    metadata?: { color?: AccentName; icon?: string | null };
  }

  // The dialog the orchestration layer currently has open. Each variant
  // carries the operation it will perform on submit; `busy`/`error`
  // surface in-flight and failure state to the dialog.
  type DialogState =
    | { kind: 'none' }
    | {
        kind: 'text';
        title: string;
        description?: string;
        fields: DialogField[];
        submitLabel: string;
        run: (values: string[]) => Promise<void>;
        /** Follow-up after a successful run. Defaults to an active-tree
            refresh; vault-level ops own their own follow-up via `run`. */
        afterSuccess?: () => Promise<void>;
        busy: boolean;
        error: string | null;
      }
    | {
        kind: 'confirm';
        title: string;
        description?: string;
        confirmLabel: string;
        destructive: boolean;
        run: () => Promise<void>;
        afterSuccess?: () => Promise<void>;
        busy: boolean;
        error: string | null;
      }
    | {
        kind: 'move';
        title: string;
        description?: string;
        folderPaths: string[];
        currentParent: string;
        run: (folderPath: string) => Promise<void>;
        busy: boolean;
        error: string | null;
      }
    // The "New vault" dialog. Carries the create op, which always submits
    // both the display name and the (suggested, editable) slug. `busy`/
    // `error` surface in-flight + server validation outcomes inline.
    | {
        kind: 'new-vault';
        run: (value: NewVaultSubmit) => Promise<void>;
        busy: boolean;
        error: string | null;
      };

  let dialog = $state<DialogState>({ kind: 'none' });

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
  // The vaults the daemon serves (id = stable slug, displayName = label).
  // The active id keys every data call and the collaborative socket.
  let knownVaults = $state<VaultSummary[]>([]);
  // Each vault's file tree, fetched lazily over the scoped tree route and
  // cached by vault id. The rail groups by vault, so it needs all trees;
  // the active vault's tree also drives the canvas + wikilink resolution.
  let vaultTrees = $state<Record<string, LocalTreeNode[]>>({});

  // The URL is the single source of truth for the active vault and the
  // open document. Mirroring KB-1's derive-from-route pattern, both are
  // DERIVED from `page.url` via the catch-all route parser, never
  // imperatively assigned. Every navigation (a tree pick, a vault switch,
  // a delete that lands in a survivor, a bootstrap redirect) happens by
  // `goto`-ing the URL; these values then follow. A root or unknown-vault
  // URL yields a null vaultId, which bootstrap normalizes to a real
  // vault. Until that redirect lands the derived id is empty (zero-vault
  // empty state, or the pre-redirect tick).
  const route = $derived(parseVaultRoute(page.url.pathname));
  const activeVaultId = $derived<string>(route.vaultId ?? '');
  const documentPath = $derived<string>(route.vaultId ? route.path : '');

  // The active vault's display name (header + breadcrumb root) and its
  // tree (the canvas + folder resolution operate on the active vault).
  const activeVault = $derived(knownVaults.find((v) => v.id === activeVaultId));
  const vaultName = $derived(activeVault?.displayName ?? activeVaultId);
  const vaultId = $derived(activeVaultId);
  const tree = $derived<LocalTreeNode[]>(vaultTrees[activeVaultId] ?? []);

  // The filter lists every vault. The deny-list lives in the app-state
  // store; toggling hides/shows a vault's group in the rail.
  const vaults = $derived<VaultFilterEntry[]>(
    knownVaults.map((v) => ({ id: v.id, name: v.displayName, accent: 'slate' })),
  );
  // One render-ready group per vault, each carrying its own tree. The
  // rail renders a VaultGroup per entry; trees not yet fetched render
  // empty until their fetch lands.
  const vaultGroups = $derived<VaultGroupData[]>(
    knownVaults.map((v) => ({
      id: v.id,
      name: v.displayName,
      accent: 'slate',
      tree: vaultTrees[v.id] ?? [],
    })),
  );
  // Whether the daemon serves any vaults. Zero vaults is a VALID state
  // (a fresh daemon, or the user deleted the last one) — not an error.
  // When false, the page shows the calm "create your first vault" empty
  // state instead of the editor shell.
  const hasVaults = $derived(knownVaults.length > 0);
  let mounted = $state(false);
  // Which secondary panel the rail has selected. 'files' shows the tree;
  // 'starred' shows the (currently empty) starred view.
  let activeNav = $state<RailNavId>('files');

  // Reactive viewport mode — selects the mobile vs. desktop shell at the
  // breakpoint (mirrors the reference AppLayout's Desktop/Mobile switch).
  // One matchMedia listener owned at the shell root.
  const viewport = createViewportStore();
  // Open/closed state of the mobile shell's left-nav flyout. Hoisted
  // here so canvas-side navigation (a wikilink, a folder-canvas child
  // click) closes the flyout the same way a terminal tree pick does.
  let navOpen = $state(false);

  // The app-state store owns the persisted light / dark / system choice
  // and the root layout applies it to the DOM. The rail toggle's icon is
  // prop-driven on that raw choice, so mirror the store's value here.
  const appState = useAppState();
  let colorModePref = $state<ColorMode>(appState.getState().colorMode);
  // Tree expansion lives in the persisted app-state store. Mirror the
  // two sets into local `$state` so the template tracks them; the store
  // owns mutation and localStorage persistence.
  let expandedFolderIds = $state<Set<string>>(appState.getState().expandedFolderIds);
  let collapsedVaultIds = $state<Set<string>>(appState.getState().collapsedVaultIds);
  // Vault-visibility deny-list and the secondary rail width — both
  // persisted in the app-state store. Mirror into `$state` so the
  // template re-renders on change; the store owns mutation + storage.
  let hiddenVaultIds = $state<string[]>(appState.getState().hiddenVaultIds);
  let secondaryRailWidth = $state<number>(appState.getState().secondaryRailWidth);
  // Primary-rail collapsed state — persisted in the app-state store. The
  // brand mark at the top of the rail toggles it; mirror into `$state` so
  // the template re-renders on change.
  let railCollapsed = $state<boolean>(appState.getState().railCollapsed);
  // Starred notes/folders, mirrored from the persisted store. The store
  // owns mutation + localStorage; the template builds its view model from
  // this list plus the live tree.
  let favorites = $state<FavoriteEntry[]>(appState.getState().favorites);

  // Render-ready starred rows + the path sets the tree menus read to
  // pick Favorite vs Unfavorite. Recomputed when favorites or the tree
  // (availability + accents) change.
  const starredView = $derived(
    buildStarredViewData({ favorites, vaultId, vaultName, tree }),
  );
  const favoritedNotePaths = $derived(
    new Set(favorites.filter((e) => e.kind === 'note' && e.vaultId === vaultId).map((e) => e.path)),
  );
  const favoritedFolderPaths = $derived(
    new Set(favorites.filter((e) => e.kind === 'folder' && e.vaultId === vaultId).map((e) => e.path)),
  );
  // Vaults default open: the persisted shape is a collapse deny-list, so
  // the expanded set is its complement over every known vault. Deriving it
  // across all vaults (not just the active one) keeps each vault's
  // expansion independent, so opening one never collapses another.
  const expandedVaultIds = $derived.by<Set<string>>(() => {
    const out = new Set<string>();
    for (const v of knownVaults) {
      if (!collapsedVaultIds.has(v.id)) out.add(expansionKey('vault', v.id));
    }
    return out;
  });
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

  // Find a node by its vault-relative path in the live tree. Returns the
  // matching folder or file node, or `undefined` when the path isn't in
  // the tree yet (first paint, or a path the vault doesn't carry).
  function findNode(
    nodes: LocalTreeNode[],
    path: string,
  ): LocalTreeNode | undefined {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.kind === 'folder') {
        const hit = findNode(node.children, path);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  // The node the URL currently points at, resolved against the live
  // tree. Mirrors KB-1's selector resolution: the tree decides whether
  // a path is a folder or a note, and the route renders the matching
  // canvas. `undefined` while the tree loads or for a path not (yet) in
  // it — treated as a document so a deep-linked note still opens.
  const activeNode = $derived(findNode(tree, documentPath));
  const viewingFolder = $derived(
    documentPath === '' || activeNode?.kind === 'folder',
  );
  // The folder node backing the canvas — its `children` is the full
  // subtree (direct children plus descendants) the canvas renders. At
  // vault root there is no node, so the canvas reads the whole tree.
  const activeFolderNode = $derived<LocalFolderNode | undefined>(
    activeNode?.kind === 'folder' ? activeNode : undefined,
  );
  // The active folder row key for the tree highlight + three-state
  // click. Empty path (vault root) has no folder row to highlight.
  const activeFolderId = $derived(
    viewingFolder && documentPath !== ''
      ? expansionKey('folder', vaultId, documentPath)
      : undefined,
  );

  // Pull `{ vaultId, path }` back out of an opaque folder key
  // (`folder:<vaultId>:<path>`). The shell's three-state click hands us
  // the key; navigation needs both the vault and the path. The vault id
  // is a slug (no colon); the path is whatever follows the second colon.
  function folderKeyParts(key: string): { vaultId: string; path: string } {
    const withoutKind = key.startsWith('folder:') ? key.slice('folder:'.length) : key;
    const colon = withoutKind.indexOf(':');
    if (colon === -1) return { vaultId: activeVaultId, path: withoutKind };
    return {
      vaultId: withoutKind.slice(0, colon),
      path: withoutKind.slice(colon + 1),
    };
  }

  // Pull `{ vaultId, path }` back out of an opaque file-row id
  // (`note:<vaultId>:<path>`) — the file twin of folderKeyParts.
  function noteKeyParts(key: string): { vaultId: string; path: string } {
    const withoutKind = key.startsWith('note:') ? key.slice('note:'.length) : key;
    const colon = withoutKind.indexOf(':');
    if (colon === -1) return { vaultId: activeVaultId, path: withoutKind };
    return {
      vaultId: withoutKind.slice(0, colon),
      path: withoutKind.slice(colon + 1),
    };
  }

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

  // The document header's status chip is deliberately ERROR-ONLY. This is
  // a local-first editor: a successful save is the expected default, so
  // success and the optimistic in-progress states ("Saved" / "Saving…" /
  // "Connecting…") render nothing — silence means it's working. The chip
  // only surfaces PROBLEM states where edits are not safely persisting:
  // a persist/save failure, a connection error, or a disconnect. This
  // matches the daemon's edits-save-or-fail-loudly invariant (loud on
  // failure, quiet on success). Returning undefined hides the chip
  // entirely (DocumentHeader renders it only when a label is present),
  // so it also disappears on recovery. Folder views (no provider) have
  // no label either.
  const statusLabel = $derived.by<string | undefined>(() => {
    if (viewingFolder) return undefined;
    if (persistFailureActive) return 'Not saving';
    switch (status) {
      // Success + optimistic states stay silent — nothing rendered.
      case 'open':
      case 'syncing':
      case 'connecting':
        return undefined;
      // Problem states stay loud and visible.
      case 'error':
        return 'Connection error';
      default:
        return 'Disconnected';
    }
  });

  // The document header breadcrumb trail. Built in the app from the
  // active path so the package stays free of path-parsing policy
  // (prop-driven, matching the reference header). The vault name is the
  // first crumb; each path segment follows, with the leaf marked
  // current. A folder view marks its own leaf current too.
  const breadcrumbItems = $derived<BreadcrumbItem[]>([
    { label: vaultName, current: documentPath === '' },
    ...documentPath
      .split('/')
      .filter(Boolean)
      .map((segment, index, parts) => ({
        label: segment,
        current: index === parts.length - 1,
      })),
  ]);

  // Whether the active document is favorited — drives the header's
  // favorite toggle. Folder views toggle the folder's favorite instead.
  const documentFavorited = $derived(
    viewingFolder
      ? favoritedFolderPaths.has(documentPath)
      : favoritedNotePaths.has(documentPath),
  );

  // ---- Document-header actions ----------------------------------------
  // These reuse the same dialog/favorites orchestration the tree-row
  // menus use, synthesizing a LocalTreeAction for the active document so
  // the header's overflow menu and the tree menu run identical flows.

  function toggleDocumentFavorite(): void {
    if (documentPath === '') return;
    appState.toggleFavorite({
      kind: viewingFolder ? 'folder' : 'note',
      vaultId,
      path: documentPath,
    });
  }

  function renameDocument(): void {
    if (documentPath === '') return;
    handleTreeAction(
      viewingFolder
        ? { kind: 'folder', action: 'rename', path: documentPath }
        : { kind: 'file', action: 'rename', path: documentPath },
    );
  }

  function moveDocument(): void {
    if (documentPath === '') return;
    handleTreeAction(
      viewingFolder
        ? { kind: 'folder', action: 'move', path: documentPath }
        : { kind: 'file', action: 'move', path: documentPath },
    );
  }

  function deleteDocument(): void {
    if (documentPath === '') return;
    handleTreeAction(
      viewingFolder
        ? { kind: 'folder', action: 'delete', path: documentPath }
        : { kind: 'file', action: 'delete', path: documentPath },
    );
  }

  function handleSessionEvent(event: DocumentSessionEvent): void {
    if (event.kind === 'doc-moved') {
      const nextPath = event.toPath ?? event.path;
      docDeleted = false;
      // Navigate to the moved path; the derived document path follows and
      // the provider effect rebinds onto the new location.
      void goto(vaultRoute(activeVaultId, nextPath), { replaceState: true, noScroll: true, keepFocus: true });
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
      vaultId: activeVaultId,
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

  // Open a document by navigating to its URL. The derived document path
  // follows, and the provider effect rebinds the Yjs provider (or tears
  // it down for a folder/root). No state is mutated here.
  async function openDocument(path: string): Promise<void> {
    if (path === documentPath && notFoundPath !== path) return;
    await goto(vaultRoute(activeVaultId, path), { noScroll: true, keepFocus: true });
  }

  // Switch the active vault: navigate to its root. The derived active id
  // follows the new URL; the active-vault effect remembers it as the
  // last-opened and loads its tree if uncached.
  async function openVault(vaultId: string): Promise<void> {
    if (vaultId === activeVaultId) return;
    await goto(vaultRoute(vaultId, ''), { noScroll: true });
  }

  // The file row hands its opaque id (`note:<vaultId>:<path>`), the same
  // vault-bearing identity folder rows use. Decode the owning vault and
  // route there, switching the active vault when it differs — so a note
  // never opens in the wrong vault just because another vault is active.
  // Mirrors openFolder.
  function openFileFromRow(key: string): void {
    const { vaultId: keyVaultId, path } = noteKeyParts(key);
    if (keyVaultId !== activeVaultId) {
      void goto(vaultRoute(keyVaultId, path), { noScroll: true, keepFocus: true });
      return;
    }
    void openDocument(path);
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

  // Tear down any open provider and reset the document-canvas state. Used
  // when the derived path resolves to a folder (or vault root), which
  // renders the folder canvas and needs no Yjs document.
  function teardownProvider(): void {
    provider?.destroy();
    provider = null;
    providerSynced = false;
    status = 'connecting';
    notFoundPath = null;
    docDeleted = false;
  }

  function toggleFolder(key: string): void {
    appState.toggleFolderExpanded(key);
  }

  // The tree row's three-state click reaches its "open + not active"
  // branch via onOpenFolder: navigate to the folder so its canvas
  // renders and the row goes active. (Closed → expand and open + active
  // → collapse are handled inside the row itself via onToggleFolder.)
  function openFolder(key: string): void {
    const { vaultId: keyVaultId, path } = folderKeyParts(key);
    if (keyVaultId !== activeVaultId) {
      void goto(vaultRoute(keyVaultId, path), { noScroll: true, keepFocus: true });
      return;
    }
    void openDocument(path);
  }

  // Pull the vault id back out of an opaque vault key (`vault:<id>`).
  function vaultIdFromKey(key: string): string {
    return key.startsWith('vault:') ? key.slice('vault:'.length) : key;
  }

  function toggleVault(key: string): void {
    // The vault key encodes the id (`vault:<id>`); the deny-list is keyed
    // by raw id, so collapse iff that vault is currently expanded.
    appState.setVaultCollapsed(vaultIdFromKey(key), expandedVaultIds.has(key));
  }

  // A vault header click navigates to that vault's root (switching the
  // active vault when it differs). The header also toggles expansion via
  // `onToggleVault`, so this only owns the navigate.
  function openVaultFromKey(key: string): void {
    void openVault(vaultIdFromKey(key));
  }

  function toggleColorMode(): void {
    appState.cycleColorMode();
  }

  function toggleRailCollapsed(): void {
    appState.toggleRailCollapsed();
  }

  function toggleVaultHidden(id: string): void {
    appState.toggleVaultHidden(id);
  }

  function resizeRail(next: number): void {
    appState.setSecondaryRailWidth(next);
  }

  // Load the vault list. The display names drive the rail + breadcrumb;
  // the ids drive every scoped route. Returns the loaded list so the
  // caller can pick a default vault on first load.
  async function refreshVaults(): Promise<VaultSummary[]> {
    try {
      knownVaults = await kbService.listVaults();
      return knownVaults;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      return knownVaults;
    }
  }

  // Fetch one vault's tree into the per-vault cache. The rail groups by
  // vault, so every known vault's tree is fetched; the active vault's
  // also feeds the canvas + wikilink resolution.
  async function loadVaultTree(vaultId: string): Promise<void> {
    if (!vaultId) return;
    try {
      const entries = await kbService.tree(vaultId);
      vaultTrees = { ...vaultTrees, [vaultId]: buildTree(entries as TreeEntry[]) };
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  // Refresh every known vault's tree (rail grouping needs them all).
  async function loadAllTrees(): Promise<void> {
    await Promise.all(knownVaults.map((v) => loadVaultTree(v.id)));
  }

  // Refresh the ACTIVE vault's tree — used after a file/folder mutation.
  async function refreshTree(): Promise<void> {
    await loadVaultTree(activeVaultId);
  }

  // ---- Path helpers for the file-management operations ----------------

  // Join a parent folder path with a leaf name. The vault root is the
  // empty string, so a root-level child is just its name.
  function joinPath(parent: string, name: string): string {
    return parent ? `${parent}/${name}` : name;
  }

  // The leaf name (with extension, for files) of a full path.
  function leafName(path: string): string {
    return path.split('/').filter(Boolean).at(-1) ?? path;
  }

  // Ensure a note name carries a `.md` extension so the daemon writes a
  // markdown file regardless of what the user typed.
  function withMarkdownExtension(name: string): string {
    return /\.[^/]+$/.test(name) ? name : `${name}.md`;
  }

  // Every folder path in the live tree — the move picker's destination
  // list, plus the rename collision base.
  function collectFolderPaths(nodes: LocalTreeNode[]): string[] {
    const out: string[] = [];
    const walk = (list: LocalTreeNode[]): void => {
      for (const node of list) {
        if (node.kind === 'folder') {
          out.push(node.path);
          walk(node.children);
        }
      }
    };
    walk(nodes);
    return out;
  }

  // ---- Dialog orchestration -------------------------------------------

  function closeDialog(): void {
    dialog = { kind: 'none' };
  }

  // Apply a busy/error patch to whichever dialog is currently open. The
  // open dialog's variant is preserved; a closed dialog is left alone.
  function patchDialog(patch: { busy: boolean; error: string | null }): void {
    const current = dialog;
    if (current.kind === 'none') return;
    dialog = { ...current, ...patch };
  }

  // Run a dialog's operation, keeping the dialog open with a busy/error
  // state so a failure surfaces in-place rather than being swallowed. By
  // default a success refreshes the active vault's tree; vault-level ops
  // (create/rename/delete) pass their own follow-up via `afterSuccess`.
  async function runDialogOperation(operation: () => Promise<void>): Promise<void> {
    if (dialog.kind === 'none') return;
    const afterSuccess =
      (dialog.kind === 'text' || dialog.kind === 'confirm') && dialog.afterSuccess
        ? dialog.afterSuccess
        : refreshTree;
    patchDialog({ busy: true, error: null });
    try {
      await operation();
      await afterSuccess();
      closeDialog();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      patchDialog({ busy: false, error: message });
    }
  }

  // Run the new-vault create, keeping the dialog open with busy/error so a
  // server validation outcome (bad slug, collision) surfaces inline. The
  // create op already refreshes the list + navigates, so there's no tree
  // follow-up here (and there may be no active tree on the first vault).
  async function runNewVaultDialog(value: NewVaultSubmit): Promise<void> {
    if (dialog.kind !== 'new-vault') return;
    const run = dialog.run;
    patchDialog({ busy: true, error: null });
    try {
      await run(value);
      closeDialog();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      patchDialog({ busy: false, error: message });
    }
  }

  function handleTreeAction(action: LocalTreeAction): void {
    if (action.kind === 'file') {
      openFileDialog(action);
    } else if (action.kind === 'folder') {
      openFolderDialog(action);
    } else {
      openVaultDialog(action);
    }
  }

  function openFileDialog(action: Extract<LocalTreeAction, { kind: 'file' }>): void {
    const parent = parentOf(action.path);
    const name = leafName(action.path);

    if (action.action === 'favorite' || action.action === 'unfavorite') {
      appState.toggleFavorite({ kind: 'note', vaultId, path: action.path });
      return;
    }

    if (action.action === 'delete') {
      dialog = {
        kind: 'confirm',
        title: 'Delete note',
        description: `Delete “${name}”? This moves it to the trash.`,
        confirmLabel: 'Delete',
        destructive: true,
        busy: false,
        error: null,
        run: async () => {
          await kbService.deleteNote(vaultId, action.path);
          appState.favoritesOnNoteDeleted(vaultId, action.path);
        },
      };
      return;
    }

    if (action.action === 'rename') {
      dialog = {
        kind: 'text',
        title: 'Rename note',
        fields: [{ type: 'text', label: 'Name', initialValue: name, required: true }],
        submitLabel: 'Rename',
        busy: false,
        error: null,
        run: async ([nextName]) => {
          const target = joinPath(parent, withMarkdownExtension(nextName));
          if (target === action.path) return;
          await kbService.moveNote(vaultId, action.path, target);
          appState.favoritesOnNoteRenamed(vaultId, action.path, target);
        },
      };
      return;
    }

    // move
    dialog = {
      kind: 'move',
      title: 'Move note',
      description: `Choose a destination folder for “${name}”.`,
      folderPaths: collectFolderPaths(tree),
      currentParent: parent,
      busy: false,
      error: null,
      run: async (destination) => {
        const target = joinPath(destination, name);
        if (target === action.path) return;
        await kbService.moveNote(vaultId, action.path, target);
        appState.favoritesOnNoteRenamed(vaultId, action.path, target);
      },
    };
  }

  function openFolderDialog(action: Extract<LocalTreeAction, { kind: 'folder' }>): void {
    const parent = parentOf(action.path);
    const name = leafName(action.path);

    if (action.action === 'favorite' || action.action === 'unfavorite') {
      appState.toggleFavorite({ kind: 'folder', vaultId, path: action.path });
      return;
    }

    if (action.action === 'new-note') {
      openNewNoteDialog(action.path);
      return;
    }

    if (action.action === 'new-folder') {
      openNewFolderDialog(action.path);
      return;
    }

    if (action.action === 'delete') {
      dialog = {
        kind: 'confirm',
        title: 'Delete folder',
        description: `Delete “${name}” and everything inside it?`,
        confirmLabel: 'Delete',
        destructive: true,
        busy: false,
        error: null,
        run: async () => {
          await kbService.deleteFolder(vaultId, action.path);
          appState.favoritesOnFolderDeleted(vaultId, action.path);
        },
      };
      return;
    }

    if (action.action === 'rename') {
      dialog = {
        kind: 'text',
        title: 'Rename folder',
        fields: [{ type: 'text', label: 'Name', initialValue: name, required: true }],
        submitLabel: 'Rename',
        busy: false,
        error: null,
        run: async ([nextName]) => {
          const target = joinPath(parent, nextName);
          if (target === action.path) return;
          await kbService.moveFolder(vaultId, action.path, target);
          appState.favoritesOnFolderRenamed(vaultId, action.path, target);
        },
      };
      return;
    }

    // move
    dialog = {
      kind: 'move',
      title: 'Move folder',
      description: `Choose a destination folder for “${name}”.`,
      // A folder cannot move into itself or a descendant; exclude them.
      folderPaths: collectFolderPaths(tree).filter(
        (path) => path !== action.path && !path.startsWith(`${action.path}/`),
      ),
      currentParent: parent,
      busy: false,
      error: null,
      run: async (destination) => {
        const target = joinPath(destination, name);
        if (target === action.path) return;
        await kbService.moveFolder(vaultId, action.path, target);
        appState.favoritesOnFolderRenamed(vaultId, action.path, target);
      },
    };
  }

  function openVaultDialog(action: Extract<LocalTreeAction, { kind: 'vault' }>): void {
    // `new-vault` is vault-list-level (no target vault).
    if (action.action === 'new-vault') {
      openNewVaultDialog();
      return;
    }

    // Every other vault action targets the group whose menu was used. The
    // group stamps its id; fall back to the active vault for safety.
    const targetVaultId = action.vaultId ?? activeVaultId;
    const target = knownVaults.find((v) => v.id === targetVaultId);
    const targetName = target?.displayName ?? targetVaultId;

    if (action.action === 'new-note') {
      // Act in the targeted vault: switch to it first so the create +
      // open land in the right vault, then open the dialog.
      void openVault(targetVaultId).then(() => openNewNoteDialog(''));
      return;
    }
    if (action.action === 'new-folder') {
      void openVault(targetVaultId).then(() => openNewFolderDialog(''));
      return;
    }
    if (action.action === 'rename') {
      dialog = {
        kind: 'text',
        title: 'Rename vault',
        description: `Rename “${targetName}”. The vault’s folder on disk is unchanged.`,
        fields: [{ type: 'text', label: 'Name', initialValue: targetName, required: true }],
        submitLabel: 'Rename',
        busy: false,
        error: null,
        run: async ([nextName]) => {
          const trimmed = nextName.trim();
          if (!trimmed || trimmed === targetName) return;
          await kbService.renameVault(targetVaultId, trimmed);
        },
        // A rename only changes display names — refresh the list.
        afterSuccess: async () => {
          await refreshVaults();
        },
      };
      return;
    }
    // delete (soft-delete; the daemon moves the folder to trash)
    dialog = {
      kind: 'confirm',
      title: 'Delete vault',
      description: `Delete “${targetName}”? Its folder moves to the trash and the vault leaves the rail.`,
      confirmLabel: 'Delete',
      destructive: true,
      busy: false,
      error: null,
      run: async () => {
        await kbService.deleteVault(targetVaultId);
      },
      // Drop the vault from the list. If it was the active one, land in a
      // survivor — or, when it was the LAST vault, in the empty state
      // (zero vaults is valid). Both land by NAVIGATING; the derived
      // active vault + document follow, and the provider effect tears
      // down the editor. Deleting the last vault also clears last-opened
      // so a stale slug isn't reopened next cold load.
      afterSuccess: async () => {
        await refreshVaults();
        if (targetVaultId === activeVaultId) {
          const survivor = knownVaults[0];
          if (survivor) {
            await goto(vaultRoute(survivor.id, ''), { noScroll: true });
          } else {
            // No vaults left — navigate to the root empty state cleanly.
            appState.setLastOpenedVaultId(null);
            await goto('/', { replaceState: true, noScroll: true });
          }
        }
      },
    };
  }

  // The "New vault" affordance (footer + empty state). Opens the
  // slug-suggest dialog, which auto-suggests a slug from the display name
  // (client-side, the SAME github-slugger definition the daemon uses),
  // lets the user edit it, and ALWAYS submits both `{ displayName, slug }`.
  // The server validates the slug (format + uniqueness): a bad slug (400)
  // or a collision (409) surfaces inline in the dialog's error slot, never
  // a silent failure. On success the new vault appears in the rail and
  // becomes active.
  function openNewVaultDialog(): void {
    dialog = {
      kind: 'new-vault',
      busy: false,
      error: null,
      run: async ({ displayName, slug }) => {
        const created = await kbService.createVault(displayName, slug);
        // Reflect the new vault and switch to it.
        await refreshVaults();
        await openVault(created.id);
      },
    };
  }

  function openNewNoteDialog(parent: string): void {
    dialog = {
      kind: 'text',
      title: 'New note',
      description: parent ? `Create a note in “${leafName(parent)}”.` : 'Create a note at the vault root.',
      fields: [{ type: 'text', label: 'Name', placeholder: 'untitled', required: true }],
      submitLabel: 'Create',
      busy: false,
      error: null,
      run: async ([nextName]) => {
        const target = joinPath(parent, withMarkdownExtension(nextName));
        await kbService.createNote(vaultId, target);
        if (parent) appState.expandFolders([expansionKey('folder', vaultId, parent)]);
        await openDocument(target);
      },
    };
  }

  function openNewFolderDialog(parent: string): void {
    dialog = {
      kind: 'text',
      title: 'New folder',
      description: parent ? `Create a folder in “${leafName(parent)}”.` : 'Create a folder at the vault root.',
      fields: [{ type: 'text', label: 'Name', placeholder: 'untitled', required: true }],
      submitLabel: 'Create',
      busy: false,
      error: null,
      run: async ([nextName]) => {
        const target = joinPath(parent, nextName);
        await kbService.createFolder(vaultId, target);
        // Unfurl the parent and the new folder so the addition is visible.
        const keys = [expansionKey('folder', vaultId, target)];
        if (parent) keys.push(expansionKey('folder', vaultId, parent));
        appState.expandFolders(keys);
      },
    };
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
    hiddenVaultIds = snapshot.hiddenVaultIds;
    secondaryRailWidth = snapshot.secondaryRailWidth;
    railCollapsed = snapshot.railCollapsed;
    favorites = snapshot.favorites;
    return appState.subscribe((s) => {
      expandedFolderIds = s.expandedFolderIds;
      collapsedVaultIds = s.collapsedVaultIds;
      hiddenVaultIds = s.hiddenVaultIds;
      secondaryRailWidth = s.secondaryRailWidth;
      railCollapsed = s.railCollapsed;
      favorites = s.favorites;
    });
  });

  // On load and on navigation, walk the active file's ancestor chain
  // into the expanded set so a deep-linked note's row is visible. The
  // vault un-collapse keeps a refresh-into-a-collapsed-vault honest.
  // `untrack` keeps the store writes from re-triggering this effect.
  // Keyed on the derived path + vault, so it tracks the URL.
  $effect(() => {
    const path = documentPath;
    const id = vaultId;
    if (!id) return;
    untrack(() => {
      appState.setVaultCollapsed(id, false);
      const keys = ancestorKeysForPath(path, id);
      if (keys.length > 0) appState.expandFolders(keys);
    });
  });

  // URL → active vault. Whenever the derived active vault changes (a
  // vault-header click, a cross-vault file/folder open, a bootstrap
  // redirect, a delete landing in a survivor), remember it as the
  // last-opened so the next cold load reopens here, and load its tree if
  // it isn't cached yet. Replaces the old `afterNavigate` vault branch;
  // it fires for EVERY active-vault change, including cross-vault opens
  // that never went through `openVault`.
  $effect(() => {
    const id = activeVaultId;
    if (!id) return;
    untrack(() => {
      appState.setLastOpenedVaultId(id);
      if (!vaultTrees[id]) void loadVaultTree(id);
    });
  });

  // URL → Yjs provider. The derived document path owns the provider
  // lifecycle: a file opens a provider; a folder (or the vault root)
  // tears it down and renders the folder canvas — mirroring KB-1's
  // selector picking FolderCanvas over DocumentCanvas. Keyed on the
  // active vault + path so it reacts to navigation, NOT to tree
  // refreshes (which would needlessly reopen the live provider); the
  // folder/file split is read against the live tree via `untrack`. A
  // path the tree doesn't carry yet falls through as a document so
  // deep-linked notes still open; the folder-canvas teardown effect
  // below corrects a stray provider once the tree resolves it to a
  // folder.
  $effect(() => {
    const id = activeVaultId;
    const path = documentPath;
    if (!id) return;
    untrack(() => {
      if (path === '' || findNode(tree, path)?.kind === 'folder') {
        teardownProvider();
        return;
      }
      openProvider(path);
    });
  });

  // A folder deep-link on cold load opens a provider before the tree has
  // loaded (the folder/file split can't be made yet). Once the tree
  // arrives and the path resolves to a folder, tear that stray provider
  // down — the folder canvas renders instead of the editor.
  $effect(() => {
    if (!viewingFolder || !provider) return;
    untrack(() => {
      provider?.destroy();
      provider = null;
      providerSynced = false;
    });
  });

  // First-load bootstrap. Load the vault list, then — when the URL is the
  // root or an unknown vault — RESOLVE a target (last-opened vault if it
  // still exists, else the first in the list; there is NO default vault)
  // and REDIRECT to `/<vaultId>/<path>` via `goto`. The derived active
  // vault + document follow the corrected URL; the active-vault and
  // provider effects then persist last-opened, load trees, and bind the
  // document. Bootstrap mutates no routing state — it only nudges the URL.
  // Zero vaults is a valid state: nothing to open, the empty state renders.
  async function bootstrap(): Promise<void> {
    const loaded = await refreshVaults();
    if (loaded.length === 0) {
      // No vaults to serve — a fresh daemon or every vault deleted. This
      // is normal, not an error; the empty "create your first vault" state
      // renders. Forget any stale last-opened so we don't reopen a gone
      // vault when one is created. The URL stays at the root, which the
      // derived values read as the empty state.
      appState.setLastOpenedVaultId(null);
      return;
    }

    const current = parseVaultRoute(window.location.pathname);
    const known = current.vaultId && loaded.some((v) => v.id === current.vaultId);
    if (known) {
      // The URL already names a real vault; the derived values already
      // point at it. Just load the rail's trees (the active vault's tree
      // load is also covered by the active-vault effect).
      void loadAllTrees();
      return;
    }

    // Root or unknown vault — resolve the fallback and redirect. The
    // derived active vault + document follow the corrected URL.
    const remembered = appState.getState().lastOpenedVaultId;
    const fallbackId =
      remembered && loaded.some((v) => v.id === remembered)
        ? remembered
        : loaded[0].id;
    await goto(vaultRoute(fallbackId, ''), {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
    void loadAllTrees();
  }

  onMount(() => {
    mounted = true;
    void bootstrap();

    return () => {
      mounted = false;
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

<!-- Shared canvas body. Both shells render identical content — the
     mobile shell just frames it in mobile chrome. Folder-canvas child
     clicks and wikilink jumps close the mobile flyout (terminal nav)
     via `navOpen`; on desktop `navOpen` is inert. -->
{#snippet canvasBody()}
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

  {#if viewingFolder}
    <!-- Folder view: the tree resolved this path to a folder (or the
         vault root), so render the folder canvas instead of the editor.
         The shell's DocumentHeader above already shows the breadcrumb +
         title; the canvas owns the body (stats + contents). Child rows
         navigate — a note opens the editor, a folder opens its canvas. -->
    <FolderCanvas
      {vaultName}
      folderPath={documentPath}
      metadata={activeFolderNode?.metadata}
      children={activeFolderNode?.children ?? tree}
      onOpenFile={(path) => {
        navOpen = false;
        void openDocument(path);
      }}
      onOpenFolder={(path) => {
        navOpen = false;
        void openDocument(path);
      }}
    />
  {:else}
    <!-- Document scroll structure ported from the reference DocumentCanvas:
         `.doc-body` is the full-width scroll container so the whole pane
         scrolls (header stays pinned in the shell above), and `.doc-column`
         centers the content at a fixed prose measure with `margin: 0 auto`.
         The editor mounts with `scroll="external"`, handing scroll ownership
         to `.doc-body`. There are no side gutter columns, so no dark bands
         beside the document. -->
    <div class="doc-body-wrap">
      <div class="doc-body">
        {#if notFoundPath === documentPath}
          <DocumentNotFoundState path={documentPath} />
        {:else if provider && providerSynced}
          <div class="doc-column">
            {#key provider}
              <PlaintextEditor
                ydoc={provider.doc}
                ytext={provider.text}
                livePaths={livePaths}
                orgPeople={orgPeople}
                readOnly={docDeleted}
                scroll="external"
                class="vault-editor"
                onWikilinkClick={handleWikilinkClick}
              />
            {/key}
          </div>
        {:else if mounted}
          <div class="loading">Opening document…</div>
        {/if}
      </div>
    </div>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}
{/snippet}

{#if !hasVaults}
  <!-- Zero vaults is a valid state (fresh daemon, or the last vault was
       deleted). Show the calm "create your first vault" empty state with
       a way to create one — no error, no blank void. The create button
       opens the same slug-suggest dialog the footer uses. -->
  <EmptyVaultsState onCreateVault={openNewVaultDialog} />
{:else if viewport.mode === 'mobile'}
  <LocalEditorMobileShell
    bind:navOpen
    {vaultName}
    {vaultId}
    {documentPath}
    {breadcrumbItems}
    {statusLabel}
    {documentFavorited}
    onToggleDocumentFavorite={documentPath === '' ? undefined : toggleDocumentFavorite}
    onRenameDocument={documentPath === '' ? undefined : renameDocument}
    onMoveDocument={documentPath === '' ? undefined : moveDocument}
    onDeleteDocument={documentPath === '' ? undefined : deleteDocument}
    colorModeChoice={colorModePref}
    {activeNav}
    {tree}
    {vaultGroups}
    activeVaultIdForPath={activeVaultId}
    {vaults}
    {hiddenVaultIds}
    {expandedFolderIds}
    {expandedVaultIds}
    {activeFolderId}
    {favoritedFolderPaths}
    {favoritedNotePaths}
    starredFolders={starredView.folders}
    starredNotes={starredView.notes}
    onSelectNav={(id) => {
      activeNav = id;
    }}
    onToggleVaultHidden={toggleVaultHidden}
    onToggleColorMode={toggleColorMode}
    onToggleFolder={toggleFolder}
    onToggleVault={toggleVault}
    onOpenFile={openFileFromRow}
    onOpenFolder={openFolder}
    onOpenVault={openVaultFromKey}
    onTreeAction={handleTreeAction}
    onNewVault={openNewVaultDialog}
  >
    {@render canvasBody()}
  </LocalEditorMobileShell>
{:else}
  <LocalEditorShell
    {vaultName}
    {vaultId}
    {daemonLabel}
    {daemonStatus}
    {documentPath}
    {breadcrumbItems}
    {statusLabel}
    {documentFavorited}
    onToggleDocumentFavorite={documentPath === '' ? undefined : toggleDocumentFavorite}
    onRenameDocument={documentPath === '' ? undefined : renameDocument}
    onMoveDocument={documentPath === '' ? undefined : moveDocument}
    onDeleteDocument={documentPath === '' ? undefined : deleteDocument}
    colorModeChoice={colorModePref}
    {activeNav}
    {railCollapsed}
    {tree}
    {vaultGroups}
    activeVaultIdForPath={activeVaultId}
    {vaults}
    {hiddenVaultIds}
    {secondaryRailWidth}
    {expandedFolderIds}
    {expandedVaultIds}
    {activeFolderId}
    {favoritedFolderPaths}
    {favoritedNotePaths}
    starredFolders={starredView.folders}
    starredNotes={starredView.notes}
    onSelectNav={(id) => {
      activeNav = id;
    }}
    onToggleVaultHidden={toggleVaultHidden}
    onResizeRail={resizeRail}
    onToggleColorMode={toggleColorMode}
    onToggleRailCollapsed={toggleRailCollapsed}
    onToggleFolder={toggleFolder}
    onToggleVault={toggleVault}
    onOpenFile={openFileFromRow}
    onOpenFolder={openFolder}
    onOpenVault={openVaultFromKey}
    onTreeAction={handleTreeAction}
    onNewVault={openNewVaultDialog}
  >
    {@render canvasBody()}
  </LocalEditorShell>
{/if}

{#if dialog.kind === 'text'}
  <TextInputDialog
    open
    title={dialog.title}
    description={dialog.description}
    fields={dialog.fields}
    submitLabel={dialog.submitLabel}
    busy={dialog.busy}
    error={dialog.error}
    onsubmit={(values) => {
      void runDialogOperation(() => dialog.kind === 'text' ? dialog.run(values) : Promise.resolve());
    }}
    oncancel={closeDialog}
  />
{:else if dialog.kind === 'confirm'}
  <ConfirmDialog
    open
    title={dialog.title}
    description={dialog.description}
    confirmLabel={dialog.confirmLabel}
    destructive={dialog.destructive}
    busy={dialog.busy}
    error={dialog.error}
    onconfirm={() => {
      void runDialogOperation(() => dialog.kind === 'confirm' ? dialog.run() : Promise.resolve());
    }}
    oncancel={closeDialog}
  />
{:else if dialog.kind === 'move'}
  <MovePickerDialog
    open
    title={dialog.title}
    description={dialog.description}
    folderPaths={dialog.folderPaths}
    currentParent={dialog.currentParent}
    busy={dialog.busy}
    error={dialog.error}
    onsubmit={(destination) => {
      void runDialogOperation(() => dialog.kind === 'move' ? dialog.run(destination) : Promise.resolve());
    }}
    oncancel={closeDialog}
  />
{:else if dialog.kind === 'new-vault'}
  <NewVaultDialog
    open
    busy={dialog.busy}
    error={dialog.error}
    onsubmit={(value) => {
      void runNewVaultDialog(value);
    }}
    oncancel={closeDialog}
  />
{/if}

<style>
  /* Scroll structure ported from the reference DocumentCanvas. */
  .doc-body-wrap {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .doc-body {
    flex: 1;
    min-height: 0;
    /* The full-width pane is the scroll container — long docs scroll
       here while the header stays pinned in the shell above. */
    overflow-y: auto;
    position: relative;
    /* Horizontal gutter is symmetric padding on the scroll pane (NOT a
       bordered side column), so the panel background runs edge to edge
       with no dark bands beside the document. */
    padding: 0 56px 96px;
    background: var(--rd-panel);
  }

  @media (max-width: 880px) {
    .doc-body {
      padding: 0 44px 64px;
    }
  }

  /* Single owning element for the document column geometry — the editor
     is a width:100% child, centered at a fixed prose measure. */
  .doc-column {
    max-width: 760px;
    margin: 0 auto;
    width: 100%;
  }

  /* Editor surface only — transparent so the doc-body's panel color
     shows through. Top breathing room sits on the column, not a header
     band. */
  .doc-body :global(.vault-editor) {
    background: transparent;
  }

  .doc-body :global(.plaintext-editor .cm-content) {
    padding-top: 28px;
  }

  .loading {
    max-width: 760px;
    margin: 0 auto;
    width: 100%;
    padding: 24px 0;
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
    .error {
      left: 16px;
      max-width: calc(100vw - 32px);
    }
  }
</style>
