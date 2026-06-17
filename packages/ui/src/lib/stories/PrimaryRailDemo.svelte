<script lang="ts">
  import { untrack } from 'svelte';
  import PrimaryRail, { type RailNavId } from '../local-editor/primary-rail/PrimaryRail.svelte';

  interface Props {
    mode?: 'light' | 'dark';
    colorMode?: 'light' | 'dark' | 'system';
    activeNav?: RailNavId;
    collapsed?: boolean;
  }

  let {
    mode = 'light',
    colorMode = 'system',
    activeNav = 'files',
    collapsed = false,
  }: Props = $props();

  // Local cycle so the toggle is interactive in the story without a store.
  const cycle = (m: 'light' | 'dark' | 'system'): 'light' | 'dark' | 'system' =>
    m === 'light' ? 'dark' : m === 'dark' ? 'system' : 'light';

  // Seed once from args; Storybook remounts the component when args change,
  // so a plain initializer keeps the toggle and nav interactive in-story.
  let nav = $state<RailNavId>(untrack(() => activeNav));
  let mode_ = $state<'light' | 'dark' | 'system'>(untrack(() => colorMode));
  let collapsed_ = $state<boolean>(untrack(() => collapsed));
</script>

<div class:dark={mode === 'dark'} data-rd-mode={mode} class="preview">
  <PrimaryRail
    activeNav={nav}
    colorMode={mode_}
    collapsed={collapsed_}
    onSelectNav={(id) => {
      nav = id;
    }}
    onToggleColorMode={() => {
      mode_ = cycle(mode_);
    }}
    onToggleCollapsed={() => {
      collapsed_ = !collapsed_;
    }}
  />
</div>

<style>
  .preview {
    display: flex;
    min-height: 100vh;
    background: var(--rd-bg);
  }
</style>
