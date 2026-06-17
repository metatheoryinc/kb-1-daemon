<script lang="ts" module>
  export interface MenuItem {
    label: string;
    onSelect: () => void;
    destructive?: boolean;
  }
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
  class="fixed z-50 min-w-[10rem] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
  style:left="{left}px"
  style:top="{top}px"
>
  {#each items as item, i (i)}
    <button
      role="menuitem"
      type="button"
      class={cn(
        'flex w-full items-center px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
        item.destructive && 'text-destructive',
      )}
      onclick={(event) => {
        event.stopPropagation();
        onclose();
        item.onSelect();
      }}
    >
      {item.label}
    </button>
  {/each}
</div>
