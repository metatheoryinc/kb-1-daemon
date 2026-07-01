<script lang="ts">
  import { onMount } from 'svelte';
  import type * as Y from 'yjs';

  let { readOnly = false, ydoc, ytext } = $props<{
    readOnly?: boolean;
    ydoc?: Y.Doc;
    ytext?: Y.Text;
    attachmentSrc?: (path: string) => string;
  }>();
  let binding = $state({ docGuid: '', content: '' });

  onMount(() => {
    const stableText = ytext;
    binding = {
      docGuid: ydoc?.guid ?? '',
      content: stableText?.toString() ?? '',
    };
  });

  function updateBoundText(event: Event): void {
    const stableText = ytext;
    if (!stableText) return;
    const next = (event.currentTarget as HTMLTextAreaElement).value;
    stableText.delete(0, stableText.length);
    stableText.insert(0, next);
    binding = { ...binding, content: next };
  }
</script>

<textarea
  aria-label="Markdown editor"
  data-doc-guid={binding.docGuid}
  readonly={readOnly}
  value={binding.content}
  oninput={updateBoundText}
></textarea>
