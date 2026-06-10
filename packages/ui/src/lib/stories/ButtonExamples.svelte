<script lang="ts">
  import { Button, Icon } from '../index';
</script>

<div class="story-surface">
  <Button>Default</Button>
  <Button variant="secondary">Secondary</Button>
  <Button variant="outline">Outline</Button>
  <Button variant="ghost">Ghost</Button>
  <Button variant="destructive">Delete</Button>
  <Button variant="link" href="/">Read docs</Button>
  <Button size="icon" aria-label="Create">
    <Icon name="plus" size={16} />
  </Button>
</div>

<style>
  .story-surface {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: 32px;
  }
</style>
