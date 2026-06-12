<script lang="ts">
  let { readOnly = false } = $props<{ readOnly?: boolean }>();
</script>

<textarea aria-label="Markdown editor" {readOnly}>Fixture editor</textarea>
