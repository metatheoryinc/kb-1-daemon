<script lang="ts" module>
  // Module-scoped stack of currently-open DialogShell instances, in
  // the order they opened. Escape should close only the topmost — the
  // previous per-instance `svelte:window` handler fired on every
  // mounted dialog, so an Escape while two dialogs were stacked would
  // close both (and, with Slice 10's return-to-popup logic, would
  // fully unmount the outer popup because its return branch had
  // already run by the time the inner handler fired).
  const openStack: symbol[] = [];
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '../utils';

  interface Props {
    open: boolean;
    onclose: () => void;
    title: string;
    description?: string;
    children: Snippet;
    footer: Snippet;
    class?: string;
  }

  let {
    open,
    onclose,
    title,
    description,
    children,
    footer,
    class: className,
  }: Props = $props();

  // Per-instance identity; unique per mounted DialogShell.
  const id = Symbol('dialog-shell');

  // Track open/close transitions on the module-level stack. The
  // cleanup removes the id when `open` flips back to false or when
  // the component unmounts.
  $effect(() => {
    if (!open) return;
    openStack.push(id);
    return () => {
      const i = openStack.lastIndexOf(id);
      if (i >= 0) openStack.splice(i, 1);
    };
  });

  function handleKey(event: KeyboardEvent): void {
    if (!open || event.key !== 'Escape') return;
    // Only the topmost open dialog responds — otherwise stacked
    // dialogs would all close on one Escape press.
    if (openStack[openStack.length - 1] !== id) return;
    event.preventDefault();
    onclose();
  }
</script>

<svelte:window onkeydown={handleKey} />

{#if open}
  <div
    class="dialog-backdrop"
    role="presentation"
  >
    <button
      type="button"
      class="dialog-dismiss"
      aria-label="Dismiss"
      onclick={onclose}
    ></button>
    <div
      class={cn('dialog-card', className)}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <header class="dialog-header">
        <h2>{title}</h2>
        {#if description}
          <p>{description}</p>
        {/if}
      </header>
      <div class="dialog-body">
        {@render children()}
      </div>
      <footer class="dialog-footer">
        {@render footer()}
      </footer>
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.4);
    padding: 16px;
  }

  .dialog-dismiss {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: none;
    background: transparent;
    cursor: default;
  }

  .dialog-card {
    position: relative;
    z-index: 10;
    display: flex;
    width: min(100%, 28rem);
    max-height: 90vh;
    flex-direction: column;
    gap: 16px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--background);
    color: var(--foreground);
    box-shadow: 0 24px 60px rgba(15, 23, 42, 0.28);
    padding: 20px;
  }

  .dialog-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .dialog-header h2 {
    margin: 0;
    font-family: var(--rd-ui);
    font-size: 16px;
    font-weight: 600;
  }

  .dialog-header p {
    margin: 0;
    color: var(--muted-foreground);
    font-family: var(--rd-ui);
    font-size: 14px;
    line-height: 1.5;
  }

  .dialog-body {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
  }

  .dialog-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
