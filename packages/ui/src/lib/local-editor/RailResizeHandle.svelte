<script lang="ts">
  /**
   * Drag handle for the secondary (files) rail. Sits as a grid sibling
   * between the files panel and the editor pane. The component is
   * prop-driven: it forwards `dragStartWidth + (event.clientX -
   * dragStartX)` to `onResize`, and the app-state setter clamps the raw
   * value, so the handle never has to know the min/max bounds.
   *
   * The visible affordance is a 1px hairline pinned to the left edge of
   * the 6px hit-area; on hover or during drag the hairline brightens.
   *
   * Pointer events cover mouse, pen, and touch. On a non-pointer browser
   * the handlers simply never fire — desktop builds always have pointer
   * events, so no fallback is needed.
   */
  interface Props {
    width: number;
    onResize: (next: number) => void;
  }

  let { width, onResize }: Props = $props();

  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartWidth = 0;

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    dragging = true;
    dragStartX = event.clientX;
    dragStartWidth = width;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging) return;
    onResize(dragStartWidth + (event.clientX - dragStartX));
  }

  function onPointerUp(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
  }
</script>

<div
  class="handle"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize panel"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
></div>

<style>
  .handle {
    position: relative;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    background: transparent;
    touch-action: none;
    user-select: none;
  }

  .handle::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 1px;
    background: var(--rd-rule);
    transition: background 120ms ease;
  }

  .handle:hover::before,
  .handle.dragging::before {
    background: var(--rd-rule-strong);
  }

  /* Body-wide cursor + selection lock during drag — pointer capture
     keeps events flowing here, but the cursor and text-selection
     suppression should follow the user across the whole canvas. */
  :global(body:has(.handle.dragging)) {
    cursor: col-resize;
    user-select: none;
  }
</style>
