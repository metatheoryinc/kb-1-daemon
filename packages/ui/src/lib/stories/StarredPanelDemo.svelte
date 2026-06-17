<script lang="ts">
  import StarredPanel from '../local-editor/StarredPanel.svelte';
  import type { StarredRowData } from '../local-editor/types';

  interface Props {
    folders?: StarredRowData[];
    notes?: StarredRowData[];
    activePath?: string;
    mode?: 'light' | 'dark';
  }

  let { folders = [], notes = [], activePath = '', mode = 'light' }: Props = $props();
</script>

<div class:dark={mode === 'dark'} data-rd-mode={mode} class="preview">
  <div class="panel-host">
    <StarredPanel {folders} {notes} {activePath} />
  </div>
</div>

<style>
  .preview {
    min-height: 100vh;
    padding: 24px;
    background: var(--rd-bg);
  }

  .panel-host {
    width: 300px;
    height: 520px;
    border: 1px solid var(--rd-rule);
    border-radius: 10px;
    overflow: hidden;
  }
</style>
