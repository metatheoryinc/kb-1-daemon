<script lang="ts">
  interface Props {
    size?: number;
    color?: string;
    pulse?: boolean;
    title?: string;
  }

  let { size = 6, color = 'var(--rd-live)', pulse = true, title }: Props = $props();
</script>

<span
  class="live-dot"
  class:pulse
  style="width: {size}px; height: {size}px; background: {color};"
  role={title ? 'img' : undefined}
  aria-label={title}
></span>

<style>
  .live-dot {
    display: inline-block;
    flex-shrink: 0;
    border-radius: 50%;
  }

  .pulse {
    animation: rd-pulse 1.6s ease-in-out infinite;
  }

  @keyframes rd-pulse {
    0%,
    100% {
      opacity: 0.55;
      transform: scale(0.9);
    }
    50% {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
