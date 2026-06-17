<script lang="ts">
  import Icon from '../primitives/Icon.svelte';
</script>

<aside class="starred-panel" aria-label="Starred">
  <header class="head">
    <h2 class="title">Starred</h2>
    <p class="hint">Pinned notes and folders</p>
  </header>

  <div class="body">
    <div class="empty">
      <span class="empty-icon" aria-hidden="true">
        <Icon name="star" size={22} weight="regular" />
      </span>
      <p class="empty-title">No starred items yet</p>
      <p class="empty-hint">
        Star a note or folder to see it here.
      </p>
    </div>
  </div>
</aside>

<style>
  .starred-panel {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    background: var(--rd-panel);
    border-right: 1px solid var(--rd-rule);
    color: var(--rd-ink-1);
    font-family: var(--rd-ui);
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 18px 18px 14px;
    border-bottom: 1px solid var(--rd-rule);
  }

  .title {
    margin: 0;
    color: var(--rd-ink-1);
    font-size: 14.5px;
    font-weight: 600;
    letter-spacing: -0.015em;
  }

  .hint {
    margin: 0;
    color: var(--rd-ink-4);
    font-size: 11.5px;
  }

  .body {
    min-height: 0;
    overflow-y: auto;
    padding: 10px 10px 14px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 40px 16px;
    color: var(--rd-ink-4);
  }

  .empty-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    margin-bottom: 10px;
    border-radius: 12px;
    background: var(--rd-hover);
    color: var(--rd-ink-3);
  }

  .empty-title {
    margin: 0 0 2px;
    color: var(--rd-ink-2);
    font-size: 14px;
    font-weight: 500;
    letter-spacing: -0.005em;
  }

  .empty-hint {
    margin: 0;
    max-width: 220px;
    font-size: 11.5px;
    line-height: 1.4;
  }
</style>
