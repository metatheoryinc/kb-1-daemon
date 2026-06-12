<script lang="ts">
  let { readOnly = false } = $props<{ readOnly?: boolean }>();
</script>

<textarea aria-label="Markdown editor" readonly={readOnly}>Fixture editor</textarea>
