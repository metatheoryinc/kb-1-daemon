<script lang="ts">
  /**
   * Local daemon byline: metadata is still omitted until that surface exists.
   * The history affordance opens the note-scoped history panel from the route
   * shell.
   */
  interface Props {
    statusLabel?: string;
    statusTone?: "normal" | "error";
    onHistory?: () => void;
    right?: import("svelte").Snippet;
  }

  let {
    statusLabel,
    statusTone = "normal",
    onHistory,
    right,
  }: Props = $props();
</script>

<div class="strip" data-testid="document-byline">
  <div class="left">
    {#if statusLabel}
      <span class="status" class:error={statusTone === "error"}>{statusLabel}</span>
    {/if}
    {#if statusLabel && onHistory}
      <span class="sep" aria-hidden="true">·</span>
    {/if}
    {#if onHistory}
      <button type="button" class="link" onclick={onHistory}>History</button>
    {/if}
  </div>

  {#if right}
    <div class="right">
      {@render right()}
    </div>
  {/if}
</div>

<style>
  .strip {
    /* Scrolls with the document — reads as the doc's own preamble,
       not floating chrome. */

    /* `position: relative` + `z-index: 1` lifts this strip into its
       own stacking context above DocumentHeader's `border-bottom`, so
       hover popovers opened from any right-side content paint over the
       chrome rule rather than clipping under it. Same containment-context
       shape as KB-1's byline. */
    position: relative;
    z-index: 1;

    /* The wrapping `.doc-column` owns horizontal geometry; this strip
       fills it width:100%. Drop horizontal padding entirely so the
       byline text aligns flush with the editor's column-left edge. */
    padding: 32px 0 6px 0;

    display: flex;
    align-items: center;
    column-gap: 14px;

    color: var(--rd-ink-3);
    font-family: var(--rd-mono);
    font-size: 11px;
    letter-spacing: 0.02em;
  }

  .left,
  .right {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .left {
    flex: 1;
    min-width: 0;
    flex-wrap: wrap;
  }

  .right {
    flex-shrink: 0;
    margin-left: auto;
  }

  .status {
    color: var(--rd-ink-4);
  }

  .status.error {
    color: rgb(220 38 38);
  }

  .link {
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    color: var(--rd-ink-3);
    font: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }

  .link:hover {
    color: var(--rd-ink-1);
  }

  .sep {
    color: var(--rd-ink-5);
  }

  @media (max-width: 880px) {
    .strip {
      padding: 16px 0 6px;
    }
  }
</style>
