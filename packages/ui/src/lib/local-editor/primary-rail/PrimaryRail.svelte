<script lang="ts" module>
  /** Navigation destinations the rail can switch between. The shell maps
      each id to a secondary panel (files tree vs. starred view). */
  export type RailNavId = 'files' | 'starred';
</script>

<script lang="ts">
  import BrandMark from '../../primitives/BrandMark.svelte';
  import PrimaryRailItem from './PrimaryRailItem.svelte';
  import PrimaryRailUserChip from './PrimaryRailUserChip.svelte';
  import type { IconName } from '../../primitives/types';

  interface Props {
    /** Which nav destination is active. Drives the highlighted item and,
        via the shell, which secondary panel renders. */
    activeNav?: RailNavId;
    /** Resolved color-mode value. Drives the toggle's icon: light → sun,
        dark → moon, anything else → desktop (system). */
    colorMode?: 'light' | 'dark' | 'system';
    /** Label under the local identity chip. Static display only. */
    userLabel?: string;
    /** Wordmark text beside the brand mark in the identity row. Fades out
        when collapsed. App-supplied so the package stays product-agnostic. */
    brandLabel?: string;
    /** When true, the rail is icon-only at the collapsed width; labels and
        the brand text fade out. App-owned + persisted; prop-driven here. */
    collapsed?: boolean;
    onSelectNav?: (id: RailNavId) => void;
    /** Cycles the color mode. Prop-driven — the app owns the actual
        preference + persistence. */
    onToggleColorMode?: () => void;
    /** Toggles the rail's collapsed state. Prop-driven — the app owns the
        persisted `railCollapsed` flag; the brand mark is the hit target. */
    onToggleCollapsed?: () => void;
  }

  let {
    activeNav = 'files',
    colorMode = 'system',
    userLabel = 'Local user',
    brandLabel = 'Notes',
    collapsed = false,
    onSelectNav,
    onToggleColorMode,
    onToggleCollapsed,
  }: Props = $props();

  const colorModeIcon = $derived<IconName>(
    colorMode === 'light' ? 'sun' : colorMode === 'dark' ? 'moon' : 'desktop',
  );
  const colorModeLabel = $derived(
    colorMode === 'light'
      ? 'Light'
      : colorMode === 'dark'
        ? 'Dark'
        : 'System',
  );
</script>

<aside class="rail" class:collapsed aria-label="Primary navigation">
  <button
    type="button"
    class="identity"
    class:collapsed
    title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    aria-expanded={!collapsed}
    onclick={onToggleCollapsed}
  >
    <BrandMark />
    <span class="brand">{brandLabel}</span>
  </button>

  <div class="body">
    <nav class="nav" aria-label="Sections">
      <PrimaryRailItem
        icon="folder"
        label="Files"
        active={activeNav === 'files'}
        {collapsed}
        onclick={() => onSelectNav?.('files')}
      />
      <PrimaryRailItem
        icon="star"
        label="Starred"
        active={activeNav === 'starred'}
        {collapsed}
        onclick={() => onSelectNav?.('starred')}
      />
    </nav>

    <div class="spacer"></div>

    <PrimaryRailItem
      icon={colorModeIcon}
      label={colorModeLabel}
      subtle
      {collapsed}
      onclick={onToggleColorMode}
    />

    <PrimaryRailUserChip label={userLabel} {collapsed} />
  </div>
</aside>

<style>
  .rail {
    position: relative;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    width: var(--rd-rail-w);
    height: 100%;
    overflow: hidden;
    background: var(--rd-panel-alt);
    border-right: 1px solid var(--rd-rule);
    font-family: var(--rd-ui);
    color: var(--rd-ink-1);
    --rd-rail-ease: cubic-bezier(0.4, 0, 0.2, 1);
    --rd-rail-duration: 0.32s;
    transition: width var(--rd-rail-duration) var(--rd-rail-ease);
  }

  .rail.collapsed {
    width: var(--rd-rail-w-collapsed);
  }

  /* The identity row is the toggle hit target — it spans the full width and
     full top of the rail (no padding above or beside it) so clicking
     anywhere in the header section toggles the rail. */
  .identity {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    width: 100%;
    /* Padding tuned so the 28px mark lands at the rail's center when
       collapsed (rail-w 64, padding-left 18, mark half 14 → 32 = center). */
    padding: 16px 18px 14px;
    border: none;
    border-bottom: 1px solid var(--rd-rule);
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: gap var(--rd-rail-duration) var(--rd-rail-ease);
  }

  .identity:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--rd-ink-3) 40%, transparent);
    outline-offset: -2px;
  }

  .identity.collapsed {
    gap: 0;
  }

  .brand {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.15;
    white-space: nowrap;
    opacity: 1;
    transition: opacity var(--rd-rail-duration) var(--rd-rail-ease);
  }

  .rail.collapsed .brand {
    opacity: 0;
    pointer-events: none;
  }

  /* The padded content area below the identity. Padding-x is constant so
     the children's icons line up at the rail's horizontal center when
     collapsed without anything having to transition padding. */
  .body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 8px 10px 14px;
    gap: 4px;
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .spacer {
    flex: 1;
  }
</style>
