<script lang="ts">
  import { PlaintextEditor } from '@kb-2/editor';
  import * as Y from 'yjs';

  const doc = new Y.Doc();
  const text = doc.getText('markdown');
  text.insert(
    0,
    [
      '# KB-2 Editor Fixture',
      '',
      'This **Markdown** editor renders _live preview_ decorations while preserving source editing.',
      '',
      '- [ ] Clickable task',
      '- [x] Completed task',
      '  - Nested item',
      '',
      '> Local-first content is the product boundary.',
      '',
      '| Feature | State |',
      '| --- | --- |',
      '| Yjs | synced |',
      '| Markdown | live preview |',
      '',
      '```ts',
      'const localFirst = true;',
      '```',
      '',
      'Mention chip: [Yoh](mention:yoh@example.com)',
      '',
      'Wikilink: [[hello-world]]',
      '',
    ].join('\n'),
  );

  const livePaths = [{ path: 'demo-vault/hello-world.md', noteId: 'demo-document' }];
  const orgPeople = [
    {
      id: 'demo-yoh',
      email: 'yoh@example.com',
      name: 'Yoh',
      image: null,
    },
  ];
</script>

<div class="story">
  <PlaintextEditor ydoc={doc} ytext={text} {livePaths} {orgPeople} />
</div>

<style>
  .story {
    height: 720px;
    max-width: 760px;
    margin: 0 auto;
    border-left: 1px solid var(--rd-rule);
    border-right: 1px solid var(--rd-rule);
    background: var(--rd-panel);
  }
</style>

