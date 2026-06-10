<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '../utils';

  /**
   * A small hover-popover rendered as a fixed-position sibling of the
   * row it describes. Same escape-the-sticky-stacking-context pattern
   * as `ContextMenu.svelte` / `VaultFilterPanel.svelte`: `position:
   * fixed` + viewport coords, manual clamping, no portals.
   *
   * Positioning: anchors below the trigger rect and reflows leftward /
   * upward if it would spill off-screen. `ariaLabel` names the popover
   * for the a11y tree (title attribute on the row still serves as the
   * plain-text fallback).
   */

  interface Props {
    triggerRect: DOMRect;
    ariaLabel: string;
    body: Snippet;
    class?: string;
  }

  let { triggerRect, ariaLabel, body, class: className }: Props = $props();

  let card: HTMLDivElement | null = $state(null);

  // Seed placement from the trigger rect (align the card's left edge
  // to the trigger's left). Corrected post-mount once the card's real
  // dimensions are known.
  // svelte-ignore state_referenced_locally
  let left = $state(triggerRect.left);
  // svelte-ignore state_referenced_locally
  let top = $state(triggerRect.bottom + 4);

  $effect(() => {
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const margin = 8;

    let nextLeft = triggerRect.left;
    if (nextLeft + rect.width + margin > window.innerWidth) {
      nextLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (nextLeft < margin) nextLeft = margin;

    let nextTop = triggerRect.bottom + 4;
    if (nextTop + rect.height + margin > window.innerHeight) {
      const flipped = triggerRect.top - rect.height - 4;
      nextTop = flipped >= margin ? flipped : margin;
    }

    left = nextLeft;
    top = nextTop;
  });
</script>

<div
  bind:this={card}
  role="tooltip"
  aria-label={ariaLabel}
  class={cn('popover', className)}
  style:left="{left}px"
  style:top="{top}px"
>
  {@render body()}
</div>

<style>
  .popover {
    pointer-events: none;
    position: fixed;
    z-index: 50;
    max-width: 28rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--popover);
    color: var(--popover-foreground);
    box-shadow: 0 14px 30px rgba(15, 23, 42, 0.16);
    padding: 8px;
    font-family: var(--rd-ui);
    font-size: 12px;
  }
</style>
