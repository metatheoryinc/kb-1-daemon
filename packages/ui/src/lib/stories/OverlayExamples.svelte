<script lang="ts">
  import { Button, ContextMenu, DialogShell, Popover } from '../index';

  let menuOpen = $state(false);
  let dialogOpen = $state(false);
  let popoverOpen = $state(false);
  let anchor = $state<DOMRect | null>(null);
  let trigger: HTMLButtonElement | null = $state(null);

  const menuItems = [
    { label: 'Open', onSelect: () => undefined },
    { label: 'Rename', onSelect: () => undefined },
    { label: 'Delete', destructive: true, onSelect: () => undefined }
  ];

  function openMenu(event: MouseEvent) {
    anchor = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menuOpen = true;
  }

  function togglePopover() {
    anchor = trigger?.getBoundingClientRect() ?? null;
    popoverOpen = !popoverOpen;
  }
</script>

<div class="overlay-story">
  <Button onclick={openMenu}>Open menu</Button>
  <Button bind:ref={trigger} variant="outline" onclick={togglePopover}>Inspect</Button>
  <Button variant="secondary" onclick={() => (dialogOpen = true)}>Open dialog</Button>
</div>

{#if menuOpen && anchor}
  <ContextMenu items={menuItems} position={{ mode: 'anchor', rect: anchor }} ariaLabel="File actions" onclose={() => (menuOpen = false)} />
{/if}

{#if popoverOpen && anchor}
  <Popover triggerRect={anchor} ariaLabel="Inspection details">
    {#snippet body()}
      <p class="popover-body">Fixture-backed popover content with no daemon connection.</p>
    {/snippet}
  </Popover>
{/if}

<DialogShell
  open={dialogOpen}
  title="Rename file"
  description="Dialog shell imported from KB-1 primitives."
  onclose={() => (dialogOpen = false)}
>
  {#snippet children()}
    <p class="dialog-copy">This dialog story is fully local and uses static content.</p>
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (dialogOpen = false)}>Cancel</Button>
    <Button onclick={() => (dialogOpen = false)}>Save</Button>
  {/snippet}
</DialogShell>

<style>
  .overlay-story {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 36px;
  }

  .popover-body,
  .dialog-copy {
    margin: 0;
    font-family: var(--rd-ui);
    font-size: 13px;
  }
</style>
