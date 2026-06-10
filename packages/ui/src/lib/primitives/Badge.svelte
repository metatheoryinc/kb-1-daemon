<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    tone?: 'neutral' | 'success' | 'danger' | 'live';
    children: Snippet;
  }

  let { tone = 'neutral', children }: Props = $props();
</script>

<span class="badge" class:success={tone === 'success'} class:danger={tone === 'danger'} class:live={tone === 'live'}>
  {@render children()}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    border-radius: 999px;
    background: var(--rd-panel-alt);
    color: var(--rd-ink-3);
    padding: 0 10px;
    font-family: var(--rd-ui);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }

  .success {
    background: color-mix(in srgb, var(--rd-live) 15%, var(--rd-panel));
    color: var(--rd-live-on);
  }

  .danger {
    background: color-mix(in srgb, var(--destructive) 12%, var(--rd-panel));
    color: var(--destructive);
  }

  .live {
    background: var(--rd-live-bg);
    color: var(--rd-live-on);
  }
</style>
