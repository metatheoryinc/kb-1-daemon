<script lang="ts" module>
  import type { IconName } from '../primitives/types';

  export type DocumentSaveBannerVariant =
    | 'external-change'
    | 'persist-failure'
    | 'persist-recovered';

  export interface DocumentSaveBannerProps {
    variant: DocumentSaveBannerVariant;
    title?: string;
    message?: string;
    actionLabel?: string;
    onaction?: (event: MouseEvent) => void;
    ondismiss?: (event: MouseEvent) => void;
    dismissLabel?: string;
    class?: string;
  }

  interface VariantConfig {
    title: string;
    message: string;
    icon: IconName;
    role: 'alert' | 'status';
    ariaLive: 'assertive' | 'polite';
  }

  const variantConfig: Record<DocumentSaveBannerVariant, VariantConfig> = {
    'external-change': {
      title: 'Document changed elsewhere',
      message: 'A newer version is available. Review it before continuing to edit.',
      icon: 'refresh',
      role: 'status',
      ariaLive: 'polite',
    },
    'persist-failure': {
      title: 'Changes are not saving',
      message: 'Your edits are still in this session, but KB-2 cannot persist them right now.',
      icon: 'bell',
      role: 'alert',
      ariaLive: 'assertive',
    },
    'persist-recovered': {
      title: 'Saving restored',
      message: 'KB-2 is persisting changes again.',
      icon: 'cloud',
      role: 'status',
      ariaLive: 'polite',
    },
  };
</script>

<script lang="ts">
  import { Button } from '../button';
  import Icon from '../primitives/Icon.svelte';
  import IconButton from '../primitives/IconButton.svelte';
  import { cn } from '../utils';

  let {
    variant,
    title,
    message,
    actionLabel,
    onaction,
    ondismiss,
    dismissLabel = 'Dismiss save notification',
    class: className = '',
  }: DocumentSaveBannerProps = $props();

  const config = $derived(variantConfig[variant]);
  const heading = $derived(title ?? config.title);
  const body = $derived(message ?? config.message);
  const hasAction = $derived(Boolean(actionLabel && onaction));
</script>

<section
  class={cn('document-save-banner', `variant-${variant}`, className)}
  role={config.role}
  aria-live={config.ariaLive}
>
  <span class="icon-cell" aria-hidden="true">
    <Icon name={config.icon} size={18} weight="regular" />
  </span>

  <div class="copy">
    <h2>{heading}</h2>
    <p>{body}</p>
  </div>

  {#if hasAction}
    <Button variant="outline" size="sm" onclick={onaction}>{actionLabel}</Button>
  {/if}

  {#if ondismiss}
    <IconButton size="sm" variant="quiet" title={dismissLabel} ariaLabel={dismissLabel} onclick={ondismiss}>
      <Icon name="x" size={15} weight="regular" />
    </IconButton>
  {/if}
</section>

<style>
  .document-save-banner {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 12px;
    width: 100%;
    border: 1px solid var(--banner-border);
    border-radius: 8px;
    background: var(--banner-bg);
    color: var(--rd-ink-1);
    padding: 10px 12px;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  }

  .icon-cell {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 7px;
    background: var(--banner-icon-bg);
    color: var(--banner-accent);
  }

  .copy {
    min-width: 0;
  }

  h2,
  p {
    margin: 0;
    font-family: var(--rd-ui);
  }

  h2 {
    color: var(--rd-ink-1);
    font-size: 13px;
    font-weight: 650;
    line-height: 1.25;
  }

  p {
    margin-top: 2px;
    color: var(--rd-ink-3);
    font-size: 12px;
    line-height: 1.35;
  }

  :global(.document-save-banner .kb2-button) {
    background: color-mix(in srgb, var(--banner-accent) 8%, var(--rd-panel));
    color: var(--rd-ink-2);
  }

  :global(.document-save-banner .kb2-button:hover) {
    background: color-mix(in srgb, var(--banner-accent) 14%, var(--rd-panel));
  }

  .variant-external-change {
    --banner-accent: var(--rd-sky);
    --banner-bg: color-mix(in srgb, var(--rd-sky-bg) 32%, var(--rd-panel));
    --banner-border: color-mix(in srgb, var(--rd-sky) 28%, var(--rd-rule));
    --banner-icon-bg: color-mix(in srgb, var(--rd-sky-bg) 70%, var(--rd-panel));
  }

  .variant-persist-failure {
    --banner-accent: var(--destructive);
    --banner-bg: color-mix(in srgb, var(--destructive) 8%, var(--rd-panel));
    --banner-border: color-mix(in srgb, var(--destructive) 30%, var(--rd-rule));
    --banner-icon-bg: color-mix(in srgb, var(--destructive) 12%, var(--rd-panel));
  }

  .variant-persist-recovered {
    --banner-accent: var(--rd-live-on);
    --banner-bg: color-mix(in srgb, var(--rd-live-bg) 42%, var(--rd-panel));
    --banner-border: color-mix(in srgb, var(--rd-live) 32%, var(--rd-rule));
    --banner-icon-bg: color-mix(in srgb, var(--rd-live-bg) 72%, var(--rd-panel));
  }

  @media (max-width: 560px) {
    .document-save-banner {
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: start;
    }

    :global(.document-save-banner .kb2-button) {
      grid-column: 2 / -1;
      justify-self: start;
    }
  }
</style>
