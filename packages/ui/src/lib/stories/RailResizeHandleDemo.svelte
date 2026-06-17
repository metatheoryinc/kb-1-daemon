<script lang="ts">
  import { untrack } from 'svelte';
  import RailResizeHandle from '../local-editor/RailResizeHandle.svelte';

  interface Props {
    width?: number;
    min?: number;
    max?: number;
  }

  let { width = 282, min = 240, max = 564 }: Props = $props();

  let current = $state(untrack(() => width));

  // Mirror the app-state setter's clamp so the demo behaves like the app.
  function resize(next: number) {
    current = Math.round(Math.min(max, Math.max(min, next)));
  }
</script>

<div class="frame">
  <aside class="rail" style="width: {current}px">
    <p class="readout">Rail width: {current}px</p>
    <p class="hint">Drag the hairline on the right edge.</p>
  </aside>
  <RailResizeHandle width={current} onResize={resize} />
  <main class="canvas">Editor pane</main>
</div>

<style>
  .frame {
    display: flex;
    height: 280px;
    background: var(--rd-bg);
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
  }

  .rail {
    flex: 0 0 auto;
    padding: 16px;
    border-right: 1px solid var(--rd-rule);
    background: var(--rd-panel);
  }

  .readout {
    margin: 0 0 8px;
    color: var(--rd-ink-1);
    font-size: 13px;
    font-weight: 600;
  }

  .hint {
    margin: 0;
    color: var(--rd-ink-4);
    font-size: 12px;
  }

  .canvas {
    flex: 1;
    display: grid;
    place-items: center;
    color: var(--rd-ink-4);
    font-size: 13px;
  }
</style>
