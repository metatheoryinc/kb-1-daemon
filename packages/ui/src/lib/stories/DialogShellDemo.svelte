<script lang="ts">
  import { Button, DialogShell } from '../index';

  let { open = true }: { open?: boolean } = $props();
</script>

<div class="story-pad">
  <Button onclick={() => (open = true)}>Open dialog</Button>
</div>

<DialogShell
  {open}
  title="Rename file"
  description="Dialog shell story with static content."
  onclose={() => (open = false)}
>
  {#snippet children()}
    <p class="copy">Fixture-backed dialog content with no daemon dependency.</p>
  {/snippet}
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    <Button onclick={() => (open = false)}>Save</Button>
  {/snippet}
</DialogShell>

<style>
  .story-pad {
    padding: 32px;
  }

  .copy {
    margin: 0;
    font-family: var(--rd-ui);
    font-size: 14px;
  }
</style>
