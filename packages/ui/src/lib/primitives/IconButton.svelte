<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    size?: 'sm' | 'md' | 'lg';
    variant?: 'quiet' | 'active' | 'outlined';
    title?: string;
    ariaLabel?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
    label?: Snippet;
  }

  let {
    size = 'md',
    variant = 'quiet',
    title,
    ariaLabel,
    onclick,
    children,
    label,
  }: Props = $props();
</script>

<button
  type="button"
  class="icon-button"
  class:size-sm={size === 'sm'}
  class:size-md={size === 'md'}
  class:size-lg={size === 'lg'}
  class:variant-quiet={variant === 'quiet'}
  class:variant-active={variant === 'active'}
  class:variant-outlined={variant === 'outlined'}
  class:has-label={!!label}
  aria-label={ariaLabel ?? title}
  {title}
  {onclick}
>
  {@render children()}
  {#if label}
    <span class="label">{@render label()}</span>
  {/if}
</button>

<style>
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--rd-ink-3);
    font: inherit;
    cursor: pointer;
    transition: background 80ms ease, color 80ms ease;
  }

  .icon-button:hover {
    background: var(--rd-hover);
  }

  .icon-button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--rd-ink-3) 40%, transparent);
    outline-offset: 1px;
  }

  .size-md {
    min-height: 28px;
    min-width: 28px;
    padding: 0;
  }

  .size-sm {
    min-height: 26px;
    min-width: 26px;
    padding: 0;
  }

  .size-lg {
    min-height: 34px;
    min-width: 34px;
    padding: 0;
  }

  .size-lg.has-label {
    padding: 0 12px 0 10px;
  }

  .has-label {
    gap: 5px;
    padding: 0 9px 0 7px;
    color: var(--rd-ink-2);
  }

  .variant-active {
    border-color: var(--rd-rule-strong);
    background: var(--rd-panel-alt);
    color: var(--rd-ink-1);
  }

  .variant-outlined {
    border-color: var(--rd-rule);
    color: var(--rd-ink-3);
  }

  .label {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: -0.005em;
  }
</style>
