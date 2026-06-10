<script lang="ts">
  import FormSelect from '../primitives/forms/FormSelect.svelte';

  let value = $state('note');
</script>

<div class="story-pad">
  <FormSelect
    bind:value
    options={[
      { value: 'note', label: 'Note' },
      { value: 'folder', label: 'Folder' },
      { value: 'asset', label: 'Asset' }
    ]}
  />
</div>

<style>
  .story-pad {
    width: min(100%, 360px);
    padding: 32px;
  }
</style>
