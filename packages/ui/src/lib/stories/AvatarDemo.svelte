<script lang="ts">
  import Avatar from '../primitives/Avatar.svelte';
  import type { AccentName } from '../primitives/accent';
  import type { IconName } from '../primitives/types';

  let {
    kind = 'human',
    accent = 'coral',
    size = 36,
    letter = 'K',
    brand = 'codex',
    tone = undefined,
  }: {
    kind?: 'human' | 'agent' | 'org' | 'folder' | 'file';
    accent?: AccentName;
    size?: number;
    letter?: string;
    brand?: IconName;
    tone?: 'soft' | 'pastel';
  } = $props();
</script>

<div class="story-pad">
  <Avatar {kind} {accent} {size} {letter} {brand} {tone} title="Story avatar" />
</div>

<style>
  .story-pad {
    padding: 32px;
  }
</style>
