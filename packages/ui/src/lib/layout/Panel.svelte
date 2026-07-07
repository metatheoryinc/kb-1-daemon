<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '../utils';

  interface Props {
    title?: string;
    eyebrow?: string;
    class?: string;
    children: Snippet;
    actions?: Snippet;
  }

  let { title, eyebrow, class: className, children, actions }: Props = $props();
</script>

<section class={cn('kb1-panel', className)}>
  {#if title || eyebrow || actions}
    <header class="panel-header">
      <div class="panel-title-block">
        {#if eyebrow}
          <p class="panel-eyebrow">{eyebrow}</p>
        {/if}
        {#if title}
          <h2 class="panel-title">{title}</h2>
        {/if}
      </div>
      {#if actions}
        <div class="panel-actions">
          {@render actions()}
        </div>
      {/if}
    </header>
  {/if}
  <div class="panel-body">
    {@render children()}
  </div>
</section>

<style>
  .kb1-panel {
    border: 1px solid var(--rd-rule);
    border-radius: 8px;
    background: var(--rd-panel);
    color: var(--rd-ink-1);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  }

  .panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid var(--rd-rule);
    padding: 16px 18px 14px;
  }

  .panel-title-block {
    min-width: 0;
  }

  .panel-eyebrow {
    margin: 0 0 4px;
    color: var(--rd-ink-3);
    font-family: var(--rd-ui);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .panel-title {
    margin: 0;
    color: var(--rd-ink-1);
    font-family: var(--rd-ui);
    font-size: 16px;
    font-weight: 600;
  }

  .panel-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .panel-body {
    padding: 18px;
  }
</style>
