<script lang="ts">
  import StarredRow from '../local-editor/StarredRow.svelte';
  import type { AccentName } from '../primitives/accent';

  interface Props {
    label?: string;
    meta?: string;
    kind?: 'note' | 'folder';
    accent?: AccentName;
    colorHex?: string | null;
    icon?: string | null;
    href?: string;
    available?: boolean;
    active?: boolean;
    mode?: 'light' | 'dark';
  }

  let {
    label = 'launch-notes.md',
    meta = 'in Demo Vault',
    kind = 'note',
    accent = 'coral',
    colorHex = '#ee8a91',
    icon = null,
    href = '/projects/active/launch-notes.md',
    available = true,
    active = false,
    mode = 'light',
  }: Props = $props();
</script>

<div class:dark={mode === 'dark'} data-rd-mode={mode} class="preview">
  <div class="row-host">
    <StarredRow {label} {meta} {kind} {accent} {colorHex} {icon} {href} {available} {active} />
  </div>
</div>

<style>
  .preview {
    min-height: 100vh;
    padding: 24px;
    background: var(--rd-bg);
  }

  .row-host {
    width: 280px;
    padding: 6px;
    background: var(--rd-panel);
    border: 1px solid var(--rd-rule);
    border-radius: 8px;
  }
</style>
