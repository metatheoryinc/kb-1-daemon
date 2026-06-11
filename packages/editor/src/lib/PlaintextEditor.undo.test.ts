import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  PLAINTEXT_AGENT_ORIGIN,
  PLAINTEXT_USER_ORIGIN,
} from './content-format';

/**
 * Substrate contract tests for `<PlaintextEditor>`'s undo gate.
 *
 * The component mounts an actual CodeMirror 6 EditorView, which is
 * impractical to instantiate in this repo's vitest config (no DOM
 * environment configured — see `vitest.config.ts`; all existing tests
 * are pure-logic). Mounting CM6 needs JSDOM/happy-dom + @testing-
 * library/svelte, which would be a much larger addition than this
 * slice warrants.
 *
 * Instead, these tests pin the *substrate contract* the component
 * builds on: a `Y.UndoManager` configured with `trackedOrigins: new
 * Set([PLAINTEXT_USER_ORIGIN])` against the `Y.Text` at
 * the bound Markdown `Y.Text`. We then exercise the same transact-with-
 * origin pattern the component uses for local edits and agent
 * splices, and assert the undo gate behaves per the spec:
 *
 *   - User edits are undoable.
 *   - Agent splices ('plaintext-agent') are NOT undoable.
 *   - Updates with `null` origin (hydrate-like / system) are NOT
 *     undoable.
 *
 * If `<PlaintextEditor>` drifts from this transaction-origin
 * contract, these tests stay green but the editor would visibly
 * break — that's the seam Slice 5's two-browser smoke catches. The
 * spec layer is what we pin here.
 *
 * Spec: `docs/plans/2026-05-13-plaintext-shadow-track.md`
 *   §"Undo and origin tagging"
 */

function setup(initial = '') {
  const doc = new Y.Doc();
  const ytext = doc.getText('markdown');
  if (initial.length > 0) {
    // Seed without polluting the undo stack — seed comes from hydrate,
    // not from the user. `null` origin matches what `Y.applyUpdate`
    // would write if hydration ever lacked an explicit origin.
    doc.transact(() => {
      ytext.insert(0, initial);
    }, null);
  }
  const undoManager = new Y.UndoManager(ytext, {
    trackedOrigins: new Set([PLAINTEXT_USER_ORIGIN]),
  });
  return { doc, ytext, undoManager };
}

describe('PlaintextEditor undo gate (substrate contract)', () => {
  it('undoes a local user edit', () => {
    const { doc, ytext, undoManager } = setup('hello');
    doc.transact(() => {
      ytext.insert(ytext.length, ' world');
    }, PLAINTEXT_USER_ORIGIN);
    expect(ytext.toJSON()).toBe('hello world');
    undoManager.undo();
    expect(ytext.toJSON()).toBe('hello');
  });

  it('does NOT undo an agent splice', () => {
    const { doc, ytext, undoManager } = setup('hello');
    // Agent splice — the same shape `applyEditNote` will emit on the
    // server side for plaintext (Slice 2). Origin is the string
    // sentinel `PLAINTEXT_AGENT_ORIGIN`.
    doc.transact(() => {
      ytext.insert(0, 'AGENT: ');
    }, PLAINTEXT_AGENT_ORIGIN);
    expect(ytext.toJSON()).toBe('AGENT: hello');
    // Undo should be a no-op — the undo stack is empty (no tracked
    // origins emitted anything).
    undoManager.undo();
    expect(ytext.toJSON()).toBe('AGENT: hello');
  });

  it('does NOT undo a null-origin (system / hydrate) update', () => {
    const { doc, ytext, undoManager } = setup('hello');
    doc.transact(() => {
      ytext.insert(0, 'HYDRATED: ');
    }, null);
    expect(ytext.toJSON()).toBe('HYDRATED: hello');
    undoManager.undo();
    expect(ytext.toJSON()).toBe('HYDRATED: hello');
  });

  it('preserves the agent splice when user undo runs after both edits', () => {
    // The realistic concurrent edit scenario: agent splice lands,
    // user types more, user hits Ctrl-Z. Only the user's keystrokes
    // should reverse — the agent's edit stays.
    const { doc, ytext, undoManager } = setup('hello');
    doc.transact(() => {
      ytext.insert(0, 'AGENT: ');
    }, PLAINTEXT_AGENT_ORIGIN);
    doc.transact(() => {
      ytext.insert(ytext.length, '!');
    }, PLAINTEXT_USER_ORIGIN);
    expect(ytext.toJSON()).toBe('AGENT: hello!');
    undoManager.undo();
    // User keystroke gone, agent prefix preserved.
    expect(ytext.toJSON()).toBe('AGENT: hello');
    // No further undo work — second undo is a no-op.
    undoManager.undo();
    expect(ytext.toJSON()).toBe('AGENT: hello');
  });

  it('redoes a previously undone user edit', () => {
    const { doc, ytext, undoManager } = setup('hello');
    doc.transact(() => {
      ytext.insert(ytext.length, ' world');
    }, PLAINTEXT_USER_ORIGIN);
    undoManager.undo();
    expect(ytext.toJSON()).toBe('hello');
    undoManager.redo();
    expect(ytext.toJSON()).toBe('hello world');
  });

  it('exposes user transactions with origin === PLAINTEXT_USER_ORIGIN', () => {
    // Wire-side guarantee: whatever else changes about the binding,
    // the spec contract is that local CM6 edits enter Yjs with this
    // exact string origin so downstream observers and debug tooling
    // can discriminate.
    const { doc, ytext } = setup();
    const seenOrigins: unknown[] = [];
    doc.on('afterTransaction', (tr) => seenOrigins.push(tr.origin));
    doc.transact(() => {
      ytext.insert(0, 'hi');
    }, PLAINTEXT_USER_ORIGIN);
    expect(seenOrigins).toContain(PLAINTEXT_USER_ORIGIN);
  });
});
