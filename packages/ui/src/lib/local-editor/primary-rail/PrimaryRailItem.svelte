<script lang="ts">
  import Icon from '../../primitives/Icon.svelte';
  import type { IconName } from '../../primitives/types';

  interface Props {
    icon: IconName;
    label: string;
    active?: boolean;
    subtle?: boolean;
    /** When collapsed, the rail is icon-only: the label fades out and
        moves to the button's title/aria-label so the icon stays
        discoverable on hover and to assistive tech. */
    collapsed?: boolean;
    onclick?: (event: MouseEvent) => void;
  }

  let {
    icon,
    label,
    active = false,
    subtle = false,
    collapsed = false,
    onclick,
  }: Props = $props();

  // Neutral active treatment: the active state is carried by the
  // background + text weight + ink-1 icon color, not by an accent tint.
  const background = $derived(active ? 'var(--rd-active)' : 'transparent');
  const iconColor = $derived(
    active ? 'var(--rd-ink-1)' : subtle ? 'var(--rd-ink-4)' : 'var(--rd-ink-2)',
  );
  const textColor = $derived(
    active ? 'var(--rd-ink-1)' : subtle ? 'var(--rd-ink-3)' : 'var(--rd-ink-2)',
  );
</script>

<button
  type="button"
  class="rail-item"
  class:collapsed
  class:active
  title={collapsed ? label : undefined}
  aria-label={label}
  aria-current={active ? 'page' : undefined}
  style="background: {background}; color: {textColor}; --rail-icon-color: {iconColor};"
  {onclick}
>
  <span class="lead">
    <Icon name={icon} size={22} />
  </span>
  <span class="label">{label}</span>
</button>

<style>
  .rail-item {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 11px;
    width: 100%;
    min-height: 34px;
    /* Constant padding so the 22px nav icon lands at the rail's horizontal
       center when collapsed: 10 (body) + 11 (item) + 11 (icon half) = 32 =
       half of the 64px collapsed rail. */
    padding: 7px 11px;
    border: none;
    border-radius: 10px;
    font-family: var(--rd-ui);
    font-size: 12.5px;
    font-weight: 450;
    letter-spacing: -0.005em;
    text-align: left;
    cursor: pointer;
    transition: gap var(--rd-rail-duration) var(--rd-rail-ease);
  }

  .rail-item.active {
    font-weight: 550;
  }

  .rail-item.collapsed {
    gap: 0;
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

  .label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    opacity: 1;
    transition: opacity var(--rd-rail-duration) var(--rd-rail-ease);
  }

  .rail-item.collapsed .label {
    opacity: 0;
    pointer-events: none;
  }
</style>
