<script lang="ts">
  interface Props {
    checked: boolean;
    ariaLabel?: string;
    onclick?: (event: MouseEvent) => void;
  }

  let { checked, ariaLabel, onclick }: Props = $props();
</script>

<button
  type="button"
  class="checkbox"
  class:checked
  role="checkbox"
  aria-checked={checked}
  aria-label={ariaLabel}
  {onclick}
>
  {#if checked}
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.5 5 9l4.5-5"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  {/if}
</button>

<style>
  .checkbox {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    padding: 0;
    border: 1px solid var(--rd-rule-strong);
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
  }

  .checkbox.checked {
    border: none;
    background: var(--rd-ink-1);
    /* `currentColor` for the check stroke — inverse of the dark fill so
       the tick stays visible in both modes. */
    color: var(--rd-bg);
  }

  .checkbox:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--rd-ink-3) 40%, transparent);
    outline-offset: 1px;
  }
</style>
