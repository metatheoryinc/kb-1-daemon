<script lang="ts">
  import FilesPanel from './FilesPanel.svelte';
  import StarredPanel from './StarredPanel.svelte';
  import DocumentHeader from './DocumentHeader.svelte';
  import RailResizeHandle from './RailResizeHandle.svelte';
  import PrimaryRail, { type RailNavId } from './primary-rail/PrimaryRail.svelte';
  import type { AccentName } from '../primitives/accent';
  import type { LocalTreeAction, LocalTreeNode, VaultFilterEntry } from './types';

  interface Props {
    vaultName: string;
    /** Stable vault id seeding the tree's expansion keys. */
    vaultId?: string;
    /** Accent for the vault group's folder token. */
    vaultAccent?: AccentName;
    daemonLabel: string;
    daemonStatus?: 'open' | 'connecting' | 'closed' | 'error';
    documentPath: string;
    colorMode?: 'light' | 'dark';
    /** Persisted color-mode preference (light / dark / system). Drives the
        rail toggle's icon; the resolved `colorMode` above drives surfaces
        that need a concrete light-or-dark value. */
    colorModeChoice?: 'light' | 'dark' | 'system';
    /** Which secondary panel is shown — the files tree or the starred view. */
    activeNav?: RailNavId;
    userLabel?: string;
    tree: LocalTreeNode[];
    /** Full set of vaults the filter lists. Omit for the single-vault default. */
    vaults?: VaultFilterEntry[];
    /** Deny-list of vault ids the user has hidden. App-owned, persisted. */
    hiddenVaultIds?: string[];
    /** Secondary (files) rail width in px. Applied as `--rd-mid-w`. */
    secondaryRailWidth?: number;
    /** Allow-list of expanded folder keys (`folder:<vaultId>:<path>`). */
    expandedFolderIds?: Set<string>;
    /** Set of expanded vault keys. Omit to render the vault open. */
    expandedVaultIds?: Set<string>;
    onSelectNav?: (id: RailNavId) => void;
    onToggleColorMode?: () => void;
    onToggleFolder?: (key: string) => void;
    onToggleVault?: (key: string) => void;
    onOpenFile?: (path: string) => void;
    onTreeAction?: (action: LocalTreeAction) => void;
    /** Add/remove a vault id from the hide-list. */
    onToggleVaultHidden?: (vaultId: string) => void;
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
    colorMode = 'light',
    colorModeChoice = 'system',
    activeNav = 'files',
    userLabel = 'Local user',
    tree,
    vaults,
    hiddenVaultIds = [],
    secondaryRailWidth = 282,
    expandedFolderIds = new Set<string>(),
    expandedVaultIds,
    onSelectNav,
    onToggleColorMode,
    onToggleFolder,
    onToggleVault,
    onOpenFile,
    onTreeAction,
    onToggleVaultHidden,
    onResizeRail,
    children,
  }: Props = $props();
</script>

<main class="local-editor-shell" style="--rd-mid-w: {secondaryRailWidth}px">
  <PrimaryRail
    {activeNav}
    colorMode={colorModeChoice}
    {userLabel}
    {onSelectNav}
    {onToggleColorMode}
  />

  {#if activeNav === 'starred'}
    <StarredPanel />
  {:else}
    <FilesPanel
      {vaultName}
      {vaultId}
      {vaultAccent}
      {vaults}
      {hiddenVaultIds}
      {tree}
      activePath={documentPath}
      {expandedFolderIds}
      {expandedVaultIds}
      {onToggleFolder}
      {onToggleVault}
      {onOpenFile}
      {onTreeAction}
      {onToggleVaultHidden}
    />
  {/if}

  <RailResizeHandle
    width={secondaryRailWidth}
    onResize={(next) => onResizeRail?.(next)}
  />

  <section class="workspace" aria-label="Document workspace">
    <DocumentHeader {vaultName} path={documentPath} />
    <div class="editor-region">
      {@render children?.()}
    </div>
  </section>
</main>

<style>
  .local-editor-shell {
    display: grid;
    /* The middle (files) rail is driven by `--rd-mid-w` so the resize
       handle's app-state width applies directly; the handle column is
       its intrinsic 6px, and the editor pane absorbs the remaining
       slack. `--rd-mid-w` defaults to the design width when no app sets
       it (e.g. Storybook fixtures). */
    grid-template-columns: var(--rd-rail-w-collapsed) var(--rd-mid-w, 282px) auto minmax(0, 1fr);
    /* Single bounded row pinned to the viewport. Without an explicit
       row track the implicit row is `auto`-sized and grows to the
       editor's content height (a long note is 20k+ px tall), which
       cascades down the workspace/editor-region chain and lets the
       editor spill past the viewport instead of scrolling internally.
       `minmax(0, 1fr)` over a definite `height: 100vh` keeps every
       child bounded to the shell so the CM6 scroller owns the scroll. */
    grid-template-rows: minmax(0, 1fr);
    width: 100%;
    height: 100vh;
    background: var(--rd-bg);
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
    overflow: hidden;
  }

  .workspace {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    /* min-height:0 lets this grid item shrink below its content height
       so the `1fr` editor row resolves against the bounded shell row
       rather than the editor's intrinsic content height. */
    min-height: 0;
    height: 100%;
  }

  .editor-region {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  @media (max-width: 760px) {
    .local-editor-shell {
      grid-template-columns: var(--rd-rail-w-collapsed) minmax(176px, 42vw) auto minmax(0, 1fr);
    }
  }
</style>
