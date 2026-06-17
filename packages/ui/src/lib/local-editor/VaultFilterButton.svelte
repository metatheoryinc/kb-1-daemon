<script lang="ts">
  import Icon from '../primitives/Icon.svelte';

  interface Props {
    open: boolean;
    label: string;
    onclick?: (event: MouseEvent) => void;
  }

  let { open, label, onclick }: Props = $props();
</script>

<button
  type="button"
  class="filter-button"
  class:open
  aria-expanded={open}
  {onclick}
>
  <Icon name="filter" size={12} />
  <span class="label">{label}</span>
  <span class="chev" aria-hidden="true">
    <Icon name="chevron-down" size={10} />
  </span>
</button>

<style>
  .filter-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 6px;
    border: 1px solid var(--rd-rule-strong);
    border-radius: 6px;
    background: var(--rd-panel);
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
    font-size: 11.5px;
    cursor: pointer;
  }

  .filter-button.open {
    background: var(--rd-panel-alt);
  }

  .chev {
    display: inline-flex;
    align-items: center;
    opacity: 0.5;
  }
</style>
