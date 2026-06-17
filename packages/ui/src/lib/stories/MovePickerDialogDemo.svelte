<script lang="ts">
  import { Button, MovePickerDialog } from '../index';

  interface Props {
    mode?: 'light' | 'dark';
    error?: string | null;
  }

  let { mode = 'light', error = null }: Props = $props();

  let open = $state(true);
  let lastTarget = $state<string | null>(null);

  const folderPaths = [
    'projects',
    'projects/active',
    'projects/archive',
    'journal',
    'references',
  ];
</script>

<div class:dark={mode === 'dark'} data-rd-mode={mode} class="preview">
  <div class="story-pad">
    <Button onclick={() => (open = true)}>Open dialog</Button>
    {#if lastTarget !== null}
      <p class="result">Move to: {lastTarget === '' ? 'Vault root' : lastTarget}</p>
    {/if}
  </div>

  <MovePickerDialog
    {open}
    title="Move note"
    description="Choose a destination folder for “draft.md”."
    {folderPaths}
    currentParent="projects"
    {error}
    onsubmit={(target) => {
      lastTarget = target;
      open = false;
    }}
    oncancel={() => (open = false)}
  />
</div>

<style>
  .preview {
    min-height: 100vh;
    background: var(--rd-bg);
  }

  .story-pad {
    padding: 32px;
  }

  .result {
    margin-top: 12px;
    font-family: var(--rd-ui);
    font-size: 13px;
    color: var(--rd-ink-3);
  }
</style>
