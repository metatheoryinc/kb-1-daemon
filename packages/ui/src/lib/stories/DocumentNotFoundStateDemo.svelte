<script lang="ts">
  import DocumentNotFoundState from '../local-editor/DocumentNotFoundState.svelte';

  interface Props {
    path: string;
    mode?: 'light' | 'dark';
  }

  let { path, mode = 'light' }: Props = $props();
</script>

<div class:dark={mode === 'dark'} data-rd-mode={mode} class="preview">
  <div class="document-grid">
    <DocumentNotFoundState {path} />
  </div>
</div>

<style>
  .preview {
    min-height: 100vh;
    background: var(--rd-bg);
  }

  .document-grid {
    min-height: 100vh;
    display: grid;
    grid-template-columns: minmax(24px, 1fr) minmax(0, 760px) minmax(24px, 1fr);
  }
</style>
