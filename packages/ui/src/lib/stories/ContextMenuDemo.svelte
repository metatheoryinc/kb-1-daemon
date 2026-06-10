<script lang="ts">
  import { Button, ContextMenu } from '../index';

  let open = $state(true);
  let anchor: DOMRect | null = $state(null);
  let trigger: HTMLElement | null = $state(null);

  const items = [
    { label: 'Open', onSelect: () => undefined },
    { label: 'Rename', onSelect: () => undefined },
    { label: 'Delete', destructive: true, onSelect: () => undefined }
  ];

  $effect(() => {
    anchor = trigger?.getBoundingClientRect() ?? null;
  });
</script>

<div class="story-pad">
  <Button bind:ref={trigger} onclick={() => (open = true)}>Open menu</Button>
</div>

{#if open && anchor}
  <ContextMenu {items} position={{ mode: 'anchor', rect: anchor }} ariaLabel="File actions" onclose={() => (open = false)} />
{/if}

<style>
  .story-pad {
    padding: 32px;
  }
</style>
