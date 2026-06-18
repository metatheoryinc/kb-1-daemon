<script lang="ts">
  import Icon from '../primitives/Icon.svelte';

  /**
   * Footer for the files rail. Holds the rail-level "New vault" affordance —
   * the only file-management action that isn't scoped to an existing vault
   * group's row menu. Prop-driven: the click is a host callback (the host
   * collects a display name and POSTs the create), so this component owns
   * no transport.
   */
  interface Props {
    /** Create a new vault. The host collects a display name and creates it. */
    onNewVault?: () => void;
  }

  let { onNewVault }: Props = $props();
</script>

<footer class="files-panel-footer">
  <button
    type="button"
    class="new-vault"
    onclick={() => onNewVault?.()}
  >
    <span class="glyph" aria-hidden="true">
      <Icon name="plus" size={14} weight="bold" />
    </span>
    <span class="label">New vault</span>
  </button>
</footer>

<style>
  .files-panel-footer {
    display: flex;
    padding: 8px;
    border-top: 1px solid var(--rd-rule);
  }

  .new-vault {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
    font-size: 12.5px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: background 80ms ease, color 80ms ease;
  }

  .new-vault:hover {
    background: var(--rd-hover);
    color: var(--rd-ink-1);
  }

  .new-vault:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--rd-ink-3) 40%, transparent);
    outline-offset: -2px;
  }

  .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    color: var(--rd-ink-3);
  }

  .label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
