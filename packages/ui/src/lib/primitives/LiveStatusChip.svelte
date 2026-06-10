<script lang="ts">
  import LiveDot from './LiveDot.svelte';

  interface Props {
    label?: string;
  }

  let { label = 'Live · saved 2s ago' }: Props = $props();
</script>

<span class="chip">
  <LiveDot />
  <span class="text">{label}</span>
</span>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 10px;
    background: var(--rd-live-bg);
    color: var(--rd-live-on);
    padding: 2px 8px 2px 6px;
  }

  .text {
    font-family: var(--rd-ui);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
</style>
