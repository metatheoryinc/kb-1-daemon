<script lang="ts">
  import SearchInput from '../primitives/SearchInput.svelte';

  let {
    value = 'filesystem',
    placeholder = 'Search files, folders, vaults...',
  }: {
    value?: string;
    placeholder?: string;
  } = $props();
</script>

<div class="story-pad">
  <SearchInput bind:value {placeholder} />
</div>

<style>
  .story-pad {
    width: min(100%, 360px);
    padding: 32px;
  }
</style>
