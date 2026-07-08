import * as Y from 'yjs';

import { DEMO_DOCUMENT_TEXT_NAME } from '$lib/yjs/demo-document-provider';

export interface NoteSnapshot {
  vaultId: string;
  path: string;
  version: number;
  mtime: number;
  size: number;
  contentType: string;
  content: string;
}

export interface NoteSnapshotDocument {
  snapshot: NoteSnapshot;
  doc: Y.Doc;
  text: Y.Text;
  destroy: () => void;
}

export function createNoteSnapshotDocument(snapshot: NoteSnapshot): NoteSnapshotDocument {
  const doc = new Y.Doc();
  const text = doc.getText(DEMO_DOCUMENT_TEXT_NAME);
  text.insert(0, snapshot.content);

  return {
    snapshot,
    doc,
    text,
    destroy: () => {
      doc.destroy();
    },
  };
}

export function snapshotFromLiveText(args: {
  vaultId: string;
  path: string;
  text: Y.Text;
  previous?: NoteSnapshot | null;
  now?: number;
}): NoteSnapshot {
  const content = yTextContent(args.text);
  const now = args.now ?? Date.now();
  const contentChanged = args.previous?.content !== content;

  return {
    vaultId: args.vaultId,
    path: args.path,
    version: args.previous?.version ?? now,
    mtime: contentChanged ? now : (args.previous?.mtime ?? now),
    size: new TextEncoder().encode(content).byteLength,
    contentType: args.previous?.contentType ?? 'text/markdown; charset=utf-8',
    content,
  };
}

function yTextContent(text: Y.Text): string {
  const delta = text.toDelta() as { insert?: unknown }[];
  return delta
    .map((entry) => (typeof entry.insert === 'string' ? entry.insert : ''))
    .join('');
}
