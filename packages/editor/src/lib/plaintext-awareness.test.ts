import { describe, expect, it } from 'vitest';
import type { DecorationSet } from '@codemirror/view';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  buildPlaintextCursorDecorations,
  encodePlaintextRelativePosition,
  resolvePlaintextRelativePosition,
  snapshotRemotePlaintextCursors,
  type PlaintextAwarenessCursor,
} from './plaintext-awareness';

function seedDoc(text: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText('markdown');
  ytext.insert(0, text);
  return { doc, ytext };
}

function syncedPeer(initial: string) {
  const local = seedDoc(initial);
  const remoteDoc = new Y.Doc();
  Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(local.doc));
  const remoteText = remoteDoc.getText('markdown');
  const localAwareness = new Awareness(local.doc);
  const remoteAwareness = new Awareness(remoteDoc);
  remoteAwareness.setLocalStateField('user', {
    userId: 'peer-1',
    name: 'Peer One',
    color: '#3366ff',
  });
  return { ...local, localAwareness, remoteDoc, remoteText, remoteAwareness };
}

function applyRemoteAwareness(
  localAwareness: Awareness,
  remoteAwareness: Awareness,
): void {
  applyAwarenessUpdate(
    localAwareness,
    encodeAwarenessUpdate(remoteAwareness, [remoteAwareness.clientID]),
    'test',
  );
}

function publishRemoteCursor(args: {
  localAwareness: Awareness;
  remoteAwareness: Awareness;
  remoteText: Y.Text;
  noteId: string;
  anchor: number;
  head: number;
}): void {
  const cursor: PlaintextAwarenessCursor = {
    kind: 'plaintext',
    noteId: args.noteId,
    anchor: encodePlaintextRelativePosition(args.remoteText, args.anchor),
    head: encodePlaintextRelativePosition(args.remoteText, args.head),
  };
  args.remoteAwareness.setLocalStateField('cursor', cursor);
  applyRemoteAwareness(args.localAwareness, args.remoteAwareness);
}

function decorationRanges(decos: DecorationSet): {
  from: number;
  to: number;
  className: string | undefined;
  hasWidget: boolean;
}[] {
  const ranges: {
    from: number;
    to: number;
    className: string | undefined;
    hasWidget: boolean;
  }[] = [];
  const cursor = decos.iter();
  while (cursor.value !== null) {
    const spec = cursor.value.spec as {
      class?: string;
      widget?: unknown;
    };
    ranges.push({
      from: cursor.from,
      to: cursor.to,
      className: spec.class,
      hasWidget: spec.widget !== undefined,
    });
    cursor.next();
  }
  return ranges;
}

describe('plaintext awareness relative positions', () => {
  it('round-trips a Y.RelativePosition through JSON against a real Y.Text', () => {
    const { ytext } = seedDoc('abcdef');
    const encoded = encodePlaintextRelativePosition(ytext, 3);

    expect(resolvePlaintextRelativePosition(ytext, encoded)).toBe(3);
  });

  it('keeps a remote caret anchored to the same logical character after an insert before it', () => {
    const ctx = syncedPeer('abcdef');
    publishRemoteCursor({
      localAwareness: ctx.localAwareness,
      remoteAwareness: ctx.remoteAwareness,
      remoteText: ctx.remoteText,
      noteId: 'note-a',
      anchor: 3,
      head: 3,
    });

    ctx.ytext.insert(0, 'XYZ');

    const peers = snapshotRemotePlaintextCursors(
      ctx.localAwareness,
      ctx.ytext,
      'note-a',
    );
    expect(peers).toHaveLength(1);
    expect(peers[0]?.head).toBe(6);
    expect(ctx.ytext.toString()[peers[0]?.head ?? -1]).toBe('d');

    const decos = buildPlaintextCursorDecorations(
      ctx.localAwareness,
      ctx.ytext,
      ctx.ytext.length,
      'note-a',
    );
    expect(decorationRanges(decos)).toEqual([
      {
        from: 6,
        to: 6,
        className: undefined,
        hasWidget: true,
      },
    ]);
  });

  it('renders a translucent selection mark plus a caret widget for a remote range', () => {
    const ctx = syncedPeer('abcdef');
    publishRemoteCursor({
      localAwareness: ctx.localAwareness,
      remoteAwareness: ctx.remoteAwareness,
      remoteText: ctx.remoteText,
      noteId: 'note-a',
      anchor: 2,
      head: 5,
    });

    const decos = buildPlaintextCursorDecorations(
      ctx.localAwareness,
      ctx.ytext,
      ctx.ytext.length,
      'note-a',
    );

    expect(decorationRanges(decos)).toEqual([
      {
        from: 2,
        to: 5,
        className: 'cm-plaintext-peer-selection',
        hasWidget: false,
      },
      {
        from: 5,
        to: 5,
        className: undefined,
        hasWidget: true,
      },
    ]);
  });

  it('filters remote plaintext cursors by noteId', () => {
    const ctx = syncedPeer('abcdef');
    publishRemoteCursor({
      localAwareness: ctx.localAwareness,
      remoteAwareness: ctx.remoteAwareness,
      remoteText: ctx.remoteText,
      noteId: 'note-b',
      anchor: 3,
      head: 3,
    });

    expect(
      snapshotRemotePlaintextCursors(ctx.localAwareness, ctx.ytext, 'note-a'),
    ).toEqual([]);
    expect(
      snapshotRemotePlaintextCursors(ctx.localAwareness, ctx.ytext, 'note-b'),
    ).toHaveLength(1);
  });

  it('drops a malformed remote RelPos without throwing', () => {
    const ctx = syncedPeer('abcdef');
    ctx.remoteAwareness.setLocalStateField('cursor', {
      kind: 'plaintext',
      noteId: 'note-a',
      anchor: { malformed: true },
      head: encodePlaintextRelativePosition(ctx.remoteText, 3),
    });
    applyRemoteAwareness(ctx.localAwareness, ctx.remoteAwareness);

    expect(() =>
      buildPlaintextCursorDecorations(
        ctx.localAwareness,
        ctx.ytext,
        ctx.ytext.length,
        'note-a',
      ),
    ).not.toThrow();
    expect(
      snapshotRemotePlaintextCursors(ctx.localAwareness, ctx.ytext, 'note-a'),
    ).toEqual([]);
  });
});
