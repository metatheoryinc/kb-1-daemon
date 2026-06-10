<script lang="ts">
  import { FormField, FormSelect } from '../index';

  let title = $state('Local-first roadmap');
  let type = $state('note');
</script>

<div class="form-story">
  <label>
    <span>Title</span>
    <FormField bind:value={title} />
  </label>
  <label>
    <span>Type</span>
    <FormSelect
      bind:value={type}
      options={[
        { value: 'note', label: 'Note' },
        { value: 'folder', label: 'Folder' },
        { value: 'asset', label: 'Asset' }
      ]}
    />
  </label>
</div>

<style>
  .form-story {
    display: grid;
    width: min(100%, 360px);
    gap: 16px;
    padding: 32px;
  }

  label {
    display: grid;
    gap: 6px;
    color: var(--rd-ink-2);
    font-family: var(--rd-ui);
    font-size: 13px;
  }
</style>
