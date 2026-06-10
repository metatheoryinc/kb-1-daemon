<script lang="ts">
  import FormField from '../primitives/forms/FormField.svelte';

  let {
    value = 'Local-first roadmap',
    placeholder = 'Title',
    type = 'text',
  }: {
    value?: string;
    placeholder?: string;
    type?: 'text' | 'email' | 'password';
  } = $props();
</script>

<div class="story-pad">
  <FormField bind:value {placeholder} {type} />
</div>

<style>
  .story-pad {
    width: min(100%, 360px);
    padding: 32px;
  }
</style>
