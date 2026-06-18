<script lang="ts">
  import FilesPanel from './FilesPanel.svelte';
  import StarredPanel from './StarredPanel.svelte';
  import DocumentHeader from './DocumentHeader.svelte';
  import RailResizeHandle from './RailResizeHandle.svelte';
  import PrimaryRail, { type RailNavId } from './primary-rail/PrimaryRail.svelte';
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
    daemonLabel: string;
    daemonStatus?: 'open' | 'connecting' | 'closed' | 'error';
    documentPath: string;
    /** Document-header breadcrumb trail. App-built from the active path so
        the package stays free of path-parsing policy (prop-driven, matching
        the reference header). */
    breadcrumbItems: BreadcrumbItem[];
    /** Live save/connection chip label. Omit to hide the chip. */
    statusLabel?: string;
    /** Whether the active document is favorited — drives the header's
        favorite toggle. */
    documentFavorited?: boolean;
    /** Toggle the active document's favorite state. */
    onToggleDocumentFavorite?: () => void;
    /** Rename the active document (header overflow menu). Omit to hide. */
    onRenameDocument?: () => void;
    /** Move the active document (header overflow menu). Omit to hide. */
    onMoveDocument?: () => void;
    /** Delete the active document (header overflow menu). Omit to hide. */
    onDeleteDocument?: () => void;
    /** Persisted color-mode preference (light / dark / system). Drives the
        rail toggle's icon. */
    colorModeChoice?: 'light' | 'dark' | 'system';
    /** Which secondary panel is shown — the files tree or the starred view. */
    activeNav?: RailNavId;
    /** Starred folder rows for the starred view. App-built, prop-driven. */
    starredFolders?: StarredRowData[];
    /** Starred note rows for the starred view. App-built, prop-driven. */
    starredNotes?: StarredRowData[];
    /** Set of starred folder paths — drives the tree menus' Favorite item. */
    favoritedFolderPaths?: Set<string>;
    /** Set of starred note paths — drives the tree menus' Favorite item. */
    favoritedNotePaths?: Set<string>;
    userLabel?: string;
    /** Wordmark beside the rail's brand mark. App-supplied so the package
        stays product-agnostic. */
    brandLabel?: string;
    /** Whether the primary icon rail is collapsed to icon-only width.
        App-owned + persisted. */
    railCollapsed?: boolean;
    tree?: LocalTreeNode[];
    /** The vaults the rail groups by, each with its own tree. Omit for the
        single-vault default (synthesized from vaultName/vaultId/tree). */
    vaultGroups?: VaultGroupData[];
    /** Which vault owns the active document path. Scopes the active-row
        highlight to that vault's group when more than one is shown. */
    activeVaultIdForPath?: string;
    /** Full set of vaults the filter lists. Omit to derive from the groups. */
    vaults?: VaultFilterEntry[];
    /** Deny-list of vault ids the user has hidden. App-owned, persisted. */
    hiddenVaultIds?: string[];
    /** Secondary (files) rail width in px. Applied as `--rd-mid-w`. */
    secondaryRailWidth?: number;
    /** Active folder row key when a folder is the active canvas. */
    activeFolderId?: string;
    /** Active vault key when the vault root is the active canvas. */
    activeVaultId?: string;
    /** Allow-list of expanded folder keys (`folder:<vaultId>:<path>`). */
    expandedFolderIds?: Set<string>;
    /** Set of expanded vault keys. Omit to render the vault open. */
    expandedVaultIds?: Set<string>;
    /** When true (mobile), tree-row kebab buttons are always visible. When
        false (desktop), they appear on hover / focus only. */
    kebabAlwaysVisible?: boolean;
    onSelectNav?: (id: RailNavId) => void;
    onToggleColorMode?: () => void;
    /** Toggle the primary rail's collapsed state. App owns persistence. */
    onToggleRailCollapsed?: () => void;
    onToggleFolder?: (key: string) => void;
    onToggleVault?: (key: string) => void;
    onOpenFile?: (path: string) => void;
    /** Navigate to a folder (three-state row click's open branch). */
    onOpenFolder?: (key: string) => void;
    /** Navigate to the vault root. */
    onOpenVault?: (key: string) => void;
    onTreeAction?: (action: LocalTreeAction) => void;
    /** Add/remove a vault id from the hide-list. */
    onToggleVaultHidden?: (vaultId: string) => void;
    /** Create a new vault (files-rail footer). The host collects a name. */
    onNewVault?: () => void;
    /** Forward a raw (unclamped) rail width; the app-state setter clamps. */
    onResizeRail?: (next: number) => void;
    children?: import('svelte').Snippet;
  }

  let {
    vaultName,
    vaultId = vaultName,
    vaultAccent = 'slate',
    daemonLabel,
    daemonStatus = 'open',
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
    railCollapsed = false,
    tree,
    vaultGroups,
    activeVaultIdForPath,
    vaults,
    hiddenVaultIds = [],
    secondaryRailWidth = 282,
    activeFolderId,
    activeVaultId,
    expandedFolderIds = new Set<string>(),
    expandedVaultIds,
    kebabAlwaysVisible = false,
    onSelectNav,
    onToggleColorMode,
    onToggleRailCollapsed,
    onToggleFolder,
    onToggleVault,
    onOpenFile,
    onOpenFolder,
    onOpenVault,
    onTreeAction,
    onToggleVaultHidden,
    onNewVault,
    onResizeRail,
    children,
  }: Props = $props();
</script>

<main
  class="local-editor-shell"
  style="--rd-mid-w: {secondaryRailWidth}px"
>
  <PrimaryRail
    {activeNav}
    colorMode={colorModeChoice}
    {userLabel}
    {brandLabel}
    collapsed={railCollapsed}
    {onSelectNav}
    {onToggleColorMode}
    onToggleCollapsed={onToggleRailCollapsed}
  />

  {#if activeNav === 'starred'}
    <StarredPanel
      folders={starredFolders}
      notes={starredNotes}
      activePath={documentPath}
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
      {kebabAlwaysVisible}
      {onToggleFolder}
      {onToggleVault}
      {onOpenFile}
      {onOpenFolder}
      {onOpenVault}
      {onTreeAction}
      {onToggleVaultHidden}
      {onNewVault}
    />
  {/if}

  <!-- INTENTIONAL DEVIATION from the reference layout (user-requested):
       the reference seats the resize handle as a full-width flex sibling
       between the secondary panel and the workspace, which leaves a thin
       visible gap beside the panel. We zero the handle's flow width and
       overlay its 6px hit-area on the panel/workspace seam so the two
       regions abut with no visible gap — the handle stays fully
       functional (it still captures the drag at the seam). -->
  <div class="resize-handle-slot">
    <RailResizeHandle
      width={secondaryRailWidth}
      onResize={(next) => onResizeRail?.(next)}
    />
  </div>

  <section class="workspace" aria-label="Document workspace">
    <DocumentHeader
      {breadcrumbItems}
      {statusLabel}
      favorited={documentFavorited}
      onToggleFavorite={onToggleDocumentFavorite}
      onRename={onRenameDocument}
      onMove={onMoveDocument}
      onDelete={onDeleteDocument}
    />
    <div class="editor-region">
      {@render children?.()}
    </div>
  </section>
</main>

<style>
  /* Region layout: primary rail | secondary panel | resize handle |
     workspace, laid out as a flex row. The rail and the secondary panel
     each size themselves (the rail via its own `width` transition; the
     panel via `width: var(--rd-mid-w)` + `flex-shrink: 0`), the resize
     handle keeps its intrinsic 6px, and the workspace absorbs the
     remaining slack. No transition on the row itself — the rail animates
     its OWN width, so resize is instant and there are no gutter bands. */
  .local-editor-shell {
    position: relative;
    display: flex;
    width: 100%;
    height: 100vh;
    overflow: hidden;
    background: var(--rd-bg);
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
  }

  .workspace {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    background: var(--rd-panel);
  }

  /* INTENTIONAL DEVIATION (user-requested): the handle lives in a
     zero-width flex slot and its 6px hit-area is overlaid on the seam,
     so the secondary panel and the workspace abut with no visible gap.
     The slot takes no flow width; the handle straddles the boundary,
     centered on the seam, and stays draggable. */
  .resize-handle-slot {
    position: relative;
    width: 0;
    flex-shrink: 0;
    z-index: 2;
  }

  .resize-handle-slot :global(.handle) {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    height: 100%;
  }

  .editor-region {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
</style>
