<script lang="ts">
  import { Button, ContextMenu, type MenuItem } from '../index';

  let open = $state(true);
  let anchor: DOMRect | null = $state(null);
  let trigger: HTMLElement | null = $state(null);

  const items: MenuItem[] = [
    { label: 'Open', onSelect: () => undefined },
    { label: 'Rename', onSelect: () => undefined },
    {
      kind: 'swatches',
      label: 'Folder color',
      swatches: [
        { label: 'Sky', color: '#bae6fd', selected: true, onSelect: () => undefined },
        { label: 'Sage', color: '#bbf7d0', onSelect: () => undefined },
        { label: 'Coral', color: '#fecdd3', onSelect: () => undefined },
        { label: 'Amber', color: '#fde68a', onSelect: () => undefined },
        { label: 'Lilac', color: '#ddd6fe', onSelect: () => undefined },
        { label: 'Slate', color: '#cbd5e1', onSelect: () => undefined }
      ]
    },
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
