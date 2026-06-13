import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view';
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import { accentHexForId } from '@kb-2/ui';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

export type EncodedRelPos = unknown;

export interface PlaintextAwarenessCursor {
  kind: 'plaintext';
  noteId: string;
  anchor: EncodedRelPos;
  head: EncodedRelPos;
}

interface DecodedPlaintextCursor {
  noteId: string | null;
  anchor: EncodedRelPos;
  head: EncodedRelPos;
}

export interface RemotePlaintextCursor {
  clientID: number;
  userId: string | null;
  color: string;
  name: string | null;
  anchor: number;
  head: number;
}

function isDevEnvironment(): boolean {
  const meta = import.meta as ImportMeta & {
    env?: { DEV?: boolean; MODE?: string };
  };
  return meta.env?.DEV === true || meta.env?.MODE === 'development';
}

function warnMalformedPlaintextCursor(clientID: number, reason: string): void {
  if (!isDevEnvironment()) return;
  console.warn(
    `[kb-2/editor] dropped malformed plaintext awareness cursor for client ${clientID}: ${reason}`,
  );
}

export function encodePlaintextRelativePosition(
  ytext: Y.Text,
  index: number,
): EncodedRelPos {
  const clamped = Math.max(0, Math.min(index, ytext.length));
  return Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(ytext, clamped),
  );
}

export function resolvePlaintextRelativePosition(
  ytext: Y.Text,
  encoded: EncodedRelPos,
): number | null {
  const doc = ytext.doc;
  if (!doc) return null;
  let relPos: Y.RelativePosition;
  try {
    relPos = Y.createRelativePositionFromJSON(
      encoded as Parameters<typeof Y.createRelativePositionFromJSON>[0],
    );
  } catch {
    return null;
  }
  let abs: ReturnType<typeof Y.createAbsolutePositionFromRelativePosition>;
  try {
    abs = Y.createAbsolutePositionFromRelativePosition(relPos, doc);
  } catch {
    return null;
  }
  if (abs === null) return null;
  if (abs.type !== ytext) return null;
  if (!Number.isInteger(abs.index) || abs.index < 0) return null;
  return abs.index;
}

export function decodePlaintextCursor(
  raw: unknown,
): DecodedPlaintextCursor | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as {
    kind?: unknown;
    noteId?: unknown;
    anchor?: unknown;
    head?: unknown;
  };
  if (obj.kind !== 'plaintext') return null;
  if (!obj.anchor || typeof obj.anchor !== 'object') return null;
  if (!obj.head || typeof obj.head !== 'object') return null;
  return {
    noteId: typeof obj.noteId === 'string' ? obj.noteId : null,
    anchor: obj.anchor,
    head: obj.head,
  };
}

function resolvePlaintextCursor(
  ytext: Y.Text,
  encoded: { anchor: EncodedRelPos; head: EncodedRelPos },
): { anchor: number; head: number } | null {
  const anchor = resolvePlaintextRelativePosition(ytext, encoded.anchor);
  const head = resolvePlaintextRelativePosition(ytext, encoded.head);
  if (anchor === null || head === null) return null;
  return { anchor, head };
}

function focusNoteId(state: { focus?: unknown }): string | null {
  const focus = state.focus;
  if (!focus || typeof focus !== 'object') return null;
  const f = focus as { kind?: unknown; noteId?: unknown };
  if (f.kind !== 'note') return null;
  return typeof f.noteId === 'string' ? f.noteId : null;
}

export function snapshotRemotePlaintextCursors(
  awareness: Awareness,
  ytext: Y.Text,
  noteId: string,
): RemotePlaintextCursor[] {
  const rows: RemotePlaintextCursor[] = [];
  const localId = awareness.clientID;

  for (const [clientID, state] of awareness.getStates()) {
    if (clientID === localId) continue;
    const s = state as {
      user?: {
        userId?: string;
        id?: string;
        color?: string;
        name?: string;
      };
      color?: string;
      name?: string;
      cursor?: unknown;
      focus?: unknown;
    };
    const encoded = decodePlaintextCursor(s.cursor);
    if (encoded === null) continue;

    const peerNoteId = encoded.noteId ?? focusNoteId(s);
    if (peerNoteId !== noteId) continue;

    const resolved = resolvePlaintextCursor(ytext, encoded);
    if (resolved === null) {
      warnMalformedPlaintextCursor(clientID, 'relative position did not resolve');
      continue;
    }

    const userId =
      typeof s.user?.userId === 'string'
        ? s.user.userId
        : typeof s.user?.id === 'string'
          ? s.user.id
          : null;
    const name =
      typeof s.user?.name === 'string'
        ? s.user.name
        : typeof s.name === 'string'
          ? s.name
          : null;
    const color =
      typeof s.user?.color === 'string'
        ? s.user.color
        : typeof s.color === 'string'
          ? s.color
          : accentHexForId(userId ?? String(clientID));

    rows.push({
      clientID,
      userId,
      color,
      name,
      anchor: resolved.anchor,
      head: resolved.head,
    });
  }

  return rows;
}

export function plaintextCursorProducer(
  awareness: Awareness,
  ytext: Y.Text,
  noteId: string,
): Extension {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      constructor(view: EditorView) {
        this.publish(view);
      }

      update(update: ViewUpdate): void {
        if (update.selectionSet || update.docChanged) {
          this.publish(update.view);
        }
      }

      destroy(): void {
        awareness.setLocalStateField('cursor', null);
      }

      private publish(view: EditorView): void {
        const sel = view.state.selection.main;
        const payload: PlaintextAwarenessCursor = {
          kind: 'plaintext',
          noteId,
          anchor: encodePlaintextRelativePosition(ytext, sel.anchor),
          head: encodePlaintextRelativePosition(ytext, sel.head),
        };
        awareness.setLocalStateField('cursor', payload);
      }
    },
  );
}

class PlaintextCaretWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly userId: string | null,
    readonly name: string | null,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof PlaintextCaretWidget &&
      other.color === this.color &&
      other.userId === this.userId &&
      other.name === this.name
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-plaintext-peer-caret';
    el.setAttribute(
      'style',
      `position:relative;display:inline-block;width:0;border-left:2px solid ${this.color};margin-left:-1px;height:1.2em;vertical-align:text-bottom;pointer-events:none;`,
    );
    if (this.userId) el.dataset.userId = this.userId;
    if (this.name) {
      const label = document.createElement('span');
      label.className = 'cm-plaintext-peer-label';
      label.setAttribute(
        'style',
        `position:absolute;left:-2px;top:-1.4em;background:${this.color};color:white;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:500;white-space:nowrap;pointer-events:none;line-height:1.2;font-family:system-ui,sans-serif;`,
      );
      label.textContent = this.name;
      el.appendChild(label);
    }
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function buildPlaintextCursorDecorations(
  awareness: Awareness,
  ytext: Y.Text,
  docLength: number,
  noteId: string,
): DecorationSet {
  const peers = snapshotRemotePlaintextCursors(awareness, ytext, noteId);
  type DecoItem =
    | { kind: 'mark'; from: number; to: number; color: string }
    | {
        kind: 'widget';
        pos: number;
        color: string;
        userId: string | null;
        name: string | null;
      };
  const items: DecoItem[] = [];

  for (const peer of peers) {
    const anchor = Math.max(0, Math.min(peer.anchor, docLength));
    const head = Math.max(0, Math.min(peer.head, docLength));
    if (anchor !== head) {
      items.push({
        kind: 'mark',
        from: Math.min(anchor, head),
        to: Math.max(anchor, head),
        color: peer.color,
      });
    }
    items.push({
      kind: 'widget',
      pos: head,
      color: peer.color,
      userId: peer.userId,
      name: peer.name,
    });
  }

  items.sort((a, b) => {
    const aPos = a.kind === 'mark' ? a.from : a.pos;
    const bPos = b.kind === 'mark' ? b.from : b.pos;
    if (aPos !== bPos) return aPos - bPos;
    if (a.kind === 'widget' && b.kind === 'mark') return -1;
    if (a.kind === 'mark' && b.kind === 'widget') return 1;
    return 0;
  });

  const builder = new RangeSetBuilder<Decoration>();
  for (const item of items) {
    if (item.kind === 'mark') {
      builder.add(
        item.from,
        item.to,
        Decoration.mark({
          class: 'cm-plaintext-peer-selection',
          attributes: { style: `background-color: ${item.color}33;` },
        }),
      );
      continue;
    }
    builder.add(
      item.pos,
      item.pos,
      Decoration.widget({
        widget: new PlaintextCaretWidget(item.color, item.userId, item.name),
        side: 1,
      }),
    );
  }
  return builder.finish();
}

const setPlaintextCursorDecorations = StateEffect.define<DecorationSet>();

function plaintextCursorDecorationsField(
  awareness: Awareness,
  ytext: Y.Text,
  noteId: string,
): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildPlaintextCursorDecorations(
        awareness,
        ytext,
        state.doc.length,
        noteId,
      );
    },
    update(value, tr) {
      for (const effect of tr.effects) {
        if (effect.is(setPlaintextCursorDecorations)) {
          return effect.value;
        }
      }
      if (tr.docChanged) {
        return buildPlaintextCursorDecorations(
          awareness,
          ytext,
          tr.state.doc.length,
          noteId,
        );
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

export function plaintextCursorConsumer(
  awareness: Awareness,
  ytext: Y.Text,
  noteId: string,
): Extension {
  return [
    plaintextCursorDecorationsField(awareness, ytext, noteId),
    ViewPlugin.fromClass(
      class implements PluginValue {
        private off: (() => void) | null = null;

        constructor(view: EditorView) {
          let destroyed = false;
          const handler = (): void => {
            queueMicrotask(() => {
              if (destroyed) return;
              view.dispatch({
                effects: setPlaintextCursorDecorations.of(
                  buildPlaintextCursorDecorations(
                    awareness,
                    ytext,
                    view.state.doc.length,
                    noteId,
                  ),
                ),
              });
            });
          };
          awareness.on('change', handler);
          this.off = () => {
            destroyed = true;
            awareness.off('change', handler);
          };
        }

        destroy(): void {
          this.off?.();
          this.off = null;
        }
      },
    ),
  ];
}
