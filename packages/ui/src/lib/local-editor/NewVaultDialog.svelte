<script lang="ts" module>
  export interface NewVaultSubmit {
    /** Human-facing vault name. */
    displayName: string;
    /** The (editable) slug — the daemon's stable vault id. Always sent. */
    slug: string;
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import Button from '../button/button.svelte';
  import FormField from '../primitives/forms/FormField.svelte';
  import DialogShell from '../dialogs/DialogShell.svelte';
  import { suggestSlug, isWellFormedSlug } from './slug';

  /**
   * "New vault" dialog. Collects a display name, auto-suggests a slug from
   * it as the user types (client-side, via the SAME github-slugger
   * definition the daemon uses, so a suggested slug is accepted verbatim),
   * and lets the user edit the slug. On submit it ALWAYS emits both
   * `{ displayName, slug }`.
   *
   * Owns no transport: the network create is the host's `onsubmit`
   * callback; `busy` / `error` surface in-flight + failure state (an
   * invalid slug or a slug collision the server reports) inline.
   */
  interface Props {
    open: boolean;
    title?: string;
    description?: string;
    submitLabel?: string;
    cancelLabel?: string;
    busy?: boolean;
    /** Server-side failure (bad slug, collision) surfaced inline. */
    error?: string | null;
    onsubmit: (value: NewVaultSubmit) => void;
    oncancel: () => void;
  }

  let {
    open,
    title = 'New vault',
    description = 'Create a vault. The slug names its folder and URL; it is suggested from the name and you can edit it.',
    submitLabel = 'Create',
    cancelLabel = 'Cancel',
    busy = false,
    error = null,
    onsubmit,
    oncancel,
  }: Props = $props();

  let displayName = $state('');
  let slug = $state('');
  // Whether the user has hand-edited the slug. While false, the slug
  // tracks the suggestion from the display name; once the user touches it,
  // we stop overwriting their choice.
  let slugEdited = $state(false);
  let nameInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (open) {
      displayName = '';
      slug = '';
      slugEdited = false;
      void focusName();
    }
  });

  async function focusName(): Promise<void> {
    await tick();
    nameInput?.focus();
  }

  // Re-suggest the slug from the name until the user takes the slug over.
  // Read the live value off the event target so we don't depend on the
  // `bind:value` listener firing first; `bind:value` then reflects any
  // slug reassignment back into the slug input.
  function onNameInput(event: Event): void {
    const next = (event.currentTarget as HTMLInputElement).value;
    if (!slugEdited) slug = suggestSlug(next);
  }

  // A manual slug edit pins the slug to the user's value. Clearing it back
  // to empty re-arms the suggestion so the slot doesn't get stuck blank.
  function onSlugInput(event: Event): void {
    const next = (event.currentTarget as HTMLInputElement).value;
    if (next === '') {
      slugEdited = false;
      slug = suggestSlug(displayName);
      return;
    }
    slugEdited = true;
  }

  const trimmedName = $derived(displayName.trim());
  // The well-formedness hint mirrors the daemon's server-side check, so a
  // bad slug is caught before the round-trip. An empty slug is gated by
  // `canSubmit`; this message only fires for a present-but-malformed slug.
  const slugInvalid = $derived(slug.length > 0 && !isWellFormedSlug(slug));
  const canSubmit = $derived(
    !busy && trimmedName.length > 0 && slug.length > 0 && !slugInvalid,
  );

  function submit(): void {
    if (!canSubmit) return;
    onsubmit({ displayName: trimmedName, slug });
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
      <label class="field">
        <span class="field-label">Name</span>
        <FormField
          bind:value={displayName}
          bind:ref={nameInput}
          placeholder="My vault"
          oninput={onNameInput}
          onkeydown={handleKey}
          disabled={busy}
        />
      </label>

      <label class="field">
        <span class="field-label">Slug</span>
        <FormField
          bind:value={slug}
          placeholder="my-vault"
          oninput={onSlugInput}
          onkeydown={handleKey}
          disabled={busy}
        />
        {#if slugInvalid}
          <span class="field-hint field-hint-error">
            A slug uses lowercase letters, numbers, and dashes. Try “{suggestSlug(slug)}”.
          </span>
        {:else}
          <span class="field-hint">Used for the folder and the URL.</span>
        {/if}
      </label>

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

  .field-hint {
    color: var(--muted-foreground);
    font-family: var(--rd-ui);
    font-size: 12px;
  }

  .field-hint-error {
    color: var(--destructive);
  }

  .dialog-error {
    margin: 0;
    color: var(--destructive);
    font-family: var(--rd-ui);
    font-size: 14px;
  }
</style>
