import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { plaintextDecorations } from './plaintext-decorations';
import { listIndentChange } from './plaintext-list-keymap';

/**
 * Unit tests for the list-indent decision function. `listIndentChange`
 * encapsulates the lezer ListItem gate, FencedCode bail-out, and
 * leading-whitespace shape check; the keymap's `run` handlers wrap
 * this with `view.dispatch` and are exercised at the browser-smoke
 * layer.
 */

function makeState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [plaintextDecorations()],
  });
}

describe('listIndentChange — Tab indents list lines', () => {
  it('inserts two spaces at line.from on a top-level bullet', () => {
    const doc = '- alpha';
    const state = makeState(doc);
    // Caret somewhere inside the body — exact column doesn't matter,
    // the change is anchored at line.from.
    const change = listIndentChange(state, doc.indexOf('alpha'), 1);
    expect(change).toEqual({ from: 0, to: 0, insert: '  ' });
  });

  it('inserts two spaces on an already-nested bullet (cumulative)', () => {
    const doc = '- alpha\n  - beta';
    const state = makeState(doc);
    const pos = doc.indexOf('beta');
    const change = listIndentChange(state, pos, 1);
    // line.from for the second line is just after the `\n` — the
    // change inserts at that anchor regardless of existing indent.
    const lineFrom = doc.indexOf('  - beta');
    expect(change).toEqual({ from: lineFrom, to: lineFrom, insert: '  ' });
  });

  it('inserts two spaces on an ordered-list line', () => {
    const doc = '1. alpha';
    const state = makeState(doc);
    const change = listIndentChange(state, doc.indexOf('alpha'), 1);
    expect(change).toEqual({ from: 0, to: 0, insert: '  ' });
  });

  it('inserts two spaces on a task-list line', () => {
    // GFM task list — TaskList extension is mounted by plaintextDecorations.
    const doc = '- [ ] do the thing';
    const state = makeState(doc);
    const change = listIndentChange(state, doc.indexOf('do'), 1);
    expect(change).toEqual({ from: 0, to: 0, insert: '  ' });
  });

  it('returns null on plain prose with no ListItem ancestor', () => {
    const doc = 'just a paragraph with no list';
    const state = makeState(doc);
    const change = listIndentChange(state, 5, 1);
    expect(change).toBeNull();
  });

  it('returns null inside a fenced code block', () => {
    // A fenced code block even if visually nested under a list line
    // bails out at the FencedCode ancestor check before reaching the
    // ListItem check.
    const doc = '```ts\nconst x = 1;\n```';
    const state = makeState(doc);
    const change = listIndentChange(state, doc.indexOf('const'), 1);
    expect(change).toBeNull();
  });

  it('indents when the caret sits at line.from of a list line', () => {
    // Boundary case: caret at line.from (e.g. pressed Home before Tab).
    // Single-side resolveInner(-1) would have resolved into the prior
    // block; the dual-side probe finds the ListItem via the +1 bias.
    const doc = '- alpha\n- beta';
    const state = makeState(doc);
    const betaLineFrom = doc.indexOf('- beta');
    const change = listIndentChange(state, betaLineFrom, 1);
    expect(change).toEqual({ from: betaLineFrom, to: betaLineFrom, insert: '  ' });
  });

  it('indents the very first list line when caret is at doc start', () => {
    // pos === 0 boundary — earlier single-side -1 probe would walk into
    // a "before doc" position and miss the ListItem entirely.
    const doc = '- alpha';
    const state = makeState(doc);
    const change = listIndentChange(state, 0, 1);
    expect(change).toEqual({ from: 0, to: 0, insert: '  ' });
  });

  it('falls through at the boundary between a list line and a nested fence', () => {
    // FencedCode wins over ListItem when either side resolves into it:
    // a fence opening inside a list item should not indent the list
    // row. Caret sits just before the opening ```.
    const doc = '- alpha\n  ```ts\n  const x = 1;\n  ```';
    const state = makeState(doc);
    const fenceFrom = doc.indexOf('```ts');
    const change = listIndentChange(state, fenceFrom, 1);
    expect(change).toBeNull();
  });
});

describe('listIndentChange — Shift-Tab outdents list lines', () => {
  it('removes two leading spaces on an indented bullet', () => {
    const doc = '- alpha\n  - beta';
    const state = makeState(doc);
    const pos = doc.indexOf('beta');
    const change = listIndentChange(state, pos, -1);
    const lineFrom = doc.indexOf('  - beta');
    expect(change).toEqual({ from: lineFrom, to: lineFrom + 2, insert: '' });
  });

  it('returns null on a top-level bullet (no leading whitespace to remove)', () => {
    const doc = '- alpha';
    const state = makeState(doc);
    const change = listIndentChange(state, doc.indexOf('alpha'), -1);
    expect(change).toBeNull();
  });

  it('returns null when the leading whitespace is a single space', () => {
    // Single-space lead is not the 2-space markdown convention; v1
    // refuses to normalise mixed indent and falls through.
    const doc = '- alpha\n - beta';
    const state = makeState(doc);
    const pos = doc.indexOf('beta');
    const change = listIndentChange(state, pos, -1);
    expect(change).toBeNull();
  });

  it('returns null when the leading whitespace is a tab', () => {
    // Tab-indented list line — not a shape we normalise in v1.
    // Lezer may or may not parse `\t- beta` as a continuation of the
    // parent ListItem depending on context; the outdent gate refuses
    // regardless because the first two chars aren't `"  "`.
    const doc = '- alpha\n\t- beta';
    const state = makeState(doc);
    const pos = doc.indexOf('beta');
    const change = listIndentChange(state, pos, -1);
    expect(change).toBeNull();
  });
});
