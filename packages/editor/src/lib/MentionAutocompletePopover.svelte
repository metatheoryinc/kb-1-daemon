<script lang="ts">
  import { Avatar, accentForId } from '@kb-1/ui';
  import type { OrgPerson } from './markdown-core';

  interface Props {
    people: readonly OrgPerson[];
    selectedIndex: number;
    onSelect: (person: OrgPerson) => void;
  }

  let { people, selectedIndex, onSelect }: Props = $props();

  let listEl: HTMLUListElement | undefined = $state();

  function initialFor(person: OrgPerson): string {
    return (person.name[0] ?? person.email[0] ?? '?').toUpperCase();
  }

  $effect(() => {
    const idx = selectedIndex;
    if (!listEl) return;
    const item = listEl.children[idx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  });
</script>

{#if people.length === 0}
  <div class="kb1-mention-autocomplete-empty">No matches</div>
{:else}
  <ul
    role="listbox"
    class="kb1-mention-autocomplete-list"
    bind:this={listEl}
  >
    {#each people as person, i}
      <li
        role="option"
        aria-selected={i === selectedIndex}
        class="kb1-mention-autocomplete-item{i === selectedIndex ? ' selected' : ''}"
        onmousedown={(event) => {
          event.preventDefault();
          onSelect(person);
        }}
      >
        <Avatar
          kind="human"
          accent={accentForId(person.id)}
          letter={initialFor(person)}
          image={person.image}
          size={24}
          ariaLabel={person.name}
        />
        <span class="kb1-mention-autocomplete-name">{person.name}</span>
        <span class="kb1-mention-autocomplete-email">{person.email}</span>
      </li>
    {/each}
  </ul>
{/if}

<style>
  :global(.kb1-mention-autocomplete) {
    position: absolute;
    display: none;
    z-index: 50;
    min-width: 220px;
    max-width: 340px;
    max-height: 240px;
    overflow-y: auto;
    border: 1px solid var(--rd-border, #d7dee8);
    border-radius: 8px;
    background: var(--rd-panel, #ffffff);
    box-shadow: 0 12px 30px rgba(15, 23, 42, 0.14);
  }

  :global(.kb1-mention-autocomplete[data-show='true']) {
    display: block;
  }

  .kb1-mention-autocomplete-list {
    margin: 0;
    padding: 4px 0;
    list-style: none;
  }

  .kb1-mention-autocomplete-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    cursor: pointer;
    color: var(--rd-ink-1, #1a1d22);
    font: 500 13px/1.25 var(--rd-ui, system-ui, sans-serif);
  }

  .kb1-mention-autocomplete-item:hover,
  .kb1-mention-autocomplete-item.selected {
    background: var(--rd-hover, rgba(80, 120, 180, 0.12));
  }

  .kb1-mention-autocomplete-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kb1-mention-autocomplete-email {
    min-width: 0;
    margin-left: auto;
    overflow: hidden;
    color: var(--rd-ink-3, #6b7785);
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 400;
  }

  .kb1-mention-autocomplete-empty {
    padding: 8px 10px;
    color: var(--rd-ink-3, #6b7785);
    font: 500 13px/1.25 var(--rd-ui, system-ui, sans-serif);
  }
</style>
