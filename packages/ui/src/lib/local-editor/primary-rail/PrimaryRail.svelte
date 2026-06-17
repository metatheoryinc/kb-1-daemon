<script lang="ts" module>
  /** Navigation destinations the rail can switch between. The shell maps
      each id to a secondary panel (files tree vs. starred view). */
  export type RailNavId = 'files' | 'starred';
</script>

<script lang="ts">
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
    onSelectNav?: (id: RailNavId) => void;
    /** Cycles the color mode. Prop-driven — the app owns the actual
        preference + persistence. */
    onToggleColorMode?: () => void;
  }

  let {
    activeNav = 'files',
    colorMode = 'system',
    userLabel = 'Local user',
    onSelectNav,
    onToggleColorMode,
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

<aside class="rail" aria-label="Primary navigation">
  <div class="body">
    <nav class="nav" aria-label="Sections">
      <PrimaryRailItem
        icon="folder"
        label="Files"
        active={activeNav === 'files'}
        onclick={() => onSelectNav?.('files')}
      />
      <PrimaryRailItem
        icon="star"
        label="Starred"
        active={activeNav === 'starred'}
        onclick={() => onSelectNav?.('starred')}
      />
    </nav>

    <div class="spacer"></div>

    <PrimaryRailItem
      icon={colorModeIcon}
      label="Color mode: {colorModeLabel}"
      subtle
      onclick={onToggleColorMode}
    />

    <PrimaryRailUserChip label={userLabel} />
  </div>
</aside>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    width: var(--rd-rail-w-collapsed);
    height: 100%;
    overflow: hidden;
    background: var(--rd-panel-alt);
    border-right: 1px solid var(--rd-rule);
    font-family: var(--rd-ui);
    color: var(--rd-ink-1);
  }

  .body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 12px 10px 14px;
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
