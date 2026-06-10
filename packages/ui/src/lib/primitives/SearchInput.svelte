<script lang="ts">
  import Icon from './Icon.svelte';

  interface Props {
    value?: string;
    placeholder?: string;
    autofocus?: boolean;
    onInput?: (value: string) => void;
    onClear?: () => void;
    /** Imperative ref hook — fires with the underlying `<input>` once
        mounted (and `undefined` on unmount). Lets the parent focus the
        input on Cmd+F without binding through every intermediate
        component. */
    inputRef?: (el: HTMLInputElement | undefined) => void;
  }

  let {
    value = $bindable(''),
    placeholder = 'Search files, folders, vaults…',
    autofocus = false,
    onInput,
    onClear,
    inputRef,
  }: Props = $props();

  let inputEl: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (autofocus && inputEl) inputEl.focus();
  });

  $effect(() => {
    inputRef?.(inputEl);
    return () => inputRef?.(undefined);
  });

  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement;
    value = target.value;
    onInput?.(target.value);
  }

  function clear() {
    value = '';
    onClear?.();
    inputEl?.focus();
  }
</script>

<div class="search-input" class:has-value={value.length > 0}>
  <span class="lead">
    <Icon name="search" size={13} />
  </span>
  <input
    bind:this={inputEl}
    type="text"
    {value}
    {placeholder}
    spellcheck="false"
    autocomplete="off"
    autocorrect="off"
    oninput={handleInput}
  />
  {#if value.length > 0}
    <button
      type="button"
      class="clear"
      title="Clear search"
      aria-label="Clear search"
      onclick={clear}
    >
      <Icon name="x" size={11} />
    </button>
  {/if}
</div>

<style>
  .search-input {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 10px;
    background: var(--rd-panel-alt);
    border: 1px solid var(--rd-rule);
    border-radius: 8px;
    transition: border-color 80ms ease, background 80ms ease;
  }

  .search-input:focus-within {
    border-color: var(--rd-rule-strong);
    background: var(--rd-panel);
  }

  .lead {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--rd-ink-3);
  }

  input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--rd-ink-1);
    font-family: var(--rd-ui);
    font-size: 12px;
    outline: none;
  }

  input::placeholder {
    color: var(--rd-ink-4);
  }

  .clear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--rd-ink-3);
    cursor: pointer;
    transition: background 80ms ease, color 80ms ease;
  }

  .clear:hover {
    background: var(--rd-hover);
    color: var(--rd-ink-1);
  }
</style>
