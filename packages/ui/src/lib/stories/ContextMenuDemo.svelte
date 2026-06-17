<script lang="ts">
  import { Button, ContextMenu, type MenuItem } from '../index';

  interface Props {
    mode?: 'light' | 'dark';
  }

  let { mode = 'light' }: Props = $props();

  let open = $state(true);
  let anchor: DOMRect | null = $state(null);
  let trigger: HTMLElement | null = $state(null);

  // Mirrors the trimmed folder context menu the file tree renders:
  // New Note / New Folder / Rename / Move / Delete.
  const items: MenuItem[] = [
    { label: 'New Note', onSelect: () => undefined },
    { label: 'New Folder', onSelect: () => undefined },
    { label: 'Rename', onSelect: () => undefined },
    { label: 'Move', onSelect: () => undefined },
    { label: 'Delete', destructive: true, onSelect: () => undefined }
  ];

  $effect(() => {
    anchor = trigger?.getBoundingClientRect() ?? null;
  });
</script>

<div class:dark={mode === 'dark'} data-rd-mode={mode} class="preview">
  <div class="story-pad">
    <Button bind:ref={trigger} onclick={() => (open = true)}>Open menu</Button>
  </div>

  {#if open && anchor}
    <ContextMenu {items} position={{ mode: 'anchor', rect: anchor }} ariaLabel="Folder actions" onclose={() => (open = false)} />
  {/if}
</div>

<style>
  .preview {
    min-height: 100vh;
    background: var(--rd-bg);
  }

  .story-pad {
    padding: 32px;
  }
</style>
