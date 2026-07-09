<script lang="ts">
  import Button from '../button/button.svelte';
  import { cn } from '../utils';
  import DialogShell from './DialogShell.svelte';

  interface Props {
    open: boolean;
    title: string;
    description?: string;
    folderPaths: string[];
    currentParent: string;
    submitLabel?: string;
    busy?: boolean;
    error?: string | null;
    onsubmit: (folderPath: string) => void;
    oncancel: () => void;
  }

  let {
    open,
    title,
    description,
    folderPaths,
    currentParent,
    submitLabel = 'Move',
    busy = false,
    error = null,
    onsubmit,
    oncancel,
  }: Props = $props();

  let selected = $state<string | null>(null);

  $effect(() => {
    if (open) selected = null;
  });

  const sortedPaths = $derived(
    [...folderPaths].sort((a, b) => a.localeCompare(b)),
  );
  const canSubmit = $derived(selected !== null && selected !== currentParent);
</script>

<DialogShell {open} onclose={oncancel} {title} {description}>
  {#snippet children()}
    <ul class="move-list">
      <li>
        <button
          type="button"
          class={cn(
            'move-option',
            selected === '' && 'selected',
            currentParent === '' && 'current',
          )}
          aria-current={currentParent === '' ? 'location' : undefined}
          onclick={() => (selected = '')}
        >
          <span class="move-label">Vault root</span>
          {#if currentParent === ''}
            <span class="move-current">Current</span>
          {/if}
        </button>
      </li>
      {#each sortedPaths as path (path)}
        <li>
          <button
            type="button"
            class={cn(
              'move-option',
              selected === path && 'selected',
              currentParent === path && 'current',
            )}
            aria-current={currentParent === path ? 'location' : undefined}
            onclick={() => (selected = path)}
          >
            <span class="move-label">{path}</span>
            {#if currentParent === path}
              <span class="move-current">Current</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
    {#if error}
      <p class="dialog-error">{error}</p>
    {/if}
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" size="sm" onclick={oncancel} disabled={busy}>
      Cancel
    </Button>
    <Button
      size="sm"
      onclick={() => {
        const destination = selected;
        if (destination === null || destination === currentParent) return;
        onsubmit(destination);
      }}
      disabled={busy || !canSubmit}
    >
      {busy ? 'Working…' : submitLabel}
    </Button>
  {/snippet}
</DialogShell>

<style>
  .move-list {
    display: flex;
    flex-direction: column;
    max-height: 50vh;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  .move-list li + li .move-option {
    border-top: 1px solid var(--border);
  }

  .move-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: transparent;
    color: var(--foreground);
    padding: 8px 12px;
    font-family: var(--rd-ui);
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }

  .move-option:hover {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  .move-option.selected {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  .move-option.current:not(.selected) {
    color: var(--muted-foreground);
  }

  .move-option:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--ring) 50%, transparent);
    outline-offset: -2px;
  }

  .move-label {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .move-current {
    flex-shrink: 0;
    color: inherit;
    font-family: var(--rd-mono);
    font-size: 11px;
    opacity: 0.72;
  }

  .dialog-error {
    margin: 0;
    color: var(--destructive);
    font-family: var(--rd-ui);
    font-size: 14px;
  }
</style>
