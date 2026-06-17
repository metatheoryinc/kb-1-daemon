<script lang="ts">
  import { Button, ConfirmDialog } from '../index';

  interface Props {
    mode?: 'light' | 'dark';
    destructive?: boolean;
    error?: string | null;
  }

  let { mode = 'light', destructive = true, error = null }: Props = $props();

  let open = $state(true);
</script>

<div class:dark={mode === 'dark'} data-rd-mode={mode} class="preview">
  <div class="story-pad">
    <Button onclick={() => (open = true)}>Open dialog</Button>
  </div>

  <ConfirmDialog
    {open}
    title="Delete note"
    description="Delete “meeting-notes.md”? This moves it to the trash."
    confirmLabel="Delete"
    {destructive}
    {error}
    onconfirm={() => (open = false)}
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
</style>
