/**
 * Tab / Shift-Tab indent / outdent for list items in the plaintext editor.
 *
 * Tab on a line whose lezer ancestry includes a `ListItem` inserts two
 * spaces at the line start (one markdown nesting level); Shift-Tab
 * removes two leading spaces. Tab outside any `ListItem` returns false
 * and cascades to the default keymap — so the browser's natural
 * focus-traversal behaviour stays intact for keyboard-only users.
 *
 * Single-line v1: any non-empty selection (anchor and head on different
 * lines, or non-empty range at all) falls through. Multi-line block
 * indent/outdent is a deferred follow-up.
 */

import { keymap, type EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type { EditorState, Extension } from '@codemirror/state';

const INDENT = '  ';

/**
 * Whether the caret at `pos` sits inside a `ListItem` (and NOT inside
 * a `FencedCode` block). We probe both left- and right-biased ancestry
 * because at a line boundary (caret at line.from of a list line, or at
 * the edge of a fence opening inside a list) one side may resolve into
 * the prior block while the other resolves into the new one — relying
 * on a single bias would mis-classify boundary positions.
 *
 * `FencedCode` always wins over `ListItem`: if EITHER side sees a fence
 * we fall through, so Tab inside a code block stays available for an
 * eventual code-indent slice and never accidentally indents the list
 * row a nested fence belongs to.
 */
function inListItem(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state);
  let hasListItem = false;
  for (const side of [-1, 1] as const) {
    let cursor: SyntaxNode | null = tree.resolveInner(pos, side);
    while (cursor !== null) {
      if (cursor.type.name === 'FencedCode') return false;
      if (cursor.type.name === 'ListItem') hasListItem = true;
      cursor = cursor.parent;
    }
  }
  return hasListItem;
}

/**
 * Pure decision function: given a state, a caret position, and the
 * direction, return the change to dispatch or `null` to fall through.
 *
 * direction = +1 → indent (insert two spaces at line.from).
 * direction = -1 → outdent (remove two leading spaces if present).
 *
 * Returns `null` when:
 *   - caret is not inside a `ListItem` (or sits inside a fenced code
 *     block under one — bail before the ListItem check),
 *   - outdenting a line that doesn't start with two spaces (no-op),
 *   - the leading whitespace is mixed (tabs / single space) — single-
 *     line v1 stays out of normalisation territory.
 */
export function listIndentChange(
  state: EditorState,
  pos: number,
  direction: 1 | -1,
): { from: number; to: number; insert: string } | null {
  if (!inListItem(state, pos)) return null;
  const line = state.doc.lineAt(pos);
  if (direction === 1) {
    return { from: line.from, to: line.from, insert: INDENT };
  }
  // Outdent: only when the first two chars are spaces. Tabs or a
  // single leading space → fall through (v1 stays simple).
  const head = state.doc.sliceString(line.from, line.from + 2);
  if (head !== INDENT) return null;
  return { from: line.from, to: line.from + 2, insert: '' };
}

/**
 * Keymap extension wiring Tab + Shift-Tab to list indent / outdent.
 * Mount BEFORE `defaultKeymap` so we get first crack — defaultKeymap
 * doesn't bind Tab today but the ordering is the safe convention,
 * matching `plaintextMentionKeymap`'s placement.
 *
 * Multi-line selections fall through (return false) — multi-line block
 * indent is a deferred follow-up. Empty selection only.
 */
export function plaintextListKeymap(): Extension {
  return keymap.of([
    {
      key: 'Tab',
      run(view: EditorView): boolean {
        return runIndent(view, 1);
      },
      shift(view: EditorView): boolean {
        return runIndent(view, -1);
      },
    },
  ]);
}

function runIndent(view: EditorView, direction: 1 | -1): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const change = listIndentChange(state, sel.head, direction);
  if (change === null) return false;
  // CM6 maps the existing selection through `changes` automatically;
  // the caret's offset from line.from is preserved.
  view.dispatch({ changes: change });
  return true;
}
