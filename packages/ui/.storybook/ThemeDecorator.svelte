<script lang="ts">
  import type { Snippet } from 'svelte';

  type ColorMode = 'light' | 'dark' | 'side-by-side';

  interface Props {
    children: Snippet;
    mode?: ColorMode;
  }

  const { children, mode = 'light' }: Props = $props();

  $effect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    const body = document.body;

    if (mode === 'dark') {
      html.classList.add('dark');
      body?.setAttribute('data-rd-mode', 'dark');
      return;
    }

    html.classList.remove('dark');
    body?.removeAttribute('data-rd-mode');
  });
</script>

{#if mode === 'side-by-side'}
  <div class="mode-grid">
    <div class="mode-column bg-background text-foreground">
      <span class="mode-label">Light</span>
      {@render children()}
    </div>
    <div class="mode-divider" aria-hidden="true"></div>
    <div class="mode-column dark bg-background text-foreground" data-rd-mode="dark">
      <span class="mode-label">Dark</span>
      {@render children()}
    </div>
  </div>
{:else}
  {@render children()}
{/if}

<style>
  .mode-grid {
    display: flex;
    width: 100%;
    min-height: 100vh;
  }

  .mode-column {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    overflow: auto;
  }

  .mode-divider {
    flex: 0 0 1px;
    background: rgba(0, 0, 0, 0.12);
  }

  .mode-label {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 1000;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    padding: 2px 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    text-transform: uppercase;
    pointer-events: none;
  }
</style>
