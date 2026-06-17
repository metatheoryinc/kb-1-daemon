<script lang="ts">
  import Button from '../button/button.svelte';
  import DialogShell from './DialogShell.svelte';

  interface Props {
    open: boolean;
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    busy?: boolean;
    error?: string | null;
    onconfirm: () => void;
    oncancel: () => void;
  }

  let {
    open,
    title,
    description,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    destructive = false,
    busy = false,
    error = null,
    onconfirm,
    oncancel,
  }: Props = $props();
</script>

<DialogShell {open} onclose={oncancel} {title} {description}>
  {#snippet children()}
    {#if error}
      <p class="dialog-error">{error}</p>
    {/if}
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={oncancel} disabled={busy}>
      {cancelLabel}
    </Button>
    <Button
      variant={destructive ? 'destructive' : 'default'}
      size="sm"
      onclick={onconfirm}
      disabled={busy}
    >
      {busy ? 'Working…' : confirmLabel}
    </Button>
  {/snippet}
</DialogShell>

<style>
  .dialog-error {
    margin: 0;
    color: var(--destructive);
    font-family: var(--rd-ui);
    font-size: 14px;
  }
</style>
