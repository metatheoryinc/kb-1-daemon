/**
 * Plaintext awareness — remote-cursor producer/consumer + CM6 wiring.
 *
 * The editor is shared by hosts with and without presence support, so the
 * producer/consumer are mounted only when the host supplies an `awareness` +
 * `noteId` (both optional props on PlaintextEditor). The daemon UI has no
 * presence and never mounts them.
 *
 * RECONCILIATIONS vs the KB-1 source (faithful ports, not invention):
 *   1. noteId placement. KB-1 carried `noteId` only on `awareness.focus`
 *      (`{kind:'note', path, noteId}`) and the cursor payload was
 *      `{kind:'plaintext', anchor, head}`; the snapshot filtered peers by
 *      `focus.noteId`. The presence wire schema puts `noteId` INSIDE the cursor
 *      payload (`{kind, noteId, anchor, head}`), and the awareness bridge
 *      fabricates remote `cursor` (not `focus`) from the presence roster. So the
 *      producer EMBEDS `noteId` in the payload and the snapshot FILTERS on
 *      `cursor.noteId === noteId`. Same logical gate, relocated to where the
 *      transport carries it.
 *   2. accent color helper. KB-1 used `@kb-1/core`'s `accentHexForId`; the
 *      cloud/daemon-shared editor uses `@kb-1/ui`'s `accentHexForId` (a faithful
 *      copy of the same deterministic hash + palette).
 *   3. humans-only. The cloud presence actor schema is human-shaped (no
 *      `agentIntegration`); the agent-chip / robot-glyph rendering from the
 *      KB-1 caret widget is dropped (cloud presence carries no agents). The
 *      caret renders a single human label.
 *
 * Why `Y.RelativePosition` and not a bare offset: under concurrent splices
 * between send-time and receive-time, a bare numeric offset would visibly lie.
 * `Y.RelativePosition` resolves against the live doc each time, anchoring to a
 * stable logical position.
 */

import {
  ViewPlugin,
  Decoration,
  WidgetType,
  EditorView,
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
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { accentHexForId } from '@kb-1/ui';

/**
 * JSON-encoded `Y.RelativePosition`. Same shape `Y.relativePositionToJSON`
 * emits and `Y.createRelativePositionFromJSON` accepts. Typed as `unknown` at
 * the wire boundary because the library returns `any`; every consumer narrows
 * defensively before use.
 */
export type EncodedRelPos = unknown;

/**
 * The discriminated awareness `cursor` payload: `noteId` lives IN
 * the payload (see RECONCILIATION #1). `anchor === head` means a caret;
 * otherwise the selection extends between the two (with `head` the moving end,
 * the same contract CM6's `EditorSelection.main` exposes). This mirrors the
 * presence cursor schema.
 */
export interface PlaintextAwarenessCursor {
  kind: 'plaintext';
  noteId: string;
  anchor: EncodedRelPos;
  head: EncodedRelPos;
}

/** Back-compat alias for the discriminated cursor type. */
export type AwarenessCursor = PlaintextAwarenessCursor;

/**
 * Encode an absolute CM offset into a note's `Y.Text` as a JSON-encoded
 * `Y.RelativePosition`. The form the producer emits and tests build payloads
 * with. Clamps into the live ytext length so a racing publish never builds a
 * RelPos past the end.
 */
export function encodePlaintextRelativePosition(
  ytext: Y.Text,
  index: number,
): EncodedRelPos {
  const len = ytext.length;
  const clamped = Math.max(0, Math.min(index, len));
  return Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(ytext, clamped),
  );
}

/**
 * Narrow an arbitrary awareness `cursor` blob to the plaintext arm and return
 * its `{ noteId, anchor, head }`, or `null` for any other shape — non-plaintext
 * cursors, malformed values, `null`. Resolution to absolute CM offsets happens
 * in the caller via `resolvePlaintextCursor` once a `Y.Text` is available.
 *
 * Exported so substrate-contract tests can exercise the same discriminator the
 * runtime uses.
 */
export function decodePlaintextCursor(
  raw: unknown,
): { noteId: string; anchor: EncodedRelPos; head: EncodedRelPos } | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as {
    kind?: unknown;
    noteId?: unknown;
    anchor?: unknown;
    head?: unknown;
  };
  if (obj.kind !== 'plaintext') return null;
  if (typeof obj.noteId !== 'string' || obj.noteId.length === 0) return null;
  // Both anchor and head must be present and object-shaped (RelPos JSON is
  // always an object). A primitive or `null` is a malformed payload we drop.
  if (!obj.anchor || typeof obj.anchor !== 'object') return null;
  if (!obj.head || typeof obj.head !== 'object') return null;
  return { noteId: obj.noteId, anchor: obj.anchor, head: obj.head };
}

/**
 * Resolve a decoded plaintext cursor (JSON-encoded RelPos pair) to absolute CM
 * offsets against the bound `Y.Text`. Returns `null` if either end fails to
 * resolve — e.g. the RelPos was built against a different doc, or both
 * endpoints have been GC'd.
 */
function resolvePlaintextCursor(
  ytext: Y.Text,
  encoded: { anchor: EncodedRelPos; head: EncodedRelPos },
): { anchor: number; head: number } | null {
  const doc = ytext.doc;
  if (!doc) return null;
  // The whole RelPos round-trip is wrapped: `createRelativePositionFromJSON`
  // accepts any object (a malformed `{ malformed: true }` decodes to a RelPos
  // with undefined internals), and the failure only surfaces inside
  // `createAbsolutePositionFromRelativePosition` as a lib0 "Unexpected case"
  // throw. The cloud bridge synthesizes remote awareness states from untrusted
  // presence payloads, so resolution MUST be non-fatal (pinned by the
  // "keeps malformed remote cursor payloads non-fatal" cloud test) — a wider
  // catch than KB-1's, justified by the cloud's untrusted-remote-state seam.
  let anchorAbs: ReturnType<typeof Y.createAbsolutePositionFromRelativePosition>;
  let headAbs: ReturnType<typeof Y.createAbsolutePositionFromRelativePosition>;
  try {
    const anchorRel = Y.createRelativePositionFromJSON(
      encoded.anchor as Parameters<typeof Y.createRelativePositionFromJSON>[0],
    );
    const headRel = Y.createRelativePositionFromJSON(
      encoded.head as Parameters<typeof Y.createRelativePositionFromJSON>[0],
    );
    anchorAbs = Y.createAbsolutePositionFromRelativePosition(anchorRel, doc);
    headAbs = Y.createAbsolutePositionFromRelativePosition(headRel, doc);
  } catch {
    return null;
  }
  if (anchorAbs === null || headAbs === null) return null;
  // Cross-type guard — a RelPos built against a different AbstractType would
  // point elsewhere; reject so we don't render a phantom caret at offset 0.
  if (anchorAbs.type !== ytext || headAbs.type !== ytext) return null;
  return { anchor: anchorAbs.index, head: headAbs.index };
}

/** Row shape for `snapshotRemotePlaintextCursors`. `anchor`/`head` are
 *  absolute CM offsets after resolution against the bound `Y.Text`. Caret-only
 *  when `anchor === head`. */
export interface RemotePlaintextCursor {
  clientID: number;
  userId: string | null;
  color: string;
  name: string | null;
  anchor: number;
  head: number;
}

/**
 * Dedupe peer cursors by `userId`, keeping the highest-`clock` row per
 * identity. Anonymous rows (`userId === null`) pass through untouched.
 *
 * Solves the lingering-clientID class: on WS reconnect the same human can get
 * a fresh clientID before cleanup catches up, and both states render. y-protocols
 * `meta.clock` is strictly monotonic per clientID, so the freshly-active
 * clientID wins.
 *
 * Exported for tests.
 */
export function dedupePlaintextCursors(
  rows: readonly (RemotePlaintextCursor & {
    identity: string | null;
    clock: number;
  })[],
): RemotePlaintextCursor[] {
  const byKey = new Map<string, RemotePlaintextCursor & { clock: number }>();
  const out: RemotePlaintextCursor[] = [];
  for (const r of rows) {
    if (r.identity === null) {
      out.push(r);
      continue;
    }
    const existing = byKey.get(r.identity);
    if (!existing || r.clock > existing.clock) byKey.set(r.identity, r);
  }
  for (const r of byKey.values()) out.push(r);
  return out;
}

/**
 * Snapshot remote plaintext cursors out of an Awareness state map and resolve
 * each peer's encoded RelPos pair to absolute CM offsets against the bound
 * `Y.Text`. Skips the local client. Skips entries that aren't `kind:'plaintext'`.
 * Skips peers whose `cursor.noteId` doesn't match this note (RECONCILIATION #1:
 * the cloud carries noteId in the cursor payload, not on `focus`).
 *
 * Returns the resolved offsets plus the peer's identity (so renderers can pick
 * the caret color from the accent palette). Peers whose RelPos failed to
 * resolve (item GC'd, wrong type) are dropped.
 *
 * Exported for tests; the consumer plugin below uses it.
 */
export function snapshotRemotePlaintextCursors(
  awareness: Awareness,
  ytext: Y.Text,
  noteId: string,
): RemotePlaintextCursor[] {
  const rows: (RemotePlaintextCursor & {
    identity: string | null;
    clock: number;
  })[] = [];
  const localId = awareness.clientID;
  const meta = awareness.meta;
  for (const [clientID, state] of awareness.getStates()) {
    if (clientID === localId) continue;
    const s = state as {
      user?: { userId?: string; color?: string; name?: string };
      cursor?: unknown;
    };
    const encoded = decodePlaintextCursor(s.cursor);
    if (encoded === null) continue;
    // Note filter: only render peers whose cursor targets this same note.
    if (encoded.noteId !== noteId) continue;
    // RelPos → absolute. Drop if either end fails to resolve, or if the RelPos
    // points at a different AbstractType (cross-doc safety).
    const resolved = resolvePlaintextCursor(ytext, encoded);
    if (resolved === null) continue;
    const userId = typeof s.user?.userId === 'string' ? s.user.userId : null;
    const name = typeof s.user?.name === 'string' ? s.user.name : null;
    const color =
      typeof s.user?.color === 'string'
        ? s.user.color
        : accentHexForId(userId ?? 'anon');
    const identity = userId === null ? null : `human:${userId}`;
    rows.push({
      clientID,
      userId,
      color,
      name,
      anchor: resolved.anchor,
      head: resolved.head,
      identity,
      clock: meta.get(clientID)?.clock ?? 0,
    });
  }
  return dedupePlaintextCursors(rows);
}

/**
 * CM6 producer — installs a `ViewPlugin` that writes the local selection to
 * `awareness.cursor` as a `kind:'plaintext'` payload (JSON-encoded RelPos pair
 * + this editor's `noteId`) on every selection change. On teardown, clears the
 * field (sets to `null`) so the roster doesn't show a stale caret.
 *
 * Awareness + ytext + noteId are captured at extension-construction time so
 * they survive Svelte 5 props-getter aliasing.
 */
export function plaintextCursorProducer(
  awareness: Awareness,
  ytext: Y.Text,
  noteId: string,
) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      private aw: Awareness;
      private yt: Y.Text;
      private note: string;

      constructor(view: EditorView) {
        this.aw = awareness;
        this.yt = ytext;
        this.note = noteId;
        // Emit the initial selection on mount, so a peer joining a doc where
        // the local user hasn't moved their caret since mount still sees it.
        this.publish(view);
      }

      update(update: ViewUpdate): void {
        if (update.selectionSet || update.docChanged) {
          this.publish(update.view);
        }
      }

      destroy(): void {
        this.aw.setLocalStateField('cursor', null);
      }

      private publish(view: EditorView): void {
        const sel = view.state.selection.main;
        const payload: PlaintextAwarenessCursor = {
          kind: 'plaintext',
          noteId: this.note,
          anchor: encodePlaintextRelativePosition(this.yt, sel.anchor),
          head: encodePlaintextRelativePosition(this.yt, sel.head),
        };
        this.aw.setLocalStateField('cursor', payload);
      }
    },
  );
}

/**
 * Caret widget — a thin vertical bar in the peer's accent color, with an
 * attached name pill (human icon + name). Renders directly via CM6's
 * widget-decoration system. Humans-only (RECONCILIATION #3).
 *
 * Equality compares color + userId + name so CM6 reuses the DOM across
 * position-only changes but rebuilds the label when a render-affecting field
 * changes.
 */
// Mirrors the inline phosphor light human glyph (10px) the KB-1 caret used.
const PLAINTEXT_HUMAN_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M230.9,212c-15.2-26.3-38.6-45.2-66.2-54.2a72,72,0,1,0-73.4,0c-27.6,9-51,27.9-66.2,54.2a8,8,0,1,0,13.8,8C58.4,187.5,91.4,168,128,168s69.6,19.5,89.1,52a8,8,0,1,0,13.8-8ZM72,96a56,56,0,1,1,56,56A56.1,56.1,0,0,1,72,96Z"/></svg>';

class PlaintextCaretWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly userId: string | null,
    readonly name: string | null,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof PlaintextCaretWidget)) return false;
    if (other.color !== this.color) return false;
    if (other.userId !== this.userId) return false;
    if (other.name !== this.name) return false;
    return true;
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
      label.dataset.kind = 'human';
      label.setAttribute(
        'style',
        `position:absolute;left:-2px;top:-1.4em;background:${this.color};color:white;padding:1px 4px;border-radius:3px;font-size:11px;font-weight:500;white-space:nowrap;pointer-events:none;line-height:1.2;font-family:system-ui,sans-serif;display:inline-flex;align-items:center;gap:3px;`,
      );
      const icon = document.createElement('span');
      icon.className = 'cm-plaintext-peer-label-icon';
      icon.setAttribute('style', 'display:inline-flex;line-height:0;');
      icon.innerHTML = PLAINTEXT_HUMAN_ICON_SVG;
      const text = document.createElement('span');
      text.textContent = this.name;
      label.appendChild(icon);
      label.appendChild(text);
      el.appendChild(label);
    }
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Build a `DecorationSet` rendering remote plaintext cursors as caret widgets +
 * (optionally) translucent selection ranges. Pure function of
 * `(awareness state, ytext, docLength, noteId)` — exported so substrate tests
 * can assert positioning without spinning up an EditorView.
 *
 * The widget renders at `head`; the selection range (when `anchor !== head`)
 * spans `min(anchor, head)` to `max(anchor, head)` at 20% alpha.
 */
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
    // Clamp into the live CM doc — peer offsets resolve against the live ytext,
    // but a publish racing an outbound delta could otherwise position past end.
    const anchor = Math.max(0, Math.min(peer.anchor, docLength));
    const head = Math.max(0, Math.min(peer.head, docLength));
    if (anchor !== head) {
      const from = Math.min(anchor, head);
      const to = Math.max(anchor, head);
      items.push({ kind: 'mark', from, to, color: peer.color });
    }
    items.push({
      kind: 'widget',
      pos: head,
      color: peer.color,
      userId: peer.userId,
      name: peer.name,
    });
  }
  // Sort by start position, widget-before-mark at any shared boundary — at the
  // same `from`, a widget (startSide 100_000_000) must be added before a mark
  // (startSide 500_000_000). Comes up on a backwards selection (head < anchor).
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
    } else {
      builder.add(
        item.pos,
        item.pos,
        Decoration.widget({
          widget: new PlaintextCaretWidget(item.color, item.userId, item.name),
          side: 1,
        }),
      );
    }
  }
  return builder.finish();
}

/**
 * Effect dispatched by the awareness listener to push a freshly-built
 * decoration set into the StateField. An empty `view.dispatch({})` is
 * unreliable (CM6 may short-circuit no-op transactions, freezing remote carets
 * at their initial position); carrying the new DecorationSet as a StateEffect
 * makes the transaction non-empty.
 */
const setPlaintextCursorDecorations = StateEffect.define<DecorationSet>();

/**
 * StateField holding the current plaintext-cursor decoration set. Provides
 * decorations to the view directly. Rebuilds on mount, on `tr.docChanged`
 * (local edits shift peer offsets + the docLength clamp), and on the
 * `setPlaintextCursorDecorations` effect (fired by the ViewPlugin's awareness
 * listener).
 */
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

/**
 * CM6 consumer — pair of extensions that render remote plaintext cursors. The
 * StateField owns the decoration set; the companion ViewPlugin subscribes to
 * `awareness.on('change', ...)` and dispatches a `setPlaintextCursorDecorations`
 * effect on every change so the field rebuilds against the live snapshot.
 *
 * Defensive: ignores any awareness state whose `cursor` doesn't decode as
 * `kind:'plaintext'` and whose `cursor.noteId` doesn't match the local note.
 */
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
          // The awareness 'change' event fires synchronously from
          // `setLocalStateField`. Dispatching directly here would chain
          // producer → setLocalStateField → emit('change') → consumer →
          // view.dispatch while the producer's update() is still on the stack,
          // and CM6 throws "Calls to EditorView.update are not allowed while an
          // update is in progress." We defer with `queueMicrotask` (CM6 has no
          // setMeta-on-view primitive to annotate the next dispatch).
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
