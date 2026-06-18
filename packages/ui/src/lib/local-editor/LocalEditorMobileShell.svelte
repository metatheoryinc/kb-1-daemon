<script lang="ts">
  /**
   * Mobile shell for the local editor. Sibling of `LocalEditorShell`
   * (the desktop shell) — same data wiring, but with mobile chrome: a
   * full-screen left-nav flyout that holds the primary rail + the
   * files/starred secondary panel. The canvas (document or folder view)
   * is the main view; the flyout is the navigation surface.
   *
   * The rail stays collapsed inside the flyout because mobile space is
   * precious; the persisted `railCollapsed` pref is intentionally
   * ignored here. Structure + chrome are ported from the reference
   * mobile layout, narrowed to the local editor's panels (no presence,
   * inspector, org, people, or agents — those are not part of the local
   * daemon UI).
   */
  import FilesPanel from './FilesPanel.svelte';
  import StarredPanel from './StarredPanel.svelte';
  import DocumentHeader from './DocumentHeader.svelte';
  import PrimaryRail, { type RailNavId } from './primary-rail/PrimaryRail.svelte';
  import Icon from '../primitives/Icon.svelte';
  import type { AccentName } from '../primitives/accent';
  import type { BreadcrumbItem } from '../primitives/Breadcrumb.svelte';
  import type {
    LocalTreeAction,
    LocalTreeNode,
    StarredRowData,
    VaultFilterEntry,
    VaultGroupData,
  } from './types';

  interface Props {
    vaultName: string;
    /** Stable vault id seeding the tree's expansion keys. */
    vaultId?: string;
    /** Accent for the vault group's folder token. */
    vaultAccent?: AccentName;
    documentPath: string;
    /** Document-header breadcrumb trail. App-built, prop-driven. */
    breadcrumbItems: BreadcrumbItem[];
    /** Live save/connection chip label. Omit to hide the chip. */
    statusLabel?: string;
    /** Whether the active document is favorited. */
    documentFavorited?: boolean;
    onToggleDocumentFavorite?: () => void;
    onRenameDocument?: () => void;
    onMoveDocument?: () => void;
    onDeleteDocument?: () => void;
    /** Persisted color-mode preference. Drives the rail toggle's icon. */
    colorModeChoice?: 'light' | 'dark' | 'system';
    /** Which secondary panel is shown — the files tree or starred view. */
    activeNav?: RailNavId;
    starredFolders?: StarredRowData[];
    starredNotes?: StarredRowData[];
    favoritedFolderPaths?: Set<string>;
    favoritedNotePaths?: Set<string>;
    userLabel?: string;
    brandLabel?: string;
    tree?: LocalTreeNode[];
    vaultGroups?: VaultGroupData[];
    activeVaultIdForPath?: string;
    vaults?: VaultFilterEntry[];
    hiddenVaultIds?: string[];
    activeFolderId?: string;
    activeVaultId?: string;
    expandedFolderIds?: Set<string>;
    expandedVaultIds?: Set<string>;
    onSelectNav?: (id: RailNavId) => void;
    onToggleColorMode?: () => void;
    onToggleFolder?: (key: string) => void;
    onToggleVault?: (key: string) => void;
    onOpenFile?: (path: string) => void;
    onOpenFolder?: (key: string) => void;
    onOpenVault?: (key: string) => void;
    onTreeAction?: (action: LocalTreeAction) => void;
    onToggleVaultHidden?: (vaultId: string) => void;
    /** Create a new vault (files-rail footer). The host collects a name. */
    onNewVault?: () => void;
    /** Open/closed state of the left-nav flyout. Bindable so the app can
        hoist it and close it on canvas-side navigation. */
    navOpen?: boolean;
    children?: import('svelte').Snippet;
  }

  let {
    vaultName,
    vaultId = vaultName,
    vaultAccent = 'slate',
    documentPath,
    breadcrumbItems,
    statusLabel,
    documentFavorited = false,
    onToggleDocumentFavorite,
    onRenameDocument,
    onMoveDocument,
    onDeleteDocument,
    colorModeChoice = 'system',
    activeNav = 'files',
    starredFolders = [],
    starredNotes = [],
    favoritedFolderPaths,
    favoritedNotePaths,
    userLabel = 'Local user',
    brandLabel = 'Notes',
    tree,
    vaultGroups,
    activeVaultIdForPath,
    vaults,
    hiddenVaultIds = [],
    activeFolderId,
    activeVaultId,
    expandedFolderIds = new Set<string>(),
    expandedVaultIds,
    onSelectNav,
    onToggleColorMode,
    onToggleFolder,
    onToggleVault,
    onOpenFile,
    onOpenFolder,
    onOpenVault,
    onTreeAction,
    onToggleVaultHidden,
    onNewVault,
    navOpen = $bindable(false),
    children,
  }: Props = $props();

  // Mobile menu IA: the flyout is the navigation surface and contains
  // a primary rail (mode) + a secondary panel (files tree / starred).
  // It closes only on a TERMINAL selection — picking the actual thing
  // the user is going to view in the canvas. Mode switches, folder
  // expand/collapse/route, and tree-management actions are all "still
  // navigating / still managing" inside the flyout.
  //
  // Terminal (close the flyout):
  //   - File row click          → canvas is now showing the picked note
  //   - Vault header click       → vault canvas is the terminal target
  //   - Starred row pick         → canvas navigates to the target
  // Continuing-in-flyout (DO NOT close):
  //   - Folder row click         → routes to the folder canvas, but the
  //                                user is still drilling toward a file
  //   - Primary rail switch      → mode swap inside the flyout
  const onOpenFileRow = (path: string) => {
    onOpenFile?.(path);
    navOpen = false;
  };
  const onOpenFolderRow = (key: string) => {
    // Folder click is mode-internal navigation, not terminal.
    onOpenFolder?.(key);
  };
  const onOpenVaultRow = (key: string) => {
    onOpenVault?.(key);
    navOpen = false;
  };
</script>

<div class="vault-mobile">
  {#snippet hamburger()}
    <button
      type="button"
      class="hamburger"
      title="Open navigation"
      aria-label="Open navigation"
      aria-expanded={navOpen}
      onclick={() => (navOpen = true)}
    >
      <Icon name="menu" size={20} />
    </button>
  {/snippet}

  <main class="canvas">
    <header class="topbar">
      {@render hamburger()}
      <DocumentHeader
        {breadcrumbItems}
        {statusLabel}
        favorited={documentFavorited}
        onToggleFavorite={onToggleDocumentFavorite}
        onRename={onRenameDocument}
        onMove={onMoveDocument}
        onDelete={onDeleteDocument}
      />
    </header>

    <div class="editor-region">
      {@render children?.()}
    </div>
  </main>

  <div class="flyout left" class:open={navOpen} aria-hidden={!navOpen}>
    <button
      type="button"
      class="backdrop"
      aria-label="Close navigation"
      tabindex={navOpen ? 0 : -1}
      onclick={() => (navOpen = false)}
    ></button>
    <div class="flyout-panel left-panel">
      <PrimaryRail
        collapsed
        {activeNav}
        colorMode={colorModeChoice}
        {userLabel}
        {brandLabel}
        onSelectNav={(id) => {
          // Primary rail clicks DO NOT close the flyout. The mobile
          // mental model is: rail = "what mode am I in?", secondary
          // panel = "what specifically am I picking?". Terminal
          // selections (tree row, starred row) close the flyout —
          // those are wired separately below.
          onSelectNav?.(id);
        }}
        {onToggleColorMode}
      />
      <div class="tree-host">
        {#if activeNav === 'starred'}
          <StarredPanel
            folders={starredFolders}
            notes={starredNotes}
            activePath={documentPath}
            onPick={() => (navOpen = false)}
          />
        {:else}
          <FilesPanel
            {vaultName}
            {vaultId}
            {vaultAccent}
            {vaultGroups}
            {vaults}
            {hiddenVaultIds}
            {tree}
            activePath={documentPath}
            {activeVaultIdForPath}
            {activeFolderId}
            {activeVaultId}
            {expandedFolderIds}
            {expandedVaultIds}
            {favoritedFolderPaths}
            {favoritedNotePaths}
            kebabAlwaysVisible
            onOpenFile={onOpenFileRow}
            onOpenFolder={onOpenFolderRow}
            onOpenVault={onOpenVaultRow}
            {onToggleFolder}
            {onToggleVault}
            {onTreeAction}
            {onToggleVaultHidden}
            {onNewVault}
          />
        {/if}
      </div>
      <button
        type="button"
        class="flyout-close"
        title="Close navigation"
        aria-label="Close navigation"
        onclick={() => (navOpen = false)}
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  </div>
</div>

<style>
  .vault-mobile {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100vh;
    overflow: hidden;
    background: var(--rd-bg);
    color: var(--rd-ink-1);
    font-family: var(--rd-ui);
  }

  .hamburger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    margin-left: -10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--rd-ink-1);
    cursor: pointer;
    transition: background 80ms ease;
  }

  .hamburger:hover { background: var(--rd-hover); }
  .hamburger:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--rd-ink-3) 40%, transparent);
    outline-offset: -2px;
  }

  .canvas {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--rd-panel);
  }

  /* Compact topbar holding the hamburger + the document header so the
     hamburger always has a place to live above the canvas. */
  .topbar {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    padding: 0 8px 0 16px;
    gap: 4px;
    border-bottom: 1px solid var(--rd-rule);
    background: var(--rd-panel);
  }

  /* The document header fills the rest of the topbar row; it owns its
     own bottom border on desktop, so suppress it here — the topbar
     supplies the rule. */
  .topbar :global(.document-header) {
    flex: 1;
    min-width: 0;
    border-bottom: none;
  }

  .editor-region {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .flyout {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 10;
  }
  .flyout.open { pointer-events: auto; }

  .backdrop {
    position: absolute;
    inset: 0;
    border: none;
    padding: 0;
    background: rgb(0 0 0 / 0.4);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.24s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .flyout.open .backdrop { opacity: 1; }

  .flyout-panel {
    position: absolute;
    top: 0;
    height: 100%;
    background: var(--rd-panel);
    box-shadow: 0 0 24px rgb(0 0 0 / 0.18);
    transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
  }

  .left-panel { left: 0; width: 100%; transform: translateX(-100%); }

  .flyout.left.open .left-panel { transform: translateX(0); }

  .tree-host { flex: 1; min-width: 0; display: flex; }

  .flyout-close {
    position: absolute;
    top: 8px;
    right: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--rd-ink-2);
    cursor: pointer;
    transition: background 80ms ease;
  }
  .flyout-close:hover { background: var(--rd-hover); }
  .flyout-close:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--rd-ink-3) 40%, transparent);
    outline-offset: 1px;
  }

  /* Every secondary panel lands inside .tree-host. On desktop each has
     a fixed `--rd-mid-w` width that's the middle column's role. In the
     mobile flyout there's no third column to its right — the secondary
     panel IS the right side of the menu — so it should take all
     remaining flyout-panel width after the collapsed primary rail. */
  .tree-host :global(.files-panel),
  .tree-host :global(.starred-panel) {
    width: 100%;
  }
</style>
