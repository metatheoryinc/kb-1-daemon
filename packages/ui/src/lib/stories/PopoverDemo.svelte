<script lang="ts">
  import { Button, Popover } from '../index';

  let trigger: HTMLElement | null = $state(null);
  let triggerRect: DOMRect | null = $state(null);

  $effect(() => {
    triggerRect = trigger?.getBoundingClientRect() ?? null;
  });
</script>

<div class="story-pad">
  <Button bind:ref={trigger} variant="outline">Inspect</Button>
</div>

{#if triggerRect}
  <Popover {triggerRect} ariaLabel="Inspection details">
    {#snippet body()}
      <p class="copy">Fixture-backed popover content.</p>
    {/snippet}
  </Popover>
{/if}

<style>
  .story-pad {
    padding: 32px;
  }

  .copy {
    margin: 0;
  }
</style>
