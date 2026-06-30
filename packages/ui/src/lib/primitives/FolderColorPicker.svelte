<script lang="ts" module>
  import type { LocalFolderMetadata } from '../local-editor/types';

  export interface FolderColorPickerProps {
    value: LocalFolderMetadata | null;
    onchange: (next: LocalFolderMetadata | null) => void;
    inheritedColorPreview?: string | null;
  }
</script>

<script lang="ts">
  import FolderIcon from './FolderIcon.svelte';
  import { isValidHexColor, normalizeHex } from './color-utils';
  import { PASTEL_PALETTE } from './palette';

  let { value, onchange, inheritedColorPreview = null }: FolderColorPickerProps = $props();

  const currentColor = $derived(value?.color ?? 'inherit');

  let hexDraft = $state('');

  $effect(() => {
    hexDraft = currentColor && currentColor !== 'inherit' ? currentColor : '';
  });

  const hexPreview = $derived.by(() => {
    const trimmed = hexDraft.trim();
    if (trimmed === '') return null;
    const candidate = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    return isValidHexColor(candidate) ? normalizeHex(candidate) : null;
  });

  function commit(next: { color?: string }): void {
    const merged: LocalFolderMetadata = {};
    if (value?.color !== undefined) merged.color = value.color;
    if (next.color !== undefined) {
      if (next.color === '' || next.color === 'inherit') delete merged.color;
      else merged.color = next.color;
    }
    const hasAnything = merged.color !== undefined;
    onchange(hasAnything ? merged : null);
  }

  function selectInherit(): void {
    commit({ color: 'inherit' });
  }

  function selectColor(hex: string): void {
    commit({ color: hex });
  }

  function commitHexDraft(): void {
    if (hexPreview) commit({ color: hexPreview });
  }

  function handleHexKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitHexDraft();
  }
</script>

<div class="folder-color-picker">
  <fieldset>
    <legend>Color</legend>
    <button
      type="button"
      class="inherit-chip"
      class:selected={currentColor === 'inherit'}
      aria-pressed={currentColor === 'inherit'}
      onclick={selectInherit}
    >
      <FolderIcon color={inheritedColorPreview} size="md" />
      <span>Inherit</span>
    </button>

    <ul class="swatch-grid">
      {#each PASTEL_PALETTE as swatch (swatch.color)}
        {@const isSelected = currentColor !== 'inherit' && currentColor.toLowerCase() === swatch.color.toLowerCase()}
        <li>
          <button
            type="button"
            aria-label={swatch.name}
            aria-pressed={isSelected}
            class="swatch-button"
            class:selected={isSelected}
            onclick={() => selectColor(swatch.color)}
          >
            <FolderIcon color={swatch.color} size="lg" label={swatch.name} />
          </button>
        </li>
      {/each}
    </ul>

    <label class="input-row">
      <span>Hex</span>
      <input
        type="text"
        placeholder="#a7f3d0"
        bind:value={hexDraft}
        onkeydown={handleHexKey}
        onblur={commitHexDraft}
      />
      <span class="input-preview" aria-hidden="true">
        <FolderIcon color={hexPreview} size="lg" />
      </span>
    </label>
  </fieldset>

</div>

<style>
  .folder-color-picker {
    display: flex;
    flex-direction: column;
    gap: 20px;
    font-family: var(--rd-ui);
  }

  fieldset {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 12px;
    margin: 0;
    border: 0;
    padding: 0;
  }

  legend {
    margin: 0;
    padding: 0;
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .inherit-chip,
  .swatch-button {
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--foreground);
    cursor: pointer;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  .inherit-chip:focus-visible,
  .swatch-button:focus-visible,
  input:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--ring) 55%, transparent);
    outline-offset: 2px;
  }

  .inherit-chip {
    display: inline-flex;
    width: fit-content;
    align-items: center;
    gap: 8px;
    border-style: dashed;
    border-color: var(--border);
    padding: 6px 8px;
    font-size: 14px;
    text-align: left;
  }

  .inherit-chip:hover,
  .swatch-button:hover {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  .selected {
    box-shadow:
      0 0 0 2px var(--ring),
      0 0 0 4px var(--background);
  }

  .swatch-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .swatch-button {
    display: inline-flex;
    width: 32px;
    height: 32px;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .input-row {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
    color: var(--muted-foreground);
    font-size: 14px;
  }

  .input-row input {
    min-width: 0;
    flex: 1;
    border: 1px solid var(--input);
    border-radius: 6px;
    background: var(--background);
    color: var(--foreground);
    padding: 6px 8px;
    font: inherit;
  }

  .input-row input[type='text'] {
    font-family: var(--rd-ui);
  }

  .input-row:first-of-type input {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  }

  .input-preview {
    display: inline-flex;
    width: 32px;
    height: 32px;
    align-items: center;
    justify-content: center;
  }

</style>
