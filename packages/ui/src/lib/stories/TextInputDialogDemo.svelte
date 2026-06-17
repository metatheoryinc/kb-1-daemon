<script lang="ts">
  import { Button, TextInputDialog } from '../index';
  import type { DialogField } from '../index';

  interface Props {
    mode?: 'light' | 'dark';
    title?: string;
    submitLabel?: string;
    fields?: DialogField[];
    error?: string | null;
  }

  let {
    mode = 'light',
    title = 'New note',
    submitLabel = 'Create',
    fields = [{ type: 'text', label: 'Name', placeholder: 'untitled', required: true }],
    error = null,
  }: Props = $props();

  let open = $state(true);
  let lastSubmit = $state<string[] | null>(null);
</script>

<div class:dark={mode === 'dark'} data-rd-mode={mode} class="preview">
  <div class="story-pad">
    <Button onclick={() => (open = true)}>Open dialog</Button>
    {#if lastSubmit}
      <p class="result">Submitted: {lastSubmit.join(', ')}</p>
    {/if}
  </div>

  <TextInputDialog
    {open}
    {title}
    description="Fixture-backed dialog with no daemon dependency."
    {fields}
    {submitLabel}
    {error}
    onsubmit={(values) => {
      lastSubmit = values;
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
