<script lang="ts">
  import Icon from '../../primitives/Icon.svelte';
  import type { IconName } from '../../primitives/types';

  interface Props {
    icon: IconName;
    label: string;
    active?: boolean;
    subtle?: boolean;
    onclick?: (event: MouseEvent) => void;
  }

  let {
    icon,
    label,
    active = false,
    subtle = false,
    onclick,
  }: Props = $props();

  // Neutral active treatment: the active state is carried by the
  // background + text weight + ink-1 icon color, not by an accent tint.
  const background = $derived(active ? 'var(--rd-active)' : 'transparent');
  const iconColor = $derived(
    active ? 'var(--rd-ink-1)' : subtle ? 'var(--rd-ink-4)' : 'var(--rd-ink-2)',
  );
</script>

<button
  type="button"
  class="rail-item"
  class:active
  title={label}
  aria-label={label}
  aria-current={active ? 'page' : undefined}
  style="background: {background}; --rail-icon-color: {iconColor};"
  {onclick}
>
  <span class="lead">
    <Icon name={icon} size={22} />
  </span>
</button>

<style>
  .rail-item {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 38px;
    padding: 7px;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.12s ease;
  }

  .rail-item:hover:not(.active) {
    background: var(--rd-hover) !important;
  }

  .rail-item:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--rd-ink-3) 40%, transparent);
    outline-offset: -2px;
  }

  .lead {
    display: flex;
    align-items: center;
    color: var(--rail-icon-color);
  }
</style>
