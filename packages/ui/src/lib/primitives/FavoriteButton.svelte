<script lang="ts">
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';

  interface Props {
    favorited?: boolean;
    size?: 'sm' | 'md';
    onclick?: () => void;
  }

  let { favorited = false, size = 'md', onclick }: Props = $props();
</script>

<IconButton
  {size}
  title={favorited ? 'Remove favorite' : 'Favorite'}
  {onclick}
>
  <span class="star" class:favorited>
    <Icon name="star" size={14} weight={favorited ? 'fill' : 'regular'} />
  </span>
</IconButton>

<style>
  .star {
    display: inline-flex;
    color: var(--rd-ink-3);
  }

  .favorited {
    color: var(--rd-favorite);
  }
</style>
