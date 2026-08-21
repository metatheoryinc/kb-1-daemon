import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { plaintextDecorations } from './plaintext-decorations';
import { mentionAtomicDeleteRange } from './plaintext-mention-keymap';

/**
 * Unit tests for the mention atomic-edge delete logic. The pure
 * `mentionAtomicDeleteRange(state, pos, key)` helper encapsulates the
 * right-edge / left-edge / inside detection so we can exercise it
 * without an EditorView (no DOM in the vitest config; see vitest.config.ts).
 *
 * The keymap's `run` handlers wrap this with `view.dispatch` — the
 * dispatch is a one-liner over the returned range and is exercised in
 * the browser-smoke side, not here.
 */

function makeState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [plaintextDecorations()],
  });
}

describe('mentionAtomicDeleteRange — Backspace at right edge', () => {
  it('returns the full mention range when caret is immediately after the closing `)`', () => {
    const doc = '[Alice](mention:alice@kb-1.dev)';
    const state = makeState(doc);
    // Caret at the very end of the doc — right after the `)`.
    const range = mentionAtomicDeleteRange(state, doc.length, 'Backspace');
    expect(range).not.toBeNull();
    expect(range).toEqual({ from: 0, to: doc.length });
  });

  it('returns null (falls through to per-char delete) when caret is INSIDE the mention', () => {
    const doc = '[Alice](mention:alice@kb-1.dev)';
    const state = makeState(doc);
    // Caret inside the display name — typo-fix carve-out.
    const range = mentionAtomicDeleteRange(state, 3, 'Backspace');
    expect(range).toBeNull();
  });

  it('returns null when caret is in plain text not adjacent to a mention', () => {
    const doc = 'plain text with no mentions';
    const state = makeState(doc);
    const range = mentionAtomicDeleteRange(state, 5, 'Backspace');
    expect(range).toBeNull();
  });

  it('returns null when caret is at position 0 (no character to backspace)', () => {
    const doc = '[Alice](mention:alice@kb-1.dev)';
    const state = makeState(doc);
    const range = mentionAtomicDeleteRange(state, 0, 'Backspace');
    expect(range).toBeNull();
  });

  it('does not match a non-mention link', () => {
    // `[label](https://example.com)` is a regular link, not a mention.
    // Backspace at the right edge should NOT atomic-delete it — the
    // user typically wants per-char delete on URLs (the URL might be
    // longer than they want to retype).
    const doc = '[Anthropic](https://anthropic.com)';
    const state = makeState(doc);
    const range = mentionAtomicDeleteRange(state, doc.length, 'Backspace');
    expect(range).toBeNull();
  });

  it('uses the destination when a mention has a URL-shaped label', () => {
    const doc = '[https://profile.example](mention:alice@kb-1.dev)';
    const state = makeState(doc);
    const range = mentionAtomicDeleteRange(state, doc.length, 'Backspace');
    expect(range).toEqual({ from: 0, to: doc.length });
  });
});

describe('mentionAtomicDeleteRange — Delete at left edge', () => {
  it('returns the full mention range when caret is immediately before the opening `[`', () => {
    const doc = '[Bob](mention:bob@kb-1.dev) trailing';
    const state = makeState(doc);
    // Caret at position 0 — right before the `[`.
    const range = mentionAtomicDeleteRange(state, 0, 'Delete');
    expect(range).not.toBeNull();
    expect(range?.from).toBe(0);
    // Mention range = `[Bob](mention:bob@kb-1.dev)` = chars 0..27.
    expect(range?.to).toBe('[Bob](mention:bob@kb-1.dev)'.length);
  });

  it('returns null (falls through) when caret is INSIDE the mention', () => {
    const doc = '[Bob](mention:bob@kb-1.dev)';
    const state = makeState(doc);
    // Caret inside the display name.
    const range = mentionAtomicDeleteRange(state, 2, 'Delete');
    expect(range).toBeNull();
  });

  it('returns null when caret is at the document end (nothing to delete)', () => {
    const doc = 'no mention here';
    const state = makeState(doc);
    const range = mentionAtomicDeleteRange(state, doc.length, 'Delete');
    expect(range).toBeNull();
  });

  it('returns the full range when a mention sits in the middle of a paragraph', () => {
    const doc = 'pinging [Alice](mention:alice@kb-1.dev) for review';
    const state = makeState(doc);
    const mentionStart = doc.indexOf('[');
    const mentionEnd = doc.indexOf(')') + 1;
    const range = mentionAtomicDeleteRange(state, mentionStart, 'Delete');
    expect(range).toEqual({ from: mentionStart, to: mentionEnd });
  });
});

describe('mentionAtomicDeleteRange — adjacency edge cases', () => {
  it('Backspace right after a mention chip in the middle of text', () => {
    const doc = 'pre [Alice](mention:alice@kb-1.dev) post';
    const state = makeState(doc);
    const mentionEnd = doc.indexOf(')') + 1;
    const range = mentionAtomicDeleteRange(state, mentionEnd, 'Backspace');
    expect(range).not.toBeNull();
    expect(range?.from).toBe(doc.indexOf('['));
    expect(range?.to).toBe(mentionEnd);
  });

  it('Delete on the SPACE just after a chip does not atomic-delete', () => {
    // Position right after the `)` is the right edge for Backspace,
    // but the LEFT edge for Delete is the position of `[` — the space
    // sits BETWEEN, so neither key triggers atomic delete on the chip.
    const doc = 'pre [Alice](mention:alice@kb-1.dev) post';
    const state = makeState(doc);
    const mentionEnd = doc.indexOf(')') + 1;
    // Delete at mentionEnd would delete the following space, not the
    // chip — Delete is the LEFT-edge key, so it only fires when the
    // caret is at the chip's `from`.
    const range = mentionAtomicDeleteRange(state, mentionEnd, 'Delete');
    expect(range).toBeNull();
  });
});
