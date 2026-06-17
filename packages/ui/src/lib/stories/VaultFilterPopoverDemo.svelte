<script lang="ts">
  import { untrack } from 'svelte';
  import VaultFilterPopover from '../local-editor/VaultFilterPopover.svelte';
  import type { VaultFilterEntry } from '../local-editor/types';

  interface Props {
    vaults?: VaultFilterEntry[];
    initialHidden?: string[];
  }

  const defaultVaults: VaultFilterEntry[] = [
    { id: 'demo-vault', name: 'demo-vault', accent: 'slate' },
    { id: 'research', name: 'research', accent: 'sage' },
    { id: 'archive', name: 'archive', accent: 'coral' }
  ];

  let { vaults = defaultVaults, initialHidden = [] }: Props = $props();

  let hidden = $state(new Set(untrack(() => initialHidden)));

  const selectedIds = $derived(vaults.map((v) => v.id).filter((id) => !hidden.has(id)));

  function toggle(id: string) {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    hidden = next;
  }
</script>

<div class="frame">
  <VaultFilterPopover
    {vaults}
    {selectedIds}
    onToggle={toggle}
    onClose={() => {}}
  />
</div>

<style>
  .frame {
    position: relative;
    width: 300px;
    height: 220px;
    background: var(--rd-panel);
  }

  /* Pin the popover inside the demo frame rather than the viewport. */
  .frame :global(.popover) {
    top: 12px;
    left: 12px;
  }
</style>
