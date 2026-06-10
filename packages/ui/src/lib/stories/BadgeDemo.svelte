<script lang="ts">
  import Badge from '../primitives/Badge.svelte';

  let {
    label = 'Online',
    tone = 'success',
  }: {
    label?: string;
    tone?: 'neutral' | 'success' | 'danger' | 'live';
  } = $props();
</script>

<div class="story-pad">
  <Badge {tone}>{label}</Badge>
</div>

<style>
  .story-pad {
    padding: 32px;
  }
</style>
