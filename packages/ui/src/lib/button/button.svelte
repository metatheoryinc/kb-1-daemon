<script lang="ts" module>
  import { cn, type WithElementRef } from '../utils';
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

  export type ButtonVariant =
    | 'default'
    | 'destructive'
    | 'outline'
    | 'secondary'
    | 'ghost'
    | 'link';
  export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm' | 'icon-lg';

  export function buttonVariants({
    variant = 'default',
    size = 'default',
  }: {
    variant?: ButtonVariant;
    size?: ButtonSize;
  } = {}): string {
    return `kb1-button variant-${variant} size-${size}`;
  }

  export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
    WithElementRef<HTMLAnchorAttributes> & {
      variant?: ButtonVariant;
      size?: ButtonSize;
    };
</script>

<script lang="ts">
  let {
    class: className,
    variant = 'default',
    size = 'default',
    ref = $bindable(null),
    href = undefined,
    type = 'button',
    disabled,
    children,
    ...restProps
  }: ButtonProps = $props();
</script>

{#if href}
  <a
    bind:this={ref}
    data-slot="button"
    class={cn(buttonVariants({ variant, size }), className)}
    href={disabled ? undefined : href}
    aria-disabled={disabled}
    role={disabled ? 'link' : undefined}
    tabindex={disabled ? -1 : undefined}
    {...restProps}
  >
    {@render children?.()}
  </a>
{:else}
  <button
    bind:this={ref}
    data-slot="button"
    class={cn(buttonVariants({ variant, size }), className)}
    {type}
    {disabled}
    {...restProps}
  >
    {@render children?.()}
  </button>
{/if}

<style>
  .kb1-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    gap: 8px;
    border: 1px solid transparent;
    border-radius: 6px;
    font-family: var(--rd-ui);
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease,
      box-shadow 120ms ease;
  }

  .kb1-button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--ring) 50%, transparent);
    outline-offset: 2px;
  }

  .kb1-button[disabled],
  .kb1-button[aria-disabled='true'] {
    pointer-events: none;
    opacity: 0.5;
  }

  .variant-default {
    background: var(--primary);
    color: var(--primary-foreground);
    box-shadow: 0 1px 1px rgba(15, 23, 42, 0.08);
  }

  .variant-default:hover {
    background: color-mix(in srgb, var(--primary) 90%, black);
  }

  .variant-destructive {
    background: var(--destructive);
    color: #fff;
    box-shadow: 0 1px 1px rgba(15, 23, 42, 0.08);
  }

  .variant-destructive:hover {
    background: color-mix(in srgb, var(--destructive) 88%, black);
  }

  .variant-outline {
    border-color: var(--border);
    background: var(--background);
    color: var(--foreground);
    box-shadow: 0 1px 1px rgba(15, 23, 42, 0.04);
  }

  .variant-outline:hover,
  .variant-ghost:hover {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  .variant-secondary {
    background: var(--secondary);
    color: var(--secondary-foreground);
    box-shadow: 0 1px 1px rgba(15, 23, 42, 0.04);
  }

  .variant-secondary:hover {
    background: color-mix(in srgb, var(--secondary) 82%, var(--foreground));
  }

  .variant-ghost {
    background: transparent;
    color: var(--foreground);
  }

  .variant-link {
    min-height: 0;
    padding: 0;
    background: transparent;
    color: var(--primary);
    text-decoration: underline;
    text-underline-offset: 4px;
  }

  .size-default {
    min-height: 36px;
    padding: 0 16px;
  }

  .size-sm {
    min-height: 32px;
    padding: 0 12px;
    font-size: 13px;
  }

  .size-lg {
    min-height: 40px;
    padding: 0 24px;
  }

  .size-icon {
    width: 36px;
    height: 36px;
    padding: 0;
  }

  .size-icon-sm {
    width: 32px;
    height: 32px;
    padding: 0;
  }

  .size-icon-lg {
    width: 40px;
    height: 40px;
    padding: 0;
  }
</style>
