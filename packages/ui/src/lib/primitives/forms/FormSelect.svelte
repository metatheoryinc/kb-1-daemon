<script lang="ts">
  /**
   * Bare select styled to match `TextInputDialog`'s form-input pattern.
   * Renders a single `<select>` element with the shared utility classes —
   * the parent owns the surrounding label / span / structure. Extracted
   * verbatim from the inline blocks in `TextInputDialog.svelte`.
   */
  export interface FormSelectOption {
    value: string;
    label: string;
  }

  interface Props {
    value: string;
    options: FormSelectOption[];
    disabled?: boolean;
    ref?: HTMLSelectElement | null;
  }

  let {
    value = $bindable(),
    options,
    disabled = false,
    ref = $bindable(null),
  }: Props = $props();
</script>

<select
  bind:value
  bind:this={ref}
  class="form-select"
  {disabled}
>
  {#each options as option (option.value)}
    <option value={option.value}>{option.label}</option>
  {/each}
</select>

<style>
  .form-select {
    min-height: 38px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--background);
    color: var(--foreground);
    padding: 0 12px;
    font-family: var(--rd-ui);
    font-size: 14px;
    outline: none;
  }

  .form-select:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 45%, transparent);
  }
</style>
