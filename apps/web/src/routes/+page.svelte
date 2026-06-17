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
    ConfirmDialog,
    DocumentNotFoundState,
    EditorSaveNotifications,
    LocalEditorShell,
    MovePickerDialog,
    TextInputDialog,
    type AccentName,
    type DialogField,
    type LocalTreeAction,
    type LocalTreeNode,
    type RailNavId,
    type VaultFilterEntry,
  } from '@kb-2/ui';
  import { kbService } from '$lib/kb-service';
  import type { DocumentSessionEvent } from '@kb-2/doc-session/protocol';
  import {
    useAppState,
    ancestorKeysForPath,
    expansionKey,
    type ColorMode,
    type FavoriteEntry,
  } from '$lib/app-state';
  import { buildStarredViewData } from '$lib/favorites-data';
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
  let documentPath = $state('hello-world.md');
  let vaultName = $state('Vault');
  let tree = $state<LocalTreeNode[]>([]);
  // Stable id seeding the tree's expansion keys. The single local vault
  // has no durable id of its own, so the vault name stands in.
  const vaultId = $derived(vaultName);
  // The filter lists the single local vault. The deny-list lives in the
  // app-state store; toggling here hides/shows the lone vault's tree.
  const vaults = $derived<VaultFilterEntry[]>([
    { id: vaultId, name: vaultName, accent: 'slate' },
  ]);
  let mounted = $state(false);
  // Which secondary panel the rail has selected. 'files' shows the tree;
  // 'starred' shows the (currently empty) starred view.
  let activeNav = $state<RailNavId>('files');

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
  // Starred notes/folders, mirrored from the persisted store. The store
  // owns mutation + localStorage; the template builds its view model from
  // this list plus the live tree.
  let favorites = $state<FavoriteEntry[]>(appState.getState().favorites);

  // Render-ready starred rows + the path sets the tree menus read to
  // pick Favorite vs Unfavorite. Recomputed when favorites or the tree
  // (availability + accents) change.
  const starredView = $derived(
    buildStarredViewData({ favorites, vaultId, tree }),
  );
  const favoritedNotePaths = $derived(
    new Set(favorites.filter((e) => e.kind === 'note' && e.vaultId === vaultId).map((e) => e.path)),
  );
  const favoritedFolderPaths = $derived(
    new Set(favorites.filter((e) => e.kind === 'folder' && e.vaultId === vaultId).map((e) => e.path)),
  );
  // Vaults default open: the persisted shape is a collapse deny-list, so
  // the expanded set is its complement over the one local vault.
  const expandedVaultIds = $derived.by<Set<string>>(() => {
    const out = new Set<string>();
    if (!collapsedVaultIds.has(vaultId)) out.add(expansionKey('vault', vaultId));
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
    rebindDocument(path);
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

  function rebindDocument(path: string): void {
    documentPath = path;
    openProvider(path);
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

  function toggleVaultHidden(id: string): void {
    appState.toggleVaultHidden(id);
  }

  function resizeRail(next: number): void {
    appState.setSecondaryRailWidth(next);
  }

  // Remove a starred row from favorites (from the starred panel).
  function unstar(entry: { kind: 'note' | 'folder'; path: string }): void {
    appState.removeFavorite({ kind: entry.kind, vaultId, path: entry.path });
  }

  async function refreshVaultInfo(): Promise<void> {
    try {
      const info = await kbService.vaultInfo();
      vaultName = info.rootName;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  async function refreshTree(): Promise<void> {
    try {
      const entries = await kbService.tree();
      tree = buildTree(entries as TreeEntry[]);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
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
  // state so a failure surfaces in-place rather than being swallowed.
  async function runDialogOperation(operation: () => Promise<void>): Promise<void> {
    if (dialog.kind === 'none') return;
    patchDialog({ busy: true, error: null });
    try {
      await operation();
      await refreshTree();
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
          await kbService.deleteNote(action.path);
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
          await kbService.moveNote(action.path, target);
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
        await kbService.moveNote(action.path, target);
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
          await kbService.deleteFolder(action.path);
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
          await kbService.moveFolder(action.path, target);
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
        await kbService.moveFolder(action.path, target);
        appState.favoritesOnFolderRenamed(vaultId, action.path, target);
      },
    };
  }

  function openVaultDialog(action: Extract<LocalTreeAction, { kind: 'vault' }>): void {
    if (action.action === 'new-note') {
      openNewNoteDialog('');
      return;
    }
    if (action.action === 'new-folder') {
      openNewFolderDialog('');
      return;
    }
    if (action.action === 'rename') {
      // The local vault has no rename endpoint — its display name is the
      // on-disk root folder's basename, which the daemon does not expose
      // for mutation. Surface that clearly rather than silently failing.
      dialog = {
        kind: 'confirm',
        title: 'Rename vault',
        description:
          'Renaming the vault is not supported from the web UI yet. Rename the vault folder on disk instead.',
        confirmLabel: 'OK',
        destructive: false,
        busy: false,
        error: null,
        run: async () => undefined,
      };
      return;
    }
    // delete
    dialog = {
      kind: 'confirm',
      title: 'Delete vault',
      description:
        'Deleting the whole vault is not supported from the web UI. Remove the vault folder on disk instead.',
      confirmLabel: 'OK',
      destructive: false,
      busy: false,
      error: null,
      run: async () => undefined,
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
        await kbService.createNote(target);
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
        await kbService.createFolder(target);
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
    hiddenVaultIds = snapshot.hiddenVaultIds;
    secondaryRailWidth = snapshot.secondaryRailWidth;
    favorites = snapshot.favorites;
    return appState.subscribe((s) => {
      expandedFolderIds = s.expandedFolderIds;
      collapsedVaultIds = s.collapsedVaultIds;
      hiddenVaultIds = s.hiddenVaultIds;
      secondaryRailWidth = s.secondaryRailWidth;
      favorites = s.favorites;
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

  afterNavigate((navigation) => {
    if (!mounted || !navigation.to?.url) return;
    const nextPath = documentPathFromUrl(navigation.to.url);
    if (nextPath === documentPath) return;
    rebindDocument(nextPath);
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
  colorModeChoice={colorModePref}
  {activeNav}
  {tree}
  {vaults}
  {hiddenVaultIds}
  {secondaryRailWidth}
  {expandedFolderIds}
  {expandedVaultIds}
  {favoritedFolderPaths}
  {favoritedNotePaths}
  starredFolders={starredView.folders}
  starredNotes={starredView.notes}
  onSelectNav={(id) => {
    activeNav = id;
  }}
  onToggleVaultHidden={toggleVaultHidden}
  onResizeRail={resizeRail}
  onUnstar={unstar}
  onToggleColorMode={toggleColorMode}
  onToggleFolder={toggleFolder}
  onToggleVault={toggleVault}
  onOpenFile={(path) => {
    void openDocument(path);
  }}
  onTreeAction={handleTreeAction}
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
{/if}

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
