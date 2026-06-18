<script lang="ts">
  /**
   * Bare text input styled to match `TextInputDialog`'s form-input pattern.
   * Renders a single `<input>` element with the shared utility classes —
   * the parent owns the surrounding label / span / structure. Extracted
   * verbatim from the inline blocks in `TextInputDialog.svelte`.
   */
  import type { HTMLInputAttributes } from 'svelte/elements';

  interface Props {
    value: string;
    type?: 'text' | 'email' | 'password';
    placeholder?: string;
    disabled?: boolean;
    autocomplete?: HTMLInputAttributes['autocomplete'];
    name?: string;
    required?: boolean;
    ref?: HTMLInputElement | null;
    onkeydown?: (event: KeyboardEvent) => void;
    /** Fires on every keystroke — used by callers that derive a live
        value (e.g. the new-vault dialog's slug-suggest) from the input. */
    oninput?: (event: Event) => void;
  }

  let {
    value = $bindable(),
    type = 'text',
    placeholder = '',
    disabled = false,
    autocomplete,
    name,
    required = false,
    ref = $bindable(null),
    onkeydown,
    oninput,
  }: Props = $props();
</script>

<input
  bind:value
  bind:this={ref}
  class="form-field"
  {type}
  {placeholder}
  {onkeydown}
  {oninput}
  {disabled}
  {autocomplete}
  {name}
  {required}
/>

<style>
  .form-field {
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

  .form-field:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 45%, transparent);
  }
</style>
