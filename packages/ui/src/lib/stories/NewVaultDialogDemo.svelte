<script lang="ts">
  import { Button, NewVaultDialog } from '../index';
  import type { NewVaultSubmit } from '../index';

  interface Props {
    mode?: 'light' | 'dark';
    error?: string | null;
    busy?: boolean;
  }

  let { mode = 'light', error = null, busy = false }: Props = $props();

  let open = $state(true);
  let lastSubmit = $state<NewVaultSubmit | null>(null);
</script>

<div class:dark={mode === 'dark'} data-rd-mode={mode} class="preview">
  <div class="story-pad">
    <Button onclick={() => (open = true)}>Open dialog</Button>
    {#if lastSubmit}
      <p class="result">
        Submitted: name “{lastSubmit.displayName}”, slug “{lastSubmit.slug}”
      </p>
    {/if}
  </div>

  <NewVaultDialog
    {open}
    {error}
    {busy}
    onsubmit={(value) => {
      lastSubmit = value;
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
