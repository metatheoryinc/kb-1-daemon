<script lang="ts">
  interface Props {
    path: string;
  }

  let { path }: Props = $props();
</script>

<section class="document-not-found" aria-label="Document not found">
  <p class="eyebrow">404</p>
  <h2>Document not found</h2>
  <p class="message">
    <code>{path}</code> does not exist in this vault.
  </p>
</section>

<style>
  .document-not-found {
    grid-column: 2;
    min-width: 0;
    min-height: 100%;
    border-left: 1px solid var(--rd-rule);
    border-right: 1px solid var(--rd-rule);
    background: var(--rd-panel);
    color: var(--rd-ink-2);
    padding: 56px 48px;
    font-family: var(--rd-ui);
  }

  .eyebrow {
    margin: 0 0 12px;
    color: var(--rd-ink-4);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  h2 {
    margin: 0 0 12px;
    color: var(--rd-ink-1);
    font-size: 28px;
    line-height: 1.15;
    font-weight: 700;
    letter-spacing: 0;
  }

  .message {
    max-width: 34rem;
    margin: 0;
    color: var(--rd-ink-3);
    font-size: 14px;
    line-height: 1.6;
  }

  code {
    border: 1px solid var(--rd-rule);
    border-radius: 5px;
    background: var(--rd-bg);
    color: var(--rd-ink-1);
    padding: 2px 5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 0.92em;
    overflow-wrap: anywhere;
  }
</style>
