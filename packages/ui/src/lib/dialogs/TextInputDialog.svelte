<script lang="ts" module>
  export interface TextInputFieldOption {
    /** Value written back in the submit payload. */
    value: string;
    /** Label shown in the control. */
    label: string;
  }

  /**
   * Single-line text input. `required` gates the submit button — the
   * field's trimmed value must be non-empty.
   */
  export interface TextInputField {
    type: 'text';
    label: string;
    placeholder?: string;
    initialValue?: string;
    required?: boolean;
  }

  /**
   * Single-select dropdown. The submit payload contains the selected
   * option's `value` in the same positional slot as a text field. The
   * select always has a value (the first option, unless `initialValue`
   * is set), so there's no `required` flag.
   */
  export interface SelectField {
    type: 'select';
    label: string;
    options: TextInputFieldOption[];
    initialValue?: string;
  }

  /** Discriminated union of the field variants the dialog can render. */
  export type DialogField = TextInputField | SelectField;
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../button/button.svelte';
  import FormField from '../primitives/forms/FormField.svelte';
  import FormSelect from '../primitives/forms/FormSelect.svelte';
  import DialogShell from './DialogShell.svelte';

  interface Props {
    open: boolean;
    title: string;
    description?: string;
    fields: DialogField[];
    submitLabel?: string;
    cancelLabel?: string;
    busy?: boolean;
    error?: string | null;
    onsubmit: (values: string[]) => void;
    oncancel: () => void;
  }

  let {
    open,
    title,
    description,
    fields,
    submitLabel = 'Create',
    cancelLabel = 'Cancel',
    busy = false,
    error = null,
    onsubmit,
    oncancel,
  }: Props = $props();

  let values = $state<string[]>([]);
  // Bind whichever element is first — this way a dialog whose first
  // field is a select still gets focused on open (otherwise focus
  // would silently no-op).
  let firstInput = $state<HTMLInputElement | null>(null);
  let firstSelect = $state<HTMLSelectElement | null>(null);

  $effect(() => {
    if (open) {
      values = fields.map((f) => f.initialValue ?? '');
      void focusFirst();
    }
  });

  async function focusFirst(): Promise<void> {
    await tick();
    if (firstInput) {
      firstInput.focus();
      firstInput.select();
    } else {
      firstSelect?.focus();
    }
  }

  const canSubmit = $derived(
    !busy &&
      fields.every((f, i) => {
        // Selects always have a value (we default to the first option
        // via `initialValue`), so they never gate submit. Only `text`
        // fields carry a `required` flag.
        if (f.type !== 'text' || !f.required) return true;
        return (values[i] ?? '').trim().length > 0;
      }),
  );

  function submit(): void {
    if (!canSubmit) return;
    onsubmit(values.map((v) => v.trim()));
  }

  function handleKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }
</script>

<DialogShell {open} onclose={oncancel} {title} {description}>
  {#snippet children()}
    <form
      class="dialog-form"
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {#each fields as field, i (i)}
        <label class="field">
          <span class="field-label">{field.label}</span>
          {#if field.type === 'select'}
            {#if i === 0}
              <FormSelect
                bind:value={values[i]}
                bind:ref={firstSelect}
                options={field.options}
                disabled={busy}
              />
            {:else}
              <FormSelect
                bind:value={values[i]}
                options={field.options}
                disabled={busy}
              />
            {/if}
          {:else if i === 0}
            <FormField
              bind:value={values[i]}
              bind:ref={firstInput}
              placeholder={field.placeholder ?? ''}
              onkeydown={handleKey}
              disabled={busy}
            />
          {:else}
            <FormField
              bind:value={values[i]}
              placeholder={field.placeholder ?? ''}
              onkeydown={handleKey}
              disabled={busy}
            />
          {/if}
        </label>
      {/each}
      {#if error}
        <p class="dialog-error">{error}</p>
      {/if}
    </form>
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={oncancel} disabled={busy}>
      {cancelLabel}
    </Button>
    <Button size="sm" onclick={submit} disabled={!canSubmit}>
      {busy ? 'Working…' : submitLabel}
    </Button>
  {/snippet}
</DialogShell>

<style>
  .dialog-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--rd-ui);
    font-size: 14px;
  }

  .field-label {
    font-weight: 500;
    color: var(--foreground);
  }

  .dialog-error {
    margin: 0;
    color: var(--destructive);
    font-family: var(--rd-ui);
    font-size: 14px;
  }
</style>
