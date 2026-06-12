<script lang="ts" module>
  export interface MenuSwatch {
    label: string;
    color: string;
    selected?: boolean;
    onSelect: () => void;
  }

  export type MenuItem =
    | {
    kind?: 'item';
    label: string;
    onSelect: () => void;
    destructive?: boolean;
    }
    | {
      kind: 'swatches';
      label: string;
      swatches: MenuSwatch[];
    };
</script>

<script lang="ts">
  import { cn } from '../utils';

  /**
   * Positioning mode:
   * - `cursor`: top-left pinned at (x,y) — right-click at the pointer.
   *   Reflows leftward / flips upward if the menu would spill past the
   *   viewport edge from that corner.
   * - `anchor`: right-aligned under a trigger rect's bottom-right —
   *   button-click menus that want to visually "hang" from the trigger.
   *   Flips above the trigger if the downward placement would overflow.
   */
  type Position =
    | { mode: 'cursor'; x: number; y: number }
    | { mode: 'anchor'; rect: DOMRect };

  interface Props {
    items: MenuItem[];
    position: Position;
    ariaLabel: string;
    onclose: () => void;
  }

  let { items, position, ariaLabel, onclose }: Props = $props();

  let menu: HTMLDivElement | null = $state(null);

  // Seed placement before the menu mounts. The post-mount effect below
  // corrects for actual rendered dimensions.
  const seed = $derived.by(() => {
    if (position.mode === 'cursor') {
      return { left: position.x, top: position.y };
    }
    // Estimated menu width 160px (min-w-[10rem]); real width is applied
    // post-mount.
    return {
      left: position.rect.right - 160,
      top: position.rect.bottom + 4,
    };
  });

  // svelte-ignore state_referenced_locally
  let left = $state(seed.left);
  // svelte-ignore state_referenced_locally
  let top = $state(seed.top);

  $effect(() => {
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;

    if (position.mode === 'cursor') {
      let nextLeft = position.x;
      let nextTop = position.y;

      if (nextLeft + rect.width + margin > window.innerWidth) {
        nextLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      }
      if (nextTop + rect.height + margin > window.innerHeight) {
        // Flip upward from the click point; if that still doesn't fit,
        // clamp to the top edge.
        nextTop = Math.max(margin, position.y - rect.height);
        if (nextTop + rect.height + margin > window.innerHeight) {
          nextTop = margin;
        }
      }

      left = nextLeft;
      top = nextTop;
      return;
    }

    // anchor mode: right-align to trigger, flip above if needed.
    const tRect = position.rect;
    let nextLeft = tRect.right - rect.width;
    if (nextLeft < margin) nextLeft = margin;

    let nextTop = tRect.bottom + 4;
    if (nextTop + rect.height + margin > window.innerHeight) {
      const flipped = tRect.top - rect.height - 4;
      nextTop = flipped >= margin ? flipped : margin;
    }

    left = nextLeft;
    top = nextTop;
  });

  function handleWindowPointer(event: PointerEvent): void {
    if (!menu) return;
    const target = event.target;
    if (target instanceof Node && menu.contains(target)) return;
    onclose();
  }

  function handleKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }
</script>

<svelte:window
  onpointerdown={handleWindowPointer}
  onkeydown={handleKey}
  onresize={onclose}
  onscroll={onclose}
/>

<!--
  Rendered as a sibling (not descendant) of the sticky tree row by its
  caller, so it isn't trapped inside the row's `sticky z-10` stacking
  context. `position: fixed` + viewport coords keep it anchored on the
  screen rather than relative to any scrolling ancestor.
-->
<div
  bind:this={menu}
  role="menu"
  aria-label={ariaLabel}
  class="context-menu"
  style:left="{left}px"
  style:top="{top}px"
>
  {#each items as item, i (i)}
    {#if item.kind === 'swatches'}
      <div class="context-menu-swatches" role="group" aria-label={item.label}>
        <span class="swatch-label">{item.label}</span>
        <div class="swatch-row">
          {#each item.swatches as swatch (swatch.label)}
            <button
              type="button"
              class="swatch"
              class:selected={swatch.selected}
              aria-label={swatch.label}
              aria-pressed={swatch.selected}
              title={swatch.label}
              style:--swatch-color={swatch.color}
              onclick={(event) => {
                event.stopPropagation();
                onclose();
                swatch.onSelect();
              }}
            ></button>
          {/each}
        </div>
      </div>
    {:else}
      <button
        role="menuitem"
        type="button"
        class={cn('context-menu-item', item.destructive && 'destructive')}
        onclick={(event) => {
          event.stopPropagation();
          onclose();
          item.onSelect();
        }}
      >
        {item.label}
      </button>
    {/if}
  {/each}
</div>

<style>
  .context-menu {
    position: fixed;
    z-index: 50;
    min-width: 10rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--popover);
    color: var(--popover-foreground);
    box-shadow: 0 14px 30px rgba(15, 23, 42, 0.16);
    padding: 4px;
  }

  .context-menu-item {
    display: flex;
    width: 100%;
    align-items: center;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    padding: 7px 10px;
    font-family: var(--rd-ui);
    font-size: 14px;
    text-align: left;
    cursor: pointer;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .context-menu-item:hover {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  .destructive {
    color: var(--destructive);
  }

  .context-menu-swatches {
    display: grid;
    gap: 6px;
    padding: 7px 8px 8px;
  }

  .swatch-label {
    color: var(--rd-ink-3);
    font-family: var(--rd-ui);
    font-size: 11px;
    font-weight: 600;
  }

  .swatch-row {
    display: grid;
    grid-template-columns: repeat(6, 18px);
    gap: 5px;
  }

  .swatch {
    width: 18px;
    height: 18px;
    border: 1px solid color-mix(in srgb, var(--swatch-color) 72%, black);
    border-radius: 5px;
    background: var(--swatch-color);
    cursor: pointer;
  }

  .swatch:hover,
  .swatch.selected {
    outline: 2px solid var(--rd-ink-1);
    outline-offset: 1px;
  }
</style>
