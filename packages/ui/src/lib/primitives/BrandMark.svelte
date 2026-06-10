<script lang="ts">
  interface Props {
    size?: number;
  }

  let { size = 28 }: Props = $props();

  const radius = $derived(Math.round(size * 0.32));
  const glyph = $derived(Math.round(size * 0.64));
</script>

<span
  class="kb1-mark"
  style="width: {size}px; height: {size}px; border-radius: {radius}px;"
  aria-hidden="true"
>
  <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none">
    <path
      d="M7 4.5h10v15.2l-5-3.05-5 3.05V4.5Z"
      stroke="var(--rd-ink-2)"
      stroke-width="1.35"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</span>

<style>
  .kb1-mark {
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    background: var(--rd-panel);
    border: 1px solid var(--rd-rule-strong);
  }
</style>
