<script lang="ts">
  import Icon from '../primitives/Icon.svelte';
  import IconButton from '../primitives/IconButton.svelte';
  import type { IconName } from '../primitives/types';

  let {
    icon = 'refresh',
    size = 'md',
    variant = 'quiet',
    label: labelText = '',
  }: {
    icon?: IconName;
    size?: 'sm' | 'md' | 'lg';
    variant?: 'quiet' | 'active' | 'outlined';
    label?: string;
  } = $props();
</script>

<div class="story-pad">
  {#if labelText}
    <IconButton {size} {variant} title="Icon action">
      {#snippet label()}
        {labelText}
      {/snippet}
      <Icon name={icon} />
    </IconButton>
  {:else}
    <IconButton {size} {variant} title="Icon action">
      <Icon name={icon} />
    </IconButton>
  {/if}
</div>

<style>
  .story-pad {
    padding: 32px;
  }
</style>
