<script lang="ts">
  import Icon from '../../primitives/Icon.svelte';

  interface Props {
    /** Display label for the local identity. Static — there is no user
        model, auth, or sign-out behind it; the chip is presentation only. */
    label?: string;
    /** When collapsed, the rail is icon-only: the label fades out and the
        chip shows just the user glyph centered. */
    collapsed?: boolean;
  }

  let { label = 'Local user', collapsed = false }: Props = $props();
</script>

<div class="user-chip" class:collapsed title={label} aria-label={label}>
  <span class="lead">
    <Icon name="user" size={20} />
  </span>
  <span class="info">
    <span class="name">{label}</span>
  </span>
</div>

<style>
  .user-chip {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    width: 100%;
    /* Reserve the full chip height so the frame is stable across the
       collapse transition. 44px = 26px content row + 16px vertical
       padding + 2px border under box-sizing: border-box. */
    min-height: 44px;
    margin-top: 10px;
    /* Constant padding so the 20px glyph lands at the rail's center when
       collapsed: 10 (body) + 1 (border) + 8 (padding) + 10 (glyph half) =
       29 ≈ rail center, matching the nav icons' optical column. */
    padding: 8px;
    border: 1px solid var(--rd-rule);
    border-radius: 10px;
    background: var(--rd-panel);
    color: var(--rd-ink-2);
    transition: gap var(--rd-rail-duration) var(--rd-rail-ease);
  }

  /* Keep border + background in both states — the chip is always a chrome
     box; collapsed just hides the info column inside. This avoids any
     vertical jump that would happen if the border or padding changed. */
  .user-chip.collapsed {
    gap: 0;
  }

  .lead {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    /* 26px matches the avatar footprint the nav icons optically align to. */
    width: 26px;
    height: 26px;
    color: var(--rd-ink-2);
  }

  /* Info uses the same fade pattern as nav-item labels: opacity goes to 0
     when collapsed, element stays in flex flow so the chip height is
     unchanged. */
  .info {
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    height: 26px;
    min-width: 0;
    overflow: hidden;
    line-height: 1.15;
    opacity: 1;
    transition: opacity var(--rd-rail-duration) var(--rd-rail-ease);
  }

  .user-chip.collapsed .info {
    opacity: 0;
    pointer-events: none;
  }

  .name {
    white-space: nowrap;
    color: var(--rd-ink-1);
    font-family: var(--rd-ui);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
</style>
