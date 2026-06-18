<script lang="ts">
  import { EmptyVaultsState } from '../index';

  interface Props {
    mode?: 'light' | 'dark';
  }

  let { mode = 'light' }: Props = $props();

  let created = $state(0);
</script>

<div class:dark={mode === 'dark'} data-rd-mode={mode} class="preview">
  <EmptyVaultsState onCreateVault={() => (created += 1)} />
  {#if created > 0}
    <p class="result">Create clicked {created}×</p>
  {/if}
</div>

<style>
  .preview {
    position: relative;
    min-height: 100vh;
    background: var(--rd-bg);
  }

  .result {
    position: absolute;
    bottom: 16px;
    left: 16px;
    margin: 0;
    font-family: var(--rd-ui);
    font-size: 13px;
    color: var(--rd-ink-3);
  }
</style>
