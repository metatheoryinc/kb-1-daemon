/**
 * Atomic-edge delete keymap for mention chips in the plaintext editor.
 *
 * Backspace at the right edge of a `[Name](mention:email)` source range
 * (caret immediately after the closing `)`) deletes the entire range
 * in one transaction. Delete at the left edge (caret immediately before
 * the opening `[`) does the same.
 *
 * Caret positions INSIDE the mention's source fall through to default
 * per-character delete so users can fix typos in the display name —
 * matches the rationale in `mention-keymap-plugin.ts:25-37` on the
 * Crepe side.
 *
 * The keymap is additive: returning `false` from `run` lets CM6 cascade
 * to the next handler in the keymap chain (default delete, undo, …).
 * Both handlers return `true` only after dispatching a delete tx.
 */

import { keymap, type EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type { EditorState, Extension } from '@codemirror/state';
import { parseMentionUrl } from './markdown-core';
import { extractLinkUrl } from './plaintext-link-affordance';

/**
 * Find the nearest enclosing `Link` node at `pos` whose URL is a
 * `mention:<email>` scheme. Returns the Link node when one exists,
 * `null` otherwise (caret is not inside / adjacent to a mention).
 *
 * `side` biases `tree.resolveInner` left or right depending on whether
 * we're checking the right edge (Backspace, side=-1: prefer the node
 * ending at pos) or the left edge (Delete, side=1: prefer the node
 * starting at pos).
 *
 * Internal helper — callers go through the keymap's `run` handlers
 * below.
 */
function findMentionAt(
  state: EditorState,
  pos: number,
  side: -1 | 1,
): SyntaxNode | null {
  const tree = syntaxTree(state);
  let node: SyntaxNode | null = tree.resolveInner(pos, side);
  while (node !== null) {
    if (node.type.name === 'Link') {
      // Reuse the link-affordance helper so mention detection lives in
      // exactly one place (URL extraction with `<…>` unwrap + trim).
      const url = extractLinkUrl(state, node);
      if (url !== null && parseMentionUrl(url) !== null) return node;
      return null;
    }
    node = node.parent;
  }
  return null;
}

/**
 * Pure decision function: given a state, a caret position, and the
 * key being pressed, return the source range to delete atomically as
 * one transaction, or `null` to fall through to the next handler.
 *
 * Encapsulates the right-edge / left-edge / inside detection so the
 * keymap and unit tests share one logic path. The keymap's `run`
 * handlers wrap this with the actual `view.dispatch` call.
 */
export function mentionAtomicDeleteRange(
  state: EditorState,
  pos: number,
  key: 'Backspace' | 'Delete',
): { from: number; to: number } | null {
  if (key === 'Backspace') {
    if (pos === 0) return null;
    // Right-edge case: the mention's Link node ends exactly at the
    // caret. Caret INSIDE has node.to > pos — strict equality lets the
    // inside case fall through to default per-char delete (typo-fix).
    const link = findMentionAt(state, pos, -1);
    if (link?.to !== pos) return null;
    return { from: link.from, to: link.to };
  }
  // Delete: left-edge case.
  if (pos >= state.doc.length) return null;
  const link = findMentionAt(state, pos, 1);
  if (link?.from !== pos) return null;
  return { from: link.from, to: link.to };
}

/**
 * Keymap extension wiring Backspace + Delete to atomic-edge mention
 * deletion. Mount alongside the editor's other keymaps; CM6 cascades
 * through keymap providers in registration order, so this should sit
 * BEFORE `defaultKeymap` so it gets the first crack at Backspace /
 * Delete (otherwise the default per-char delete fires first and the
 * mention's source loses its closing `)` before our handler sees it).
 */
export function plaintextMentionKeymap(): Extension {
  return keymap.of([
    {
      key: 'Backspace',
      run(view: EditorView): boolean {
        const { state } = view;
        const sel = state.selection.main;
        if (!sel.empty) return false;
        const range = mentionAtomicDeleteRange(state, sel.head, 'Backspace');
        if (range === null) return false;
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: '' },
          selection: { anchor: range.from },
        });
        return true;
      },
    },
    {
      key: 'Delete',
      run(view: EditorView): boolean {
        const { state } = view;
        const sel = state.selection.main;
        if (!sel.empty) return false;
        const range = mentionAtomicDeleteRange(state, sel.head, 'Delete');
        if (range === null) return false;
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: '' },
          selection: { anchor: range.from },
        });
        return true;
      },
    },
  ]);
}
