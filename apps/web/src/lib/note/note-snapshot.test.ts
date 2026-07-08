import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { LOCAL_DOCUMENT_TEXT_NAME } from '$lib/yjs/local-document-provider';
import type { NoteSnapshot } from './note-snapshot';
import { createNoteSnapshotDocument, snapshotFromLiveText } from './note-snapshot';

describe('note snapshot display docs', () => {
  it('seeds a read-only display document from cached snapshot content', () => {
    const snapshot = noteSnapshot({ content: '# Cached note' });
    const display = createNoteSnapshotDocument(snapshot);

    expect(display.snapshot).toBe(snapshot);
    expect(display.doc.getText(LOCAL_DOCUMENT_TEXT_NAME).toDelta()).toEqual([
      { insert: '# Cached note' },
    ]);

    display.destroy();
  });

  it('captures live Y.Text as passive snapshot data', () => {
    const doc = new Y.Doc();
    const text = doc.getText(LOCAL_DOCUMENT_TEXT_NAME);
    text.insert(0, 'Live body');
    const previous = noteSnapshot({
      version: 12,
      mtime: 10,
      content: 'Old body',
      contentType: 'text/markdown',
    });

    expect(
      snapshotFromLiveText({
        vaultId: 'demo-vault',
        path: 'a.md',
        text,
        previous,
        now: 20,
      }),
    ).toMatchObject({
      vaultId: 'demo-vault',
      path: 'a.md',
      version: 12,
      mtime: 20,
      size: 'Live body'.length,
      contentType: 'text/markdown',
      content: 'Live body',
    });

    const unchanged = noteSnapshot({
      version: 12,
      mtime: 10,
      content: 'Live body',
    });
    expect(
      snapshotFromLiveText({
        vaultId: 'demo-vault',
        path: 'a.md',
        text,
        previous: unchanged,
        now: 30,
      }),
    ).toMatchObject({
      version: 12,
      mtime: 10,
    });
  });
});

function noteSnapshot(overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    vaultId: 'demo-vault',
    path: 'note.md',
    version: 1,
    mtime: 1,
    size: overrides.content?.length ?? 0,
    contentType: 'text/markdown; charset=utf-8',
    content: '',
    ...overrides,
  };
}
