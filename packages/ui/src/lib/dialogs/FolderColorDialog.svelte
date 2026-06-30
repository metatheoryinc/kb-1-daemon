<script lang="ts">
  import Button from '../button/button.svelte';
  import DialogShell from './DialogShell.svelte';
  import FolderColorPicker from '../primitives/FolderColorPicker.svelte';
  import FolderIcon from '../primitives/FolderIcon.svelte';
  import type { LocalFolderMetadata } from '../local-editor/types';

  interface Props {
    open: boolean;
    folderPath: string;
    title?: string;
    description?: string;
    previewLabel?: string;
    initial: LocalFolderMetadata | null;
    inheritedColorPreview: string;
    busy?: boolean;
    error?: string | null;
    onsubmit: (next: LocalFolderMetadata | null) => void;
    oncancel: () => void;
  }

  let {
    open,
    folderPath,
    title = 'Customize folder',
    description,
    previewLabel,
    initial,
    inheritedColorPreview,
    busy = false,
    error = null,
    onsubmit,
    oncancel,
  }: Props = $props();

  let draft = $state<LocalFolderMetadata | null>(null);

  $effect(() => {
    if (open) draft = initial;
  });

  const folderName = $derived.by(() => {
    const index = folderPath.lastIndexOf('/');
    return index === -1 ? folderPath : folderPath.slice(index + 1);
  });
  const previewName = $derived(previewLabel ?? folderName);

  const previewColor = $derived.by(() => {
    const color = draft?.color;
    return color && color !== 'inherit' ? color : inheritedColorPreview;
  });
</script>

<DialogShell
  {open}
  onclose={oncancel}
  {title}
  description={description ?? folderPath}
>
  {#snippet children()}
    <div class="preview" aria-label="Preview">
      <FolderIcon color={previewColor} size="md" variant="filled" />
      <span>{previewName}</span>
    </div>

    <FolderColorPicker
      value={draft}
      {inheritedColorPreview}
      onchange={(next) => {
        draft = next;
      }}
    />

    {#if error}
      <p class="error">{error}</p>
    {/if}
  {/snippet}

  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={oncancel} disabled={busy}>Cancel</Button>
    <Button variant="default" size="sm" onclick={() => onsubmit(draft)} disabled={busy}>
      {busy ? 'Saving...' : 'Save'}
    </Button>
  {/snippet}
</DialogShell>

<style>
  .preview {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--muted) 35%, transparent);
    padding: 8px 10px;
    font-family: var(--rd-ui);
  }

  .preview span {
    min-width: 0;
    overflow: hidden;
    color: var(--foreground);
    font-size: 14px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error {
    margin: 0;
    color: var(--destructive);
    font-family: var(--rd-ui);
    font-size: 13px;
    line-height: 1.4;
  }
</style>
