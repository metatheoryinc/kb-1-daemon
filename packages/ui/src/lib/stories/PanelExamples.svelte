<script lang="ts">
  import { Badge, Button, Panel } from '../index';
</script>

<div class="panel-story">
  <Panel title="Vault health" eyebrow="Panel">
    {#snippet actions()}
      <Badge tone="success">Ready</Badge>
    {/snippet}

    <div class="panel-content">
      <p>
        This standalone panel story keeps the layout primitive visible outside
        the local status shell composition.
      </p>
      <Button variant="outline">Review details</Button>
    </div>
  </Panel>
</div>

<style>
  .panel-story {
    width: min(100%, 520px);
    padding: 36px;
  }

  .panel-content {
    display: grid;
    gap: 16px;
  }

  p {
    margin: 0;
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
    font-size: 14px;
    line-height: 1.6;
  }
</style>
