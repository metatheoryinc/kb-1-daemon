<script lang="ts">
  import Avatar from '../primitives/Avatar.svelte';
  import Checkbox from '../primitives/Checkbox.svelte';
  import type { VaultFilterEntry } from './types';

  interface Props {
    vaults: VaultFilterEntry[];
    /** Ids currently visible (not in the hide-list). */
    selectedIds: string[];
    onToggle: (id: string) => void;
    onClose: () => void;
  }

  let { vaults, selectedIds, onToggle, onClose }: Props = $props();
</script>

<button
  type="button"
  class="backdrop"
  aria-label="Close filter"
  onclick={onClose}
></button>
<div
  class="popover"
  role="dialog"
  aria-label="Filter visible vaults"
  onclick={(event) => event.stopPropagation()}
  onkeydown={(event) => {
    if (event.key === 'Escape') onClose();
  }}
  tabindex="-1"
>
  <div class="header">Filter visible vaults</div>
  {#each vaults as vault (vault.id)}
    {@const checked = selectedIds.includes(vault.id)}
    <button
      type="button"
      class="row"
      onclick={() => onToggle(vault.id)}
    >
      <Checkbox
        {checked}
        ariaLabel={`Toggle ${vault.name}`}
        onclick={(event) => {
          event.stopPropagation();
          onToggle(vault.id);
        }}
      />
      <Avatar kind="folder" accent={vault.accent} size={14} />
      <span class="name">{vault.name}</span>
    </button>
  {/each}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    border: none;
    padding: 0;
    margin: 0;
    background: transparent;
    cursor: default;
  }

  .popover {
    position: absolute;
    top: 96px;
    left: 14px;
    width: 252px;
    z-index: 50;
    padding: 8px 6px;
    background: var(--rd-panel);
    border: 1px solid var(--rd-rule-strong);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(31, 28, 22, 0.08), 0 1px 2px rgba(31, 28, 22, 0.04);
  }

  .header {
    padding: 4px 10px 6px;
    color: var(--rd-ink-4);
    font-family: var(--rd-ui);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .row:hover {
    background: var(--rd-hover);
  }

  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
