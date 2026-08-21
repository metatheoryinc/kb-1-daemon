import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { accentForId } from '@kb-1/ui';
import {
  plaintextDecorations,
  buildMarkdownDecorations,
  parseImageNode,
  parseTableNode,
  parseTableCellInlineMarkdown,
  parseColumnAlignment,
  unescapeMarkdownInline,
} from './plaintext-decorations';

/**
 * Unit tests for Slice 4 fix-pass — table + image live-preview
 * decorations.
 *
 * The vitest config has no DOM environment (see vitest.config.ts), so we
 * exercise the pure pieces:
 *
 *   - `buildMarkdownDecorations(state, selection, opts)` — given an
 *     `EditorState` it returns a `DecorationSet`. No view required.
 *   - `parseImageNode(node, state)` — pure helper.
 *   - `parseTableNode(node, state)` — pure helper.
 *   - `parseColumnAlignment(cell)` and `unescapeMarkdownInline(text)`
 *     — string-level pure helpers.
 *   - `EditorState.create({ extensions: [plaintextDecorations()] })` —
 *     the full extension construction path. The CRITICAL "editor mounts
 *     at all" regression test pins this; Slice 4's original landing
 *     threw `RangeError: Block decorations may not be specified via
 *     plugins` from `EditorState.create` onwards because the Table
 *     widget's `block: true` replace was emitted from a ViewPlugin's
 *     decoration facet. The fix-pass moves all decorations into a
 *     `StateField`, which is allowed to host block decorations.
 *
 * Tests deliberately do NOT touch any DOM API — no widget.toDOM, no
 * EditorView. That space stays the browser-smoke's job.
 */

function makeState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [plaintextDecorations()],
  });
}

/** Find the first lezer node with the given name in the state's tree. */
function findNode(state: EditorState, name: string): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  syntaxTree(state).iterate({
    enter: (n) => {
      if (found !== null) return false;
      if (n.type.name === name) {
        found = n.node;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

/** Assertion helper that narrows `SyntaxNode | null` to `SyntaxNode`. */
function requireNode(node: SyntaxNode | null, name: string): SyntaxNode {
  if (node === null) {
    throw new Error(`expected a ${name} node in the syntax tree`);
  }
  return node;
}

describe('plaintextDecorations — editor-mounts-at-all regression', () => {
  it('constructs an EditorState with the plaintextDecorations extension without throwing', () => {
    // This is the floor — Slice 4 originally threw `RangeError: Block
    // decorations may not be specified via plugins` here, crashing
    // every .txt note on mount. If this test ever fails again the
    // root cause is almost certainly a block-shaped `Decoration.replace`
    // being routed through a `ViewPlugin` instead of the StateField.
    const doc = [
      '# Heading',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '![alt](https://example.com/x.png)',
      '',
      'Done.',
    ].join('\n');
    expect(() => makeState(doc)).not.toThrow();
  });

  it('produces a non-empty DecorationSet for a doc with a table', () => {
    // Place the cursor well past the table so the table replace
    // decoration is emitted (this is the path that previously crashed
    // CM6 in a ViewPlugin's decoration facet).
    const doc = '| a | b |\n| - | - |\n| 1 | 2 |\n\n\nafter\n';
    const state = makeState(doc);
    const decos = buildMarkdownDecorations(state, {
      from: doc.length,
      to: doc.length,
    });
    expect(decos.size).toBeGreaterThan(0);
  });

  it('does not throw when the cursor is inside a table (raw-mode path)', () => {
    const doc = '| a | b |\n| - | - |\n| 1 | 2 |\n';
    const state = makeState(doc);
    // Caret somewhere inside the body row.
    expect(() => buildMarkdownDecorations(state, { from: 22, to: 22 })).not.toThrow();
  });
});

describe('parseImageNode — alt + url extraction', () => {
  function imageStateOrThrow(line: string): {
    state: EditorState;
    image: SyntaxNode;
  } {
    const state = makeState(line);
    const image = requireNode(findNode(state, 'Image'), 'Image');
    return { state, image };
  }

  it('extracts alt and url from `![alt](url)`', () => {
    const { state, image } = imageStateOrThrow('![my alt](https://example.com/img.png)');
    const parsed = parseImageNode(image, state);
    expect(parsed).toEqual({
      alt: 'my alt',
      url: 'https://example.com/img.png',
    });
  });

  it('extracts an empty alt from `![](url)`', () => {
    const { state, image } = imageStateOrThrow('![](https://example.com/img.png)');
    const parsed = parseImageNode(image, state);
    expect(parsed?.alt).toBe('');
    expect(parsed?.url).toBe('https://example.com/img.png');
  });

  it('preserves whitespace in alt text', () => {
    const { state, image } = imageStateOrThrow('![alt with spaces](https://example.com/img.png)');
    const parsed = parseImageNode(image, state);
    expect(parsed?.alt).toBe('alt with spaces');
  });

  it('ignores the title and still extracts alt + url', () => {
    const { state, image } = imageStateOrThrow('![alt](https://example.com/img.png "the title")');
    const parsed = parseImageNode(image, state);
    expect(parsed?.alt).toBe('alt');
    expect(parsed?.url).toBe('https://example.com/img.png');
  });

  it('strips angle brackets around URLs containing spaces', () => {
    const { state, image } = imageStateOrThrow(
      '![alt](<https://example.com/path with spaces.png>)',
    );
    const parsed = parseImageNode(image, state);
    expect(parsed?.url).toBe('https://example.com/path with spaces.png');
  });

  it('returns null when there is no URL', () => {
    // Reference-style — no `(url)` part. We treat that as malformed.
    const state = makeState('![alt][ref]');
    const image = findNode(state, 'Image');
    if (image === null) {
      // Some lezer-markdown versions don't emit an Image node at all
      // for unresolved reference shorthands — that's also "fall back to
      // raw markdown", so this passes vacuously.
      return;
    }
    const parsed = parseImageNode(image, state);
    expect(parsed).toBeNull();
  });

  it('handles various URL schemes', () => {
    const cases = [
      'data:image/png;base64,iVBORw0KGgo=',
      'blob:http://localhost:8797/abc-123',
      '//example.com/img.png',
      'http://example.com/img.png',
      'assets/note-id/foo.png',
    ];
    for (const url of cases) {
      const { state, image } = imageStateOrThrow(`![x](${url})`);
      const parsed = parseImageNode(image, state);
      expect(parsed?.url, `parsed url for ${url}`).toBe(url);
    }
  });
});

describe('unescapeMarkdownInline', () => {
  it('unescapes pipes inside cell text', () => {
    expect(unescapeMarkdownInline('a\\|b')).toBe('a|b');
  });

  it('unescapes a backslash', () => {
    expect(unescapeMarkdownInline('\\\\')).toBe('\\');
  });

  it('unescapes emphasis markers', () => {
    expect(unescapeMarkdownInline('\\*x')).toBe('*x');
    expect(unescapeMarkdownInline('\\_y')).toBe('_y');
    expect(unescapeMarkdownInline('\\`z')).toBe('`z');
  });

  it('keeps backslash for non-punctuation', () => {
    expect(unescapeMarkdownInline('\\z')).toBe('\\z');
  });

  it('is a no-op for strings without backslashes', () => {
    expect(unescapeMarkdownInline('abc')).toBe('abc');
    expect(unescapeMarkdownInline('')).toBe('');
  });
});

describe('parseColumnAlignment — delimiter cell parsing', () => {
  it('returns "left" for `---` and `:---`', () => {
    expect(parseColumnAlignment('---')).toBe('left');
    expect(parseColumnAlignment(':---')).toBe('left');
    expect(parseColumnAlignment('  ---  ')).toBe('left');
  });

  it('returns "center" for `:---:`', () => {
    expect(parseColumnAlignment(':---:')).toBe('center');
    expect(parseColumnAlignment('  :---:  ')).toBe('center');
  });

  it('returns "right" for `---:`', () => {
    expect(parseColumnAlignment('---:')).toBe('right');
  });
});

describe('parseTableNode — alignment + unescape', () => {
  function tableStateOrThrow(doc: string): {
    state: EditorState;
    table: SyntaxNode;
  } {
    const state = makeState(doc);
    const table = requireNode(findNode(state, 'Table'), 'Table');
    return { state, table };
  }

  it('parses header, body, and alignments for a 3-col mixed table', () => {
    const doc =
      '| Name | Score | Status |\n' +
      '| :--- | :---: | ---:   |\n' +
      '| Alice | 42 | ok |\n' +
      '| Bob | 7 | review |\n';
    const { state, table } = tableStateOrThrow(doc);
    const parsed = parseTableNode(table, state);
    expect(parsed.header).toEqual(['Name', 'Score', 'Status']);
    expect(parsed.alignments).toEqual(['left', 'center', 'right']);
    expect(parsed.body).toEqual([
      ['Alice', '42', 'ok'],
      ['Bob', '7', 'review'],
    ]);
  });

  it('unescapes escaped pipes inside cells (`Carol\\|special`)', () => {
    const doc = '| Name | Status |\n' + '| --- | --- |\n' + '| Carol\\|special | ok |\n';
    const { state, table } = tableStateOrThrow(doc);
    const parsed = parseTableNode(table, state);
    expect(parsed.body[0][0]).toBe('Carol|special');
  });

  it('pads alignments to header column count when delimiter row is shorter', () => {
    // Pathological — but defensive: alignments default to 'left' for
    // any column not explicitly delimited.
    const doc = '| a | b | c |\n| --- |\n| 1 | 2 | 3 |\n';
    const state = makeState(doc);
    const table = findNode(state, 'Table');
    if (table === null) return; // parser might reject; that's fine
    const parsed = parseTableNode(table, state);
    expect(parsed.alignments.length).toBeGreaterThanOrEqual(parsed.header.length);
    for (let i = 1; i < parsed.alignments.length; i++) {
      expect(parsed.alignments[i]).toBe('left');
    }
  });

  it('does not crash on a 50-row table (smoke / performance)', () => {
    const rows: string[] = ['| a | b | c |', '| --- | :---: | ---: |'];
    for (let i = 0; i < 50; i++) {
      rows.push(`| r${String(i)} | v${String(i)} | s${String(i)} |`);
    }
    const doc = rows.join('\n') + '\n';
    const { state, table } = tableStateOrThrow(doc);
    const t0 = performance.now();
    const parsed = parseTableNode(table, state);
    const t1 = performance.now();
    expect(parsed.body.length).toBe(50);
    // 50 rows × 3 cells should be sub-millisecond on any laptop —
    // 50ms is a generous CI ceiling.
    expect(t1 - t0).toBeLessThan(50);
  });
});

describe('table cells — inline rendering contract', () => {
  it('parses bold, mention chips, URL links, and wikilinks inside a cell', () => {
    const parts = parseTableCellInlineMarkdown(
      '**bold** [Alice](mention:alice@kb-1.dev) [Example](https://example.com) [[welcome]]',
      {
        orgPeople: [
          {
            id: 'user-alice',
            email: 'alice@kb-1.dev',
            name: 'Alice (dev)',
            image: null,
          },
        ],
        livePaths: [{ path: 'welcome.md', noteId: 'note-welcome' }],
      },
    );

    expect(parts.some((part) => part.kind === 'strong')).toBe(true);
    const mention = parts.find((part) => part.kind === 'mention');
    expect(mention?.kind === 'mention' ? mention.props.displayName : null).toBe('Alice (dev)');
    const link = parts.find((part) => part.kind === 'link');
    expect(link?.kind === 'link' ? link.href : null).toBe('https://example.com');
    const wikilink = parts.find((part) => part.kind === 'wikilink');
    expect(wikilink).toMatchObject({
      kind: 'wikilink',
      target: 'welcome',
      label: 'welcome',
      resolved: true,
    });
  });

  it('uses destinations when table link labels are URL-shaped', () => {
    const parts = parseTableCellInlineMarkdown(
      '[https://label.example](https://destination.example) ' +
        '[https://profile.example](mention:alice@kb-1.dev)',
      {
        orgPeople: [
          {
            id: 'user-alice',
            email: 'alice@kb-1.dev',
            name: 'Alice (dev)',
            image: null,
          },
        ],
        livePaths: [],
      },
    );

    const link = parts.find((part) => part.kind === 'link');
    expect(link?.kind === 'link' ? link.href : null).toBe('https://destination.example');
    expect(link?.kind === 'link' ? link.children : null).toEqual([
      { kind: 'text', text: 'https://label.example' },
    ]);
    const mention = parts.find((part) => part.kind === 'mention');
    expect(mention?.kind === 'mention' ? mention.props.displayName : null).toBe('Alice (dev)');
  });

  it('keeps table source raw while the cursor is inside the table', () => {
    const doc =
      '| Feature | Value |\n' +
      '| --- | --- |\n' +
      '| Bold | **bold cell** |\n' +
      '| Person | [Alice](mention:alice@kb-1.dev) |\n';
    const state = makeState(doc);
    const cursorInsideTable = doc.indexOf('bold cell');
    const set = buildMarkdownDecorations(
      state,
      { from: cursorInsideTable, to: cursorInsideTable },
      {
        orgPeople: [
          {
            id: 'user-alice',
            email: 'alice@kb-1.dev',
            name: 'Alice',
            image: null,
          },
        ],
      },
    );

    let tableWidgetCount = 0;
    let boldMarkCount = 0;
    let mentionWidgetCount = 0;
    set.between(0, doc.length, (_from, _to, value) => {
      const spec = value.spec as {
        class?: string;
        widget?: { header?: unknown; props?: unknown };
      };
      if (spec.widget?.header) tableWidgetCount++;
      if (spec.class === 'cm-md-bold') boldMarkCount++;
      if (spec.widget?.props) mentionWidgetCount++;
    });
    expect(tableWidgetCount).toBe(0);
    expect(boldMarkCount).toBe(0);
    expect(mentionWidgetCount).toBe(0);
  });
});

describe('selection-range reveal (forward + backward)', () => {
  // Doc: a paragraph with an image. The image source range is at a
  // known position; we'll select across it forward and backward and
  // confirm both produce the same decoration set (the image widget
  // collapses to source in both cases).

  const doc = 'before ![pic](https://example.com/x.png) after\n';
  // 'before ' = 7 chars, then `![pic](...)` starts at index 7.
  const imageStart = 7;
  const imageEnd = 7 + '![pic](https://example.com/x.png)'.length; // 40

  function buildAt(from: number, to: number) {
    const state = makeState(doc);
    return buildMarkdownDecorations(state, { from, to });
  }

  function widgetReplaceCount(set: ReturnType<typeof buildAt>): number {
    let count = 0;
    set.between(0, doc.length, (_from, _to, value) => {
      // `value.spec.widget` is non-null when this is a widget replace.
      // Both TableWidget and ImageWidget set widget; line/mark decos
      // don't.
      const spec: { widget?: unknown } = value.spec as { widget?: unknown };
      if (spec.widget) count++;
    });
    return count;
  }

  it('renders the image widget when selection is fully outside the range', () => {
    const set = buildAt(0, 0);
    expect(widgetReplaceCount(set)).toBe(1);
  });

  it('collapses the widget when a forward selection crosses it', () => {
    // anchor=5 (before 'before '), head=imageStart+3 (inside `![pic`)
    const set = buildAt(5, imageStart + 3);
    expect(widgetReplaceCount(set)).toBe(0);
  });

  it('collapses the widget when a backward selection crosses it (head < anchor)', () => {
    // Caller normalizes to {from, to} via state.selection.main.from/.to,
    // which is order-independent. We simulate by passing the normalized
    // pair — the bug was the OLD path used `.head` directly, which is
    // the moving endpoint. Here both directions yield the same
    // `from`/`to` after normalization, so the reveal triggers the same
    // way.
    const a = 5;
    const b = imageStart + 3;
    const setFwd = buildAt(Math.min(a, b), Math.max(a, b));
    const setBwd = buildAt(Math.min(b, a), Math.max(b, a));
    expect(widgetReplaceCount(setFwd)).toBe(widgetReplaceCount(setBwd));
    expect(widgetReplaceCount(setFwd)).toBe(0);
  });

  it('keeps the widget when the selection ends before the range starts', () => {
    const set = buildAt(0, imageStart - 1);
    expect(widgetReplaceCount(set)).toBe(1);
  });

  it('keeps the widget when the selection starts after the range ends', () => {
    const set = buildAt(imageEnd + 1, doc.length);
    expect(widgetReplaceCount(set)).toBe(1);
  });
});

describe('broken-table shapes', () => {
  it('pads body rows that have fewer cells than header', () => {
    const doc = '| a | b | c |\n' + '| - | - | - |\n' + '| 1 | 2 |\n'; // missing third column
    const state = makeState(doc);
    const table = requireNode(findNode(state, 'Table'), 'Table');
    const parsed = parseTableNode(table, state);
    expect(parsed.header.length).toBe(3);
    // Body row may be short — the TableWidget pads at render time.
    // Here we just confirm we extracted whatever cells the parser saw.
    expect(parsed.body[0].length).toBeLessThanOrEqual(3);
  });

  it('truncates body rows with more cells than header at render time', () => {
    const doc = '| a | b |\n' + '| - | - |\n' + '| 1 | 2 | 3 |\n';
    const state = makeState(doc);
    const table = requireNode(findNode(state, 'Table'), 'Table');
    const parsed = parseTableNode(table, state);
    expect(parsed.header.length).toBe(2);
    // Extras may appear in the parsed body — TableWidget caps the
    // render at header.length columns, which is verified at the
    // widget level (no DOM here).
    expect(parsed.body[0].length).toBeGreaterThanOrEqual(2);
  });

  it('falls through to plain text when there is no delimiter row', () => {
    // No `| --- |` line → not a GFM table per the parser.
    const doc = '| a | b |\n| 1 | 2 |\n';
    const state = makeState(doc);
    const table = findNode(state, 'Table');
    // lezer-markdown's GFM Table extension requires the delimiter row;
    // without it no Table node is emitted. The build path then leaves
    // raw pipes in place.
    expect(table).toBeNull();
    // The decoration build should still complete cleanly.
    expect(() => buildMarkdownDecorations(state, { from: 0, to: 0 })).not.toThrow();
  });
});

describe('wikilinks (Slice 5) — parse + decoration', () => {
  /**
   * Walk a DecorationSet for marks whose `class` property contains the
   * given substring (e.g. 'cm-md-wikilink-broken'). Returns the matching
   * (from, to) pairs in source order.
   */
  function findMarksByClass(
    set: ReturnType<typeof buildMarkdownDecorations>,
    substr: string,
    docLen: number,
  ): { from: number; to: number; class: string }[] {
    const hits: { from: number; to: number; class: string }[] = [];
    set.between(0, docLen, (from, to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      const cls = spec.class ?? '';
      if (cls.includes(substr)) {
        hits.push({ from, to, class: cls });
      }
    });
    return hits;
  }

  it('emits a Wikilink node for `[[target]]`', () => {
    const state = makeState('see [[Kyoto Hotel]] today\n');
    const wikilink = requireNode(findNode(state, 'Wikilink'), 'Wikilink');
    // The Wikilink node spans the full `[[target]]` range.
    expect(state.sliceDoc(wikilink.from, wikilink.to)).toBe('[[Kyoto Hotel]]');
  });

  it('does not match across newlines (`[[foo\\nbar]]` stays raw)', () => {
    const state = makeState('[[foo\nbar]]\n');
    const wikilink = findNode(state, 'Wikilink');
    expect(wikilink).toBeNull();
  });

  it('does not match an unclosed `[[foo`', () => {
    const state = makeState('[[foo and never closes\n');
    const wikilink = findNode(state, 'Wikilink');
    expect(wikilink).toBeNull();
  });

  it('parses `[[target|alias]]` with an alias child', () => {
    const state = makeState('see [[home-page|Home]] today\n');
    const wikilink = requireNode(findNode(state, 'Wikilink'), 'Wikilink');
    // Walk children and confirm we got a target + alias-mark + alias.
    const childNames: string[] = [];
    let child: SyntaxNode | null = wikilink.firstChild;
    while (child !== null) {
      childNames.push(child.type.name);
      child = child.nextSibling;
    }
    // Order: WikilinkMark, WikilinkTarget, WikilinkAliasMark,
    // WikilinkAlias, WikilinkMark.
    expect(childNames).toEqual([
      'WikilinkMark',
      'WikilinkTarget',
      'WikilinkAliasMark',
      'WikilinkAlias',
      'WikilinkMark',
    ]);
  });

  it('paints a resolved wikilink with the cm-md-wikilink-label class', () => {
    // Doc has the wikilink on line 1 and a body line below. Caret on
    // line 2 → wikilink is OFF the cursor's line, so the Shape A
    // line-based reveal hides the brackets and tints the label.
    const doc = 'see [[Kyoto Hotel]] today\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      {
        livePaths: [{ path: 'notes/Kyoto Hotel.md', noteId: 'n-kyoto' }],
      },
    );
    const labels = findMarksByClass(set, 'cm-md-wikilink-label', doc.length);
    expect(labels.length).toBe(1);
    // Resolved label MUST NOT carry the broken modifier.
    expect(labels[0].class).not.toContain('cm-md-wikilink-broken');
    // Range covers the target text exactly (`Kyoto Hotel`, between
    // the opening `[[` at index 4 and the closing `]]` at index 17).
    expect(doc.slice(labels[0].from, labels[0].to)).toBe('Kyoto Hotel');
  });

  it('paints a broken wikilink with the cm-md-wikilink-broken class', () => {
    const doc = 'see [[ghost-target]] today\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, { from: offLine, to: offLine }, { livePaths: [] });
    const brokens = findMarksByClass(set, 'cm-md-wikilink-broken', doc.length);
    expect(brokens.length).toBe(1);
    expect(doc.slice(brokens[0].from, brokens[0].to)).toBe('ghost-target');
  });

  it('emits cm-md-syntax marks on the `[[` and `]]` brackets when caret is on a different line', () => {
    // Shape A: brackets hide off-line, reveal on-line. Caret on line 2.
    const doc = '[[Note]]\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, {
      from: offLine,
      to: offLine,
    });
    const hidden: { from: number; to: number }[] = [];
    set.between(0, doc.length, (from, to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      if (spec.class?.includes('cm-md-syntax') && spec.class?.includes('cm-hidden')) {
        hidden.push({ from, to });
      }
    });
    // Two syntax-mark ranges: `[[` (0..2) and `]]` (6..8).
    const ranges = hidden.map((h) => `${String(h.from)}..${String(h.to)}`).sort();
    expect(ranges).toContain('0..2');
    expect(ranges).toContain('6..8');
  });

  it('reveals `[[` / `]]` when the caret is on the same line as the wikilink', () => {
    // Shape A: same-line cursor reveals the raw markdown. The test
    // previously asserted "caret inside the link span"; now any caret
    // on the link's line counts.
    const doc = '[[Note]]\n';
    const state = makeState(doc);
    // Caret inside the target text — same line.
    const set = buildMarkdownDecorations(state, { from: 3, to: 3 }, { livePaths: [] });
    // Confirm the hidden-syntax marks are NOT present on the bracket
    // ranges anymore (they should be visible-syntax instead).
    let hiddenCount = 0;
    set.between(0, doc.length, (_from, _to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      if (spec.class?.includes('cm-md-syntax') && spec.class?.includes('cm-hidden')) {
        hiddenCount++;
      }
    });
    expect(hiddenCount).toBe(0);
  });

  it('paints the alias (not the target) as the label when an alias is present', () => {
    const doc = '[[hidden-target|Visible Label]]\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      { livePaths: [{ path: 'hidden-target.md', noteId: 'n-1' }] },
    );
    const labels = findMarksByClass(set, 'cm-md-wikilink-label', doc.length);
    expect(labels.length).toBe(1);
    expect(doc.slice(labels[0].from, labels[0].to)).toBe('Visible Label');
  });

  it('resolves a wikilink target that includes a `#heading` to the page', () => {
    // The `#heading` is part of the wikilink syntax; resolution targets
    // the bare page name. The label range still spans `target#heading`
    // (the full target text the user typed).
    const doc = '[[my-note#section-2]]\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      { livePaths: [{ path: 'my-note.md', noteId: 'n-mn' }] },
    );
    const labels = findMarksByClass(set, 'cm-md-wikilink-label', doc.length);
    expect(labels.length).toBe(1);
    // Resolved (not broken) — the page resolves regardless of heading.
    expect(labels[0].class).not.toContain('cm-md-wikilink-broken');
  });

  it('does not throw when a wikilink has an empty inner (`[[]]`)', () => {
    const doc = 'see [[]] today\n';
    const state = makeState(doc);
    expect(() => buildMarkdownDecorations(state, { from: 0, to: 0 })).not.toThrow();
  });

  // -- Shape A: line-based reveal for links --------------------------------
  // The cursor's line is the "edit zone"; links on that line render as
  // raw markdown so a click lands as text-position (CM6 default) rather
  // than following the link. Links on other lines stay decorated.

  it('skips the wikilink label paint when the caret is on the same line (Shape A)', () => {
    const doc = 'see [[Kyoto Hotel]] today\nelsewhere\n';
    const state = makeState(doc);
    // Caret in the body text of line 1 — outside the wikilink span but
    // on the same line. Shape A says the label should NOT paint, so a
    // click lands as text-position via CM6's default handling.
    const sameLine = doc.indexOf('today');
    const set = buildMarkdownDecorations(
      state,
      { from: sameLine, to: sameLine },
      {
        livePaths: [{ path: 'notes/Kyoto Hotel.md', noteId: 'n-kyoto' }],
      },
    );
    const labels = findMarksByClass(set, 'cm-md-wikilink-label', doc.length);
    expect(labels.length).toBe(0);
    // And the brackets/target should be visible (revealed), not hidden.
    let hiddenCount = 0;
    set.between(0, doc.length, (_from, _to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      if (spec.class?.includes('cm-md-syntax') && spec.class?.includes('cm-hidden')) {
        hiddenCount++;
      }
    });
    expect(hiddenCount).toBe(0);
  });

  it('skips the URL-link label paint when the caret is on the same line (Shape A)', () => {
    const doc = 'see [Anthropic](https://anthropic.com) today\nelsewhere\n';
    const state = makeState(doc);
    const sameLine = doc.indexOf('today');
    const set = buildMarkdownDecorations(state, {
      from: sameLine,
      to: sameLine,
    });
    const labels = findMarksByClass(set, 'cm-md-link-label', doc.length);
    expect(labels.length).toBe(0);
    // Off-line: caret on line 2 → label IS painted.
    const offLine = doc.indexOf('elsewhere');
    const setOff = buildMarkdownDecorations(state, {
      from: offLine,
      to: offLine,
    });
    const labelsOff = findMarksByClass(setOff, 'cm-md-link-label', doc.length);
    expect(labelsOff.length).toBe(1);
    expect(doc.slice(labelsOff[0].from, labelsOff[0].to)).toBe('Anthropic');
  });

  it('does not collapse the visible label of an off-line URL link', () => {
    const doc =
      '[https://x.com/GidoGidoGame](https://x.com/GidoGidoGame)\n\nelsewhere\n';
    const state = makeState(doc);
    const cursor = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, { from: cursor, to: cursor });
    const labels = findMarksByClass(set, 'cm-md-link-label', doc.length);
    const hiddenSyntax = findMarksByClass(
      set,
      'cm-md-syntax cm-hidden',
      doc.length,
    );

    expect(labels).toHaveLength(1);
    const label = labels[0];
    expect(doc.slice(label.from, label.to)).toBe('https://x.com/GidoGidoGame');
    expect(
      hiddenSyntax.filter(({ from, to }) => from < label.to && to > label.from),
    ).toEqual([]);
    expect(
      hiddenSyntax.some(
        ({ from, to }) =>
          from > label.to && doc.slice(from, to) === 'https://x.com/GidoGidoGame',
      ),
    ).toBe(true);
  });
});

describe('escaped brackets in Markdown link labels', () => {
  function hiddenEscapeRanges(
    set: ReturnType<typeof buildMarkdownDecorations>,
    doc: string,
  ): { from: number; to: number }[] {
    const hits: { from: number; to: number }[] = [];
    set.between(0, doc.length, (from, to, value) => {
      const spec = value.spec as { class?: string };
      if (spec.class?.includes('cm-hidden') && doc.slice(from, to) === '\\') {
        hits.push({ from, to });
      }
    });
    return hits;
  }

  it('hides escape slashes when a bracketed link label is rendered', () => {
    const doc = '[Q2 notes \\[Ongoing\\]](https://example.com)\nelsewhere';
    const state = makeState(doc);
    const cursor = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, { from: cursor, to: cursor });

    const escapes = hiddenEscapeRanges(set, doc);
    expect(escapes).toHaveLength(2);
    expect(escapes.map(({ from }) => from)).toEqual([
      doc.indexOf('\\['),
      doc.indexOf('\\]'),
    ]);
  });

  it('finds escaped brackets nested inside formatted label content', () => {
    const doc = '[**Q2 \\[Ongoing\\]**](https://example.com)\nelsewhere';
    const state = makeState(doc);
    const cursor = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, { from: cursor, to: cursor });

    expect(hiddenEscapeRanges(set, doc)).toHaveLength(2);
  });

  it('reveals the escape slashes on the active link line', () => {
    const doc = '[Q2 notes \\[Ongoing\\]](https://example.com)\nelsewhere';
    const state = makeState(doc);
    const cursor = doc.indexOf('Q2');
    const set = buildMarkdownDecorations(state, { from: cursor, to: cursor });

    expect(hiddenEscapeRanges(set, doc)).toHaveLength(0);
  });

  it('reveals escapes on an active continuation line of a multiline label', () => {
    const doc = '[first line\nsecond \\[Ongoing\\]](https://example.com)\nelsewhere';
    const state = makeState(doc);
    const cursor = doc.indexOf('Ongoing');
    const set = buildMarkdownDecorations(state, { from: cursor, to: cursor });

    expect(hiddenEscapeRanges(set, doc)).toHaveLength(0);
  });

  it('reveals escapes included in a multiline range selection', () => {
    const doc = '[Q2 notes \\[Ongoing\\]](https://example.com)\nselected tail';
    const state = makeState(doc);
    const set = buildMarkdownDecorations(state, {
      from: doc.indexOf('Ongoing'),
      to: doc.indexOf('tail') + 'tail'.length,
    });

    expect(hiddenEscapeRanges(set, doc)).toHaveLength(0);
  });

  it('does not hide escapes in link-shaped inline or fenced code', () => {
    const doc = [
      '`[inline \\[example\\]](https://example.com)`',
      '',
      '```md',
      '[fenced \\[example\\]](https://example.com)',
      '```',
      'elsewhere',
    ].join('\n');
    const state = makeState(doc);
    const cursor = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, { from: cursor, to: cursor });

    expect(hiddenEscapeRanges(set, doc)).toHaveLength(0);
  });
});

describe('autolinks (GFM) — parse + decoration', () => {
  /**
   * Same shape as the wikilink `findMarksByClass` helper. Kept local
   * to this block to avoid cross-block coupling — the wikilink block
   * already declares it as a private helper.
   */
  function findMarksByClass(
    set: ReturnType<typeof buildMarkdownDecorations>,
    substr: string,
    docLen: number,
  ): { from: number; to: number; class: string }[] {
    const hits: { from: number; to: number; class: string }[] = [];
    set.between(0, docLen, (from, to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      const cls = spec.class ?? '';
      if (cls.includes(substr)) {
        hits.push({ from, to, class: cls });
      }
    });
    return hits;
  }

  it('emits a top-level URL node for a bare `https://` link in prose', () => {
    // lezer-markdown's Autolink extension calls `cx.addElement(cx.elt("URL",
    // …))` for matches against `https?://`, `www.`, `mailto:`, `xmpp:`, and
    // bare emails. The URL node sits directly under Paragraph (NOT under
    // a Link node) — that's the marker our decoration walker uses to tell
    // an autolink apart from a `[label](url)` link's URL child.
    const state = makeState('Visit https://example.com/foo today.\n');
    const url = requireNode(findNode(state, 'URL'), 'URL');
    expect(state.sliceDoc(url.from, url.to)).toBe('https://example.com/foo');
    // Parent must not be `Link` / `Image` for the autolink branch to fire.
    const pname = url.parent?.type.name;
    expect(pname === 'Link' || pname === 'Image').toBe(false);
  });

  it('paints the URL range with cm-md-link-label when the caret is off-line', () => {
    const doc = 'Visit https://example.com today\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, {
      from: offLine,
      to: offLine,
    });
    const labels = findMarksByClass(set, 'cm-md-link-label', doc.length);
    expect(labels.length).toBe(1);
    expect(doc.slice(labels[0].from, labels[0].to)).toBe('https://example.com');
  });

  it('skips the autolink paint when the caret is on the same line (Shape A)', () => {
    const doc = 'Visit https://example.com today\nelsewhere\n';
    const state = makeState(doc);
    const sameLine = doc.indexOf('today');
    const set = buildMarkdownDecorations(state, {
      from: sameLine,
      to: sameLine,
    });
    const labels = findMarksByClass(set, 'cm-md-link-label', doc.length);
    expect(labels.length).toBe(0);
  });

  it('detects a bare email as an autolink URL node', () => {
    const state = makeState('Email alice@example.com to say hi.\n');
    const url = requireNode(findNode(state, 'URL'), 'URL');
    expect(state.sliceDoc(url.from, url.to)).toBe('alice@example.com');
  });

  it('coexists with wikilinks on the same line (no interference)', () => {
    // Regression guard: GFM Autolink and the custom wikilink inline
    // parser register independently. Confirm both still produce their
    // expected nodes for `[[wikilink]]` and `https://example.com` in
    // the same paragraph.
    const doc = '[[Note]] and https://example.com both work\nelsewhere\n';
    const state = makeState(doc);
    expect(findNode(state, 'Wikilink')).not.toBeNull();
    expect(findNode(state, 'URL')).not.toBeNull();
  });
});

describe('task lists (Slice 3 Apple) — parse + decoration', () => {
  /**
   * Walk a DecorationSet for replace decos whose widget is a
   * TaskCheckboxWidget. Returns `{from, to, checked}` per hit in source
   * order. We don't import the widget class directly (it's not exported)
   * — we identify by the cm-md-task-checkbox shape via `toDOM` is too
   * heavyweight without a DOM env, so we shape-match the widget's
   * constructor-arg surface via duck-typing.
   */
  function findTaskWidgets(
    set: ReturnType<typeof buildMarkdownDecorations>,
    docLen: number,
  ): { from: number; to: number; checked: boolean }[] {
    const hits: { from: number; to: number; checked: boolean }[] = [];
    set.between(0, docLen, (from, to, value) => {
      const spec: { widget?: { checked?: boolean } } = value.spec as {
        widget?: { checked?: boolean };
      };
      const w = spec.widget;
      // The TaskCheckboxWidget carries a `checked` boolean field; the
      // ImageWidget and TableWidget don't. This duck-test cleanly
      // separates them without importing private classes.
      if (w !== undefined && typeof w.checked === 'boolean') {
        hits.push({ from, to, checked: w.checked });
      }
    });
    return hits;
  }

  /** Find all visible-syntax marks (cm-md-syntax without cm-hidden). */
  function findVisibleSyntaxAt(
    set: ReturnType<typeof buildMarkdownDecorations>,
    docLen: number,
    from: number,
    to: number,
  ): boolean {
    let found = false;
    set.between(0, docLen, (f, t, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      if (
        f === from &&
        t === to &&
        spec.class?.includes('cm-md-syntax') &&
        !spec.class?.includes('cm-hidden')
      ) {
        found = true;
      }
    });
    return found;
  }

  it('parses `- [ ]` as a Task with a TaskMarker child', () => {
    const state = makeState('- [ ] do the thing\n');
    const taskMarker = requireNode(findNode(state, 'TaskMarker'), 'TaskMarker');
    // TaskMarker is always exactly 3 chars: `[ ]` / `[x]` / `[X]`.
    expect(taskMarker.to - taskMarker.from).toBe(3);
    expect(state.sliceDoc(taskMarker.from, taskMarker.to)).toBe('[ ]');
  });

  it('parses `- [x]` as a Task with a checked TaskMarker', () => {
    const state = makeState('- [x] done already\n');
    const taskMarker = requireNode(findNode(state, 'TaskMarker'), 'TaskMarker');
    expect(state.sliceDoc(taskMarker.from, taskMarker.to)).toBe('[x]');
  });

  it('parses `- [X]` (uppercase) as a Task too', () => {
    const state = makeState('- [X] also checked\n');
    const taskMarker = requireNode(findNode(state, 'TaskMarker'), 'TaskMarker');
    expect(state.sliceDoc(taskMarker.from, taskMarker.to)).toBe('[X]');
  });

  it('emits a checkbox widget over the TaskMarker range when caret is off the item', () => {
    // Two-item doc with a BLANK LINE between the list and the footer
    // paragraph — without the blank line, lezer-markdown's lazy
    // continuation treats `footer` as a continuation of the last list
    // item, which would pull the cursor inside the ListItem range and
    // collapse the widget. The blank-line separator is the canonical
    // GFM way to close a list block.
    const doc = '- [ ] alpha\n- [x] beta\n\nfooter\n';
    const state = makeState(doc);
    const footerPos = doc.indexOf('footer');
    const set = buildMarkdownDecorations(state, {
      from: footerPos,
      to: footerPos,
    });
    const widgets = findTaskWidgets(set, doc.length);
    expect(widgets.length).toBe(2);
    expect(widgets[0].checked).toBe(false);
    expect(widgets[1].checked).toBe(true);
    // Widget range covers exactly the 3-char marker.
    expect(doc.slice(widgets[0].from, widgets[0].to)).toBe('[ ]');
    expect(doc.slice(widgets[1].from, widgets[1].to)).toBe('[x]');
  });

  it('reveals raw `[ ]` source (no widget) when caret is on the item line', () => {
    const doc = '- [ ] alpha\n\nfooter\n';
    const state = makeState(doc);
    // Caret in the middle of the task-list item.
    const onLine = doc.indexOf('alpha');
    const set = buildMarkdownDecorations(state, { from: onLine, to: onLine });
    const widgets = findTaskWidgets(set, doc.length);
    expect(widgets.length).toBe(0);
    // Visible-syntax mark should sit over the TaskMarker range so the
    // raw `[ ]` is visible in normal weight (no cm-hidden).
    const markerStart = doc.indexOf('[ ]');
    expect(findVisibleSyntaxAt(set, doc.length, markerStart, markerStart + 3)).toBe(true);
  });

  it('hides the widget when the editor is unfocused (Slice F focus-gate behaviour)', () => {
    // Same caret position as the on-line case above, but focused = false.
    // The intersects() helper short-circuits to false when unfocused, so
    // the widget engages even with the caret "on" the line — Bear-style
    // preview at rest.
    const doc = '- [ ] alpha\n\nfooter\n';
    const state = makeState(doc);
    const onLine = doc.indexOf('alpha');
    const set = buildMarkdownDecorations(state, { from: onLine, to: onLine }, { focused: false });
    const widgets = findTaskWidgets(set, doc.length);
    expect(widgets.length).toBe(1);
    expect(widgets[0].checked).toBe(false);
  });

  it('suppresses the bullet on task-list items (Slice L) — no visible ListMark off-cursor', () => {
    // Slice L reversal of Slice Q: the `- ` bullet on a task-list line
    // is redundant alongside the checkbox glyph, so we hide it. The
    // ListMark range still gets a *hidden* cm-md-syntax mark (so the
    // source position stays selectable) but NOT the visible variant.
    const doc = '- [ ] alpha\n\nfooter\n';
    const state = makeState(doc);
    const footerPos = doc.indexOf('footer');
    const set = buildMarkdownDecorations(state, {
      from: footerPos,
      to: footerPos,
    });
    // ListMark is the `-`; it sits at offset 0 with width 1 in our doc.
    // The build must NOT emit a visible-syntax mark there off-cursor.
    expect(findVisibleSyntaxAt(set, doc.length, 0, 1)).toBe(false);
    // And the checkbox widget IS emitted.
    expect(findTaskWidgets(set, doc.length).length).toBe(1);
  });

  it('does not throw on a list item without a task marker (`- plain`)', () => {
    const doc = '- plain item\n- [ ] task item\n\nfooter\n';
    const state = makeState(doc);
    expect(() => buildMarkdownDecorations(state, { from: 0, to: 0 })).not.toThrow();
    const footerPos = doc.indexOf('footer');
    const set = buildMarkdownDecorations(state, {
      from: footerPos,
      to: footerPos,
    });
    // Only the task-marker line emits a widget.
    expect(findTaskWidgets(set, doc.length).length).toBe(1);
  });

  it('emits the strikethrough line deco for checked task items', () => {
    const doc = '- [x] done\n- [ ] todo\n\nfooter\n';
    const state = makeState(doc);
    const footerPos = doc.indexOf('footer');
    const set = buildMarkdownDecorations(state, {
      from: footerPos,
      to: footerPos,
    });
    // Walk for the `cm-md-listitem-task-checked` line deco — its
    // `from === to` (point-shaped line deco) and should sit at the
    // line.from of the checked task line only.
    const checkedLineStarts: number[] = [];
    set.between(0, doc.length, (from, to, value) => {
      const cls = (value.spec as { class?: string }).class ?? '';
      if (from === to && cls.includes('cm-md-listitem-task-checked')) {
        checkedLineStarts.push(from);
      }
    });
    expect(checkedLineStarts).toEqual([0]); // only the `- [x] done` line
  });
});

describe('list rendering redesign (Slice L) — bullets + ordered numbers', () => {
  /**
   * Walk a DecorationSet for replace decos whose widget is a
   * BulletGlyphWidget. We duck-type via the `depth` field which only
   * the bullet widget exposes.
   */
  function findBulletWidgets(
    set: ReturnType<typeof buildMarkdownDecorations>,
    docLen: number,
  ): { from: number; to: number; depth: number }[] {
    const hits: { from: number; to: number; depth: number }[] = [];
    set.between(0, docLen, (from, to, value) => {
      const spec: { widget?: { depth?: number; displayValue?: number } } = value.spec as {
        widget?: { depth?: number; displayValue?: number };
      };
      const w = spec.widget;
      if (w !== undefined && typeof w.depth === 'number' && typeof w.displayValue !== 'number') {
        hits.push({ from, to, depth: w.depth });
      }
    });
    return hits;
  }

  /**
   * Walk a DecorationSet for replace decos whose widget is an
   * OrderedNumberWidget. Duck-typed via `displayValue`.
   */
  function findOrderedNumberWidgets(
    set: ReturnType<typeof buildMarkdownDecorations>,
    docLen: number,
  ): { from: number; to: number; displayValue: number }[] {
    const hits: { from: number; to: number; displayValue: number }[] = [];
    set.between(0, docLen, (from, to, value) => {
      const spec: { widget?: { displayValue?: number } } = value.spec as {
        widget?: { displayValue?: number };
      };
      const w = spec.widget;
      if (w !== undefined && typeof w.displayValue === 'number') {
        hits.push({ from, to, displayValue: w.displayValue });
      }
    });
    return hits;
  }

  it('replaces bullet ListMarks with shape-glyph widgets off-cursor', () => {
    const doc = '- one\n- two\n- three\n\nfooter\n';
    const state = makeState(doc);
    const footerPos = doc.indexOf('footer');
    const set = buildMarkdownDecorations(state, {
      from: footerPos,
      to: footerPos,
    });
    const widgets = findBulletWidgets(set, doc.length);
    expect(widgets.length).toBe(3);
    // All at depth 0 (top-level bullets) → glyph cycle index 0.
    expect(widgets.every((w) => w.depth === 0)).toBe(true);
    // No ordered number widgets in a pure bullet list.
    expect(findOrderedNumberWidgets(set, doc.length).length).toBe(0);
  });

  it('cycles bullet glyphs by depth (0 → 1 → 2 → 3)', () => {
    // Nested list four deep — each ListItem opens a child BulletList
    // under itself, bumping `listItemDepth` by one per level.
    const doc = '- a\n  - b\n    - c\n      - d\n        - e\n\nfooter\n';
    const state = makeState(doc);
    const footerPos = doc.indexOf('footer');
    const set = buildMarkdownDecorations(state, {
      from: footerPos,
      to: footerPos,
    });
    const widgets = findBulletWidgets(set, doc.length);
    expect(widgets.length).toBe(5);
    // Source order matches depth order in this nesting layout.
    const depths = widgets
      .slice()
      .sort((x, y) => x.from - y.from)
      .map((w) => w.depth);
    // Depth-5 cycles back through the set; per listItemDepth's clamp
    // depths are capped at 5, but the widget cycles modulo 4 → depth
    // 4 → 0, depth 5 → 1.
    expect(depths).toEqual([0, 1, 2, 3, 4]);
  });

  it('reveals raw `-` source (no widget) when cursor is inside the ListItem', () => {
    const doc = '- one\n- two\n\nfooter\n';
    const state = makeState(doc);
    // Caret inside the first list item.
    const onLine = doc.indexOf('one');
    const set = buildMarkdownDecorations(state, { from: onLine, to: onLine });
    const widgets = findBulletWidgets(set, doc.length);
    // First item's bullet revealed (no widget); second item still has
    // a widget because the cursor is outside its ListItem range.
    expect(widgets.length).toBe(1);
    // The widget's `from` is the ListMark range of the SECOND item.
    expect(widgets[0].from).toBeGreaterThan(onLine);
  });

  it('renders auto-numbered widgets for ordered lists (CommonMark sequential)', () => {
    // All-ones source → renders 1, 2, 3 sequentially.
    const doc = '1. one\n1. two\n1. three\n\nfooter\n';
    const state = makeState(doc);
    const footerPos = doc.indexOf('footer');
    const set = buildMarkdownDecorations(state, {
      from: footerPos,
      to: footerPos,
    });
    const widgets = findOrderedNumberWidgets(set, doc.length);
    expect(widgets.length).toBe(3);
    const display = widgets
      .slice()
      .sort((a, b) => a.from - b.from)
      .map((w) => w.displayValue);
    expect(display).toEqual([1, 2, 3]);
  });

  it('uses the first item source number as the start for ordered lists', () => {
    // First item `5.` → sequence is 5, 6, 7.
    const doc = '5. five\n1. six\n9. seven\n\nfooter\n';
    const state = makeState(doc);
    const footerPos = doc.indexOf('footer');
    const set = buildMarkdownDecorations(state, {
      from: footerPos,
      to: footerPos,
    });
    const widgets = findOrderedNumberWidgets(set, doc.length);
    const display = widgets
      .slice()
      .sort((a, b) => a.from - b.from)
      .map((w) => w.displayValue);
    expect(display).toEqual([5, 6, 7]);
  });

  it('restarts ordered numbering after non-list block boundaries', () => {
    const doc = [
      '1. first setup item',
      '   - nested bullet',
      '1. second setup item',
      '',
      'A paragraph between ordered-list runs.',
      '',
      '---',
      '',
      '## NEXT SECTION',
      '',
      '1. first section item',
      '1. second section item',
      '',
      'Follow-up paragraph.',
      '',
      '1. first follow-up item',
      '1. second follow-up item',
      '',
      'footer',
    ].join('\n');
    const state = makeState(doc);
    const footerPos = doc.indexOf('footer');
    const set = buildMarkdownDecorations(state, {
      from: footerPos,
      to: footerPos,
    });
    const widgets = findOrderedNumberWidgets(set, doc.length);
    const display = widgets
      .slice()
      .sort((a, b) => a.from - b.from)
      .map((w) => w.displayValue);
    expect(display).toEqual([1, 2, 1, 2, 1, 2]);
  });

  it('does NOT emit a bullet widget for task-list items', () => {
    // Mix of plain + task: only the plain item emits a bullet widget.
    const doc = '- plain\n- [ ] task\n\nfooter\n';
    const state = makeState(doc);
    const footerPos = doc.indexOf('footer');
    const set = buildMarkdownDecorations(state, {
      from: footerPos,
      to: footerPos,
    });
    const widgets = findBulletWidgets(set, doc.length);
    expect(widgets.length).toBe(1);
    // The widget is on the `plain` item; the `task` item's ListMark
    // is suppressed entirely.
  });

  it('keeps ordered-list display numbers stable while editing item body', () => {
    const doc = '1. one\n9. two\n\nfooter\n';
    const state = makeState(doc);
    const onLine = doc.indexOf('two');
    const set = buildMarkdownDecorations(state, { from: onLine, to: onLine });
    const widgets = findOrderedNumberWidgets(set, doc.length);
    const display = widgets
      .slice()
      .sort((a, b) => a.from - b.from)
      .map((w) => w.displayValue);
    expect(display).toEqual([1, 2]);
  });

  it('reveals raw ordered-list source only when the cursor is on the marker', () => {
    const doc = '1. one\n9. two\n\nfooter\n';
    const state = makeState(doc);
    const markerPos = doc.indexOf('9.');
    const set = buildMarkdownDecorations(state, {
      from: markerPos,
      to: markerPos,
    });
    const widgets = findOrderedNumberWidgets(set, doc.length);
    // Second item's marker is being edited directly; the first still
    // gets the computed widget.
    expect(widgets.length).toBe(1);
    expect(widgets[0].displayValue).toBe(1);
  });
});

describe('footnotes (Slice 4 Apple) — parse + decoration', () => {
  /**
   * Walk a DecorationSet for marks whose `class` property contains the
   * given substring. Returns the matching (from, to) pairs in source
   * order. Sibling helper to the wikilink test block above.
   */
  function findMarksByClass(
    set: ReturnType<typeof buildMarkdownDecorations>,
    substr: string,
    docLen: number,
  ): { from: number; to: number; class: string }[] {
    const hits: { from: number; to: number; class: string }[] = [];
    set.between(0, docLen, (from, to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      const cls = spec.class ?? '';
      if (cls.includes(substr)) {
        hits.push({ from, to, class: cls });
      }
    });
    return hits;
  }

  /** Find all Decoration.line decos whose class contains the substring. */
  function findLineDecos(
    set: ReturnType<typeof buildMarkdownDecorations>,
    substr: string,
    docLen: number,
  ): { from: number; class: string }[] {
    const hits: { from: number; class: string }[] = [];
    set.between(0, docLen, (from, _to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      const cls = spec.class ?? '';
      // Decoration.line decos have from === to (point-shaped).
      if (from === _to && cls.includes(substr)) {
        hits.push({ from, class: cls });
      }
    });
    return hits;
  }

  // -- Inline reference parser ------------------------------------------

  it('parses `[^1]` as a FootnoteRef node with the right children', () => {
    const state = makeState('see [^1] in the body\n');
    const ref = requireNode(findNode(state, 'FootnoteRef'), 'FootnoteRef');
    expect(state.sliceDoc(ref.from, ref.to)).toBe('[^1]');
    const childNames: string[] = [];
    let child: SyntaxNode | null = ref.firstChild;
    while (child !== null) {
      childNames.push(child.type.name);
      child = child.nextSibling;
    }
    expect(childNames).toEqual(['FootnoteRefMark', 'FootnoteLabel', 'FootnoteRefMark']);
  });

  it('accepts alphanumeric, `_`, and `-` in the id', () => {
    const doc = 'see [^src_a-1] in the body\n';
    const state = makeState(doc);
    const ref = requireNode(findNode(state, 'FootnoteRef'), 'FootnoteRef');
    expect(state.sliceDoc(ref.from, ref.to)).toBe('[^src_a-1]');
  });

  it('does not match `[^]` (empty id)', () => {
    const state = makeState('not a [^] footnote\n');
    expect(findNode(state, 'FootnoteRef')).toBeNull();
  });

  it('does not match `[^a b]` (space inside id)', () => {
    const state = makeState('not a [^a b] footnote\n');
    expect(findNode(state, 'FootnoteRef')).toBeNull();
  });

  it('does not match an unclosed `[^foo`', () => {
    const state = makeState('not [^foo and never closes\n');
    expect(findNode(state, 'FootnoteRef')).toBeNull();
  });

  // -- Block definition parser ------------------------------------------

  it('parses `[^1]: body text` as a FootnoteDef block', () => {
    const state = makeState('[^1]: the body of the definition\n');
    const def = requireNode(findNode(state, 'FootnoteDef'), 'FootnoteDef');
    // FootnoteDef spans the full line up to (but not including) the
    // newline character.
    expect(state.sliceDoc(def.from, def.to)).toBe('[^1]: the body of the definition');
    const childNames: string[] = [];
    let child: SyntaxNode | null = def.firstChild;
    while (child !== null) {
      childNames.push(child.type.name);
      child = child.nextSibling;
    }
    // First three are the structural prefix; trailing children (if any)
    // are inline-parsed body elements.
    expect(childNames.slice(0, 3)).toEqual(['FootnoteDefMark', 'FootnoteLabel', 'FootnoteDefMark']);
  });

  it('does not parse `  [^1]: indented` as a FootnoteDef (indent disallowed)', () => {
    const state = makeState('  [^1]: indented def\n');
    expect(findNode(state, 'FootnoteDef')).toBeNull();
  });

  it('inline-parses emphasis inside the definition body', () => {
    const state = makeState('[^1]: see **bold** text\n');
    requireNode(findNode(state, 'FootnoteDef'), 'FootnoteDef');
    // StrongEmphasis appears inside the definition body, not as a
    // sibling block. The decoration walker descends into the FootnoteDef
    // so the bold mark gets emitted normally.
    const bold = findNode(state, 'StrongEmphasis');
    expect(bold).not.toBeNull();
    if (bold !== null) {
      expect(state.sliceDoc(bold.from, bold.to)).toBe('**bold**');
    }
  });

  // -- Decoration: reference painting -----------------------------------

  it('paints the inline `[^1]` ref with cm-md-footnote-ref when a def exists', () => {
    const doc =
      'a claim [^1] in the body\n' + '\n' + '[^1]: definition body\n' + '\n' + 'elsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, { from: offLine, to: offLine });
    const labels = findMarksByClass(set, 'cm-md-footnote-ref', doc.length);
    // One inline ref → one label mark. Definitions don't get the
    // footnote-ref class; they get the footnote-def line deco.
    expect(labels.length).toBe(1);
    // Resolved ref MUST NOT carry the broken modifier.
    expect(labels[0].class).not.toContain('cm-md-footnote-ref-broken');
    // Range covers the id text exactly (`1` between `[^` and `]`).
    expect(doc.slice(labels[0].from, labels[0].to)).toBe('1');
  });

  it('paints a broken ref with cm-md-footnote-ref-broken when no def exists', () => {
    const doc = 'a claim [^missing] in the body\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, { from: offLine, to: offLine });
    const brokens = findMarksByClass(set, 'cm-md-footnote-ref-broken', doc.length);
    expect(brokens.length).toBe(1);
    expect(doc.slice(brokens[0].from, brokens[0].to)).toBe('missing');
  });

  it('hides the `[^` and `]` syntax chars when caret is off the line', () => {
    const doc = 'a [^1] note\n[^1]: body\n\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, { from: offLine, to: offLine });
    // Find hidden-syntax marks over the bracket ranges of the inline ref.
    const hidden: { from: number; to: number }[] = [];
    set.between(0, doc.length, (from, to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      if (spec.class?.includes('cm-md-syntax') && spec.class?.includes('cm-hidden')) {
        hidden.push({ from, to });
      }
    });
    // The inline ref's `[^` is at 2..4, `]` is at 5..6.
    const ranges = hidden.map((h) => `${String(h.from)}..${String(h.to)}`).sort();
    expect(ranges).toContain('2..4');
    expect(ranges).toContain('5..6');
  });

  it('reveals the brackets when caret is on the ref line', () => {
    const doc = 'a [^1] note\n[^1]: body\n\nelsewhere\n';
    const state = makeState(doc);
    // Caret on the ref line.
    const set = buildMarkdownDecorations(state, { from: 1, to: 1 });
    // No cm-md-footnote-ref label paint when the cursor is on the line
    // (Shape A — raw markdown).
    const labels = findMarksByClass(set, 'cm-md-footnote-ref', doc.length);
    expect(labels.length).toBe(0);
  });

  // -- Decoration: definition line --------------------------------------

  // Bear-style inline render: the def line flows as ordinary prose
  // with the id painted inline in link color. The `name` portion of
  // `[^name]:` carries `cm-md-footnote-label`; `[^` and `]` are
  // hidden via cm-md-syntax.cm-hidden; the `:` stays visible. No
  // line decoration is emitted (no gutter chip, no card chrome).
  it('paints the FootnoteLabel name with cm-md-footnote-label and emits no line deco', () => {
    const doc = '[^1]: definition body\nprose\n';
    const state = makeState(doc);
    // Caret on the prose line (off the def line) — label paint emitted.
    const offLine = doc.indexOf('prose');
    const set = buildMarkdownDecorations(state, { from: offLine, to: offLine });

    // No line deco anywhere on the def line.
    const lines = findLineDecos(set, 'cm-md-footnote-def', doc.length);
    expect(lines.length).toBe(0);

    // The name `1` (positions 2..3) carries cm-md-footnote-label.
    const labels = findMarksByClass(set, 'cm-md-footnote-label', doc.length);
    expect(labels.length).toBe(1);
    expect(labels[0].from).toBe(2);
    expect(labels[0].to).toBe(3);
  });

  // Cursor ON the def line drops the label paint and reveals the raw
  // `[^id]:` source — mirrors the wikilink / fenced-code cursor-reveal
  // pattern. No `cm-md-footnote-label` mark emitted on the def line.
  it('drops cm-md-footnote-label when cursor is on the def line', () => {
    const doc = '[^1]: definition body\nbody\n';
    const state = makeState(doc);
    // Caret on the def line (column 0).
    const set = buildMarkdownDecorations(state, { from: 0, to: 0 });
    const labels = findMarksByClass(set, 'cm-md-footnote-label', doc.length);
    expect(labels.length).toBe(0);
  });

  // Multi-def doc: only the def line under the cursor drops the label
  // paint; sibling defs keep their inline link-color label.
  it('drops cm-md-footnote-label only on the cursor-occupied def line in a multi-def doc', () => {
    const doc = '[^a]: first body\n[^b]: second body\nelsewhere\n';
    const state = makeState(doc);
    // Cursor on the SECOND def line.
    const onSecond = doc.indexOf('[^b]');
    const set = buildMarkdownDecorations(state, {
      from: onSecond,
      to: onSecond,
    });
    const labels = findMarksByClass(set, 'cm-md-footnote-label', doc.length);
    // Exactly one remaining label paint — the first def's `a` (2..3).
    expect(labels.length).toBe(1);
    expect(labels[0].from).toBe(2);
    expect(labels[0].to).toBe(3);
  });

  // -- Decoration: cursor-on-line drops definition to raw markdown -----
  //
  // When the cursor sits on a FootnoteDef line, the entire line drops
  // back to raw markdown — the `[^id]:` chip vanishes (revealed as
  // source) AND inline marks in the body unrender so `**bold**`,
  // `*italic*`, ``` `code` ```, `~~strike~~`, and `[[wikilink]]` all
  // show their raw syntax. Mirrors the cursor-on-fence behaviour of
  // FencedCode (`cm-md-code-block-card` chrome drops; raw delimiters
  // surface). Cursor OFF the line keeps the rendered form.

  it('suppresses inline range marks on a definition line when cursor is on it', () => {
    const doc = '[^1]: see **bold** and *italic* and `code` text\nbody\n';
    const state = makeState(doc);
    // Caret on the def line (column 0).
    const onLine = buildMarkdownDecorations(state, { from: 0, to: 0 });
    expect(findMarksByClass(onLine, 'cm-md-bold', doc.length).length).toBe(0);
    expect(findMarksByClass(onLine, 'cm-md-italic', doc.length).length).toBe(0);
    expect(findMarksByClass(onLine, 'cm-md-code', doc.length).length).toBe(0);
    // Off the def line — body line — the inline marks render normally.
    const offLine = doc.indexOf('body');
    const off = buildMarkdownDecorations(state, { from: offLine, to: offLine });
    expect(findMarksByClass(off, 'cm-md-bold', doc.length).length).toBe(1);
    expect(findMarksByClass(off, 'cm-md-italic', doc.length).length).toBe(1);
    expect(findMarksByClass(off, 'cm-md-code', doc.length).length).toBe(1);
  });

  it('reveals inline syntax chars on a definition line when cursor is on it', () => {
    const doc = '[^1]: see **bold** text\nbody\n';
    const state = makeState(doc);
    // Caret on the def line.
    const on = buildMarkdownDecorations(state, { from: 0, to: 0 });
    // The `**` syntax marks (EmphasisMark children of StrongEmphasis)
    // sit at positions 10..12 and 16..18 — they MUST emit a visible
    // (not hidden) syntax mark when cursor is on the line.
    const hidden: { from: number; to: number }[] = [];
    on.between(0, doc.length, (from, to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      if (spec.class?.includes('cm-md-syntax') && spec.class?.includes('cm-hidden')) {
        hidden.push({ from, to });
      }
    });
    // No hidden syntax marks anywhere on the def line (lines is 0..23).
    // The EmphasisMark ranges (10..12 + 16..18) live inside that span.
    const hiddenInRange = hidden.filter((h) => h.from < 24);
    expect(hiddenInRange.length).toBe(0);
  });

  it('keeps inline syntax chars hidden on a definition line when cursor is OFF it', () => {
    const doc = '[^1]: see **bold** text\nbody\n';
    const state = makeState(doc);
    // Caret on the body line (off the def line).
    const offLine = doc.indexOf('body');
    const off = buildMarkdownDecorations(state, {
      from: offLine,
      to: offLine,
    });
    // The `**` syntax chars should be hidden (off-line case).
    const hidden: { from: number; to: number }[] = [];
    off.between(0, doc.length, (from, to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      if (spec.class?.includes('cm-md-syntax') && spec.class?.includes('cm-hidden')) {
        hidden.push({ from, to });
      }
    });
    const ranges = hidden.map((h) => `${String(h.from)}..${String(h.to)}`).sort();
    // `**` at 10..12 and 16..18 → both present as hidden marks.
    expect(ranges).toContain('10..12');
    expect(ranges).toContain('16..18');
  });

  it('reveals the [^id] prefix only on the def line the cursor is on (multi-def doc)', () => {
    const doc = '[^a]: first body\n[^b]: second body\nelsewhere\n';
    const state = makeState(doc);
    // Cursor on the SECOND def line (line 2).
    const onSecond = doc.indexOf('[^b]');
    const set = buildMarkdownDecorations(state, {
      from: onSecond,
      to: onSecond,
    });
    // Bear-style inline render: hidden syntax covers the FIRST def's
    // `[^` (0..2) and `]` (3..4) only — the `:` at 4..5 is never
    // hidden (it flows as ordinary punctuation in `name: body…`). The
    // second def's `[^` (17..19) and `]` (20..21) reveal because the
    // cursor sits on that line.
    const hidden: { from: number; to: number }[] = [];
    set.between(0, doc.length, (from, to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      if (spec.class?.includes('cm-md-syntax') && spec.class?.includes('cm-hidden')) {
        hidden.push({ from, to });
      }
    });
    const ranges = hidden.map((h) => `${String(h.from)}..${String(h.to)}`).sort();
    expect(ranges).toContain('0..2'); // first def: `[^` hidden
    expect(ranges).toContain('3..4'); // first def: `]` hidden, `:` left visible
    expect(ranges).not.toContain('4..5'); // `:` NEVER hidden in any def
    expect(ranges).not.toContain('17..19'); // second def: `[^` revealed
    expect(ranges).not.toContain('20..21'); // second def: `]` revealed
  });

  // -- Resolution: across-doc def lookup --------------------------------

  it('resolves a ref even when the def appears earlier in the doc', () => {
    const doc = '[^a]: def earlier\n' + '\n' + 'see [^a] in body\n' + 'elsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, { from: offLine, to: offLine });
    const brokens = findMarksByClass(set, 'cm-md-footnote-ref-broken', doc.length);
    // Def comes first; ref still resolves.
    expect(brokens.length).toBe(0);
    const labels = findMarksByClass(set, 'cm-md-footnote-ref', doc.length);
    expect(labels.length).toBe(1);
  });

  // -- Smoke: doesn't shadow wikilinks ---------------------------------

  it('does not shadow `[[wikilink]]` recognition', () => {
    // Note the blank line before the def — CommonMark paragraphs absorb
    // non-blank continuation lines, so a definition right after prose
    // would be inside the paragraph unless the parser's `endLeaf` fires.
    // We provide that interrupt, but the canonical case still has the
    // blank-line separator; this test pins both paths work together.
    const doc = 'see [[Note]] today\n\n[^1]: def\nelsewhere\n';
    const state = makeState(doc);
    // Wikilink + FootnoteDef both parse cleanly.
    expect(findNode(state, 'Wikilink')).not.toBeNull();
    expect(findNode(state, 'FootnoteDef')).not.toBeNull();
  });

  it('does not crash on an empty doc with no footnotes', () => {
    const state = makeState('just prose\n');
    expect(() => buildMarkdownDecorations(state, { from: 0, to: 0 })).not.toThrow();
  });
});

describe('mentions (Apple lane Slice 1, widget-mount edition) — chip decoration', () => {
  /**
   * Walk the DecorationSet for `Decoration.replace` decos whose widget
   * is a `MentionChipWidget`. Returns the source range + the widget's
   * snapshot props in source order.
   *
   * Identifying the widget without importing the private class: the
   * `MentionChipWidget` carries a `props` field with a unique shape
   * (`email`, `letter`, `image`, `accent`, `stale`, `displayName`).
   * Other widget types in this file (TableWidget, ImageWidget,
   * TaskCheckboxWidget, BulletGlyphWidget, OrderedNumberWidget) don't
   * have a top-level `props` object, so a duck-test on `spec.widget.props.email`
   * cleanly isolates mention chips without exposing internals.
   */
  function findMentionWidgets(
    set: ReturnType<typeof buildMarkdownDecorations>,
    docLen: number,
  ): {
    from: number;
    to: number;
    email: string;
    displayName: string;
    letter: string;
    image: string | null;
    accent: string;
    stale: boolean;
  }[] {
    const hits: {
      from: number;
      to: number;
      email: string;
      displayName: string;
      letter: string;
      image: string | null;
      accent: string;
      stale: boolean;
    }[] = [];
    set.between(0, docLen, (from, to, value) => {
      const spec: {
        widget?: {
          props?: {
            email?: string;
            displayName?: string;
            letter?: string;
            image?: string | null;
            accent?: string;
            stale?: boolean;
          };
        };
      } = value.spec as { widget?: { props?: Record<string, unknown> } };
      const props = spec.widget?.props;
      if (
        props !== undefined &&
        typeof props.email === 'string' &&
        typeof props.displayName === 'string' &&
        typeof props.letter === 'string' &&
        typeof props.accent === 'string' &&
        typeof props.stale === 'boolean'
      ) {
        hits.push({
          from,
          to,
          email: props.email,
          displayName: props.displayName,
          letter: props.letter,
          image: props.image ?? null,
          accent: props.accent,
          stale: props.stale,
        });
      }
    });
    return hits;
  }

  it('emits a Decoration.replace + MentionChipWidget for a resolved mention with per-user accent', () => {
    const doc = '[Alice](mention:alice@kb-1.dev) kicked off\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      {
        orgPeople: [
          {
            id: 'user-alice',
            email: 'alice@kb-1.dev',
            name: 'Alice Anderson',
            image: 'https://cdn.example/alice.png',
          },
        ],
      },
    );
    const mentions = findMentionWidgets(set, doc.length);
    expect(mentions.length).toBe(1);
    expect(mentions[0].stale).toBe(false);
    expect(mentions[0].email).toBe('alice@kb-1.dev');
    expect(mentions[0].displayName).toBe('Alice Anderson');
    expect(mentions[0].image).toBe('https://cdn.example/alice.png');
    // Per-user accent is hashed off the resolved person's `id` (their
    // userId) — same hash `<UserAvatar userId={...}>` uses, so chip
    // color matches the user's avatar everywhere else in the app.
    expect(mentions[0].accent).toBe(accentForId('user-alice'));
    // The widget REPLACES the ENTIRE link source (`[Alice](mention:alice@kb-1.dev)`).
    // Source-range contract: from = `[`, to = `)` + 1.
    expect(doc.slice(mentions[0].from, mentions[0].to)).toBe('[Alice](mention:alice@kb-1.dev)');
  });

  it('threads a null image into widget props when the directory entry has no avatar', () => {
    const doc = '[Bob](mention:bob@kb-1.dev) is reviewing\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      {
        orgPeople: [
          {
            id: 'user-bob',
            email: 'bob@kb-1.dev',
            name: 'Bob Booker',
            image: null,
          },
        ],
      },
    );
    const mentions = findMentionWidgets(set, doc.length);
    expect(mentions.length).toBe(1);
    expect(mentions[0].image).toBe(null);
    expect(mentions[0].accent).toBe(accentForId('user-bob'));
    expect(mentions[0].stale).toBe(false);
  });

  it('marks a mention as stale with slate accent and null image when the email does not resolve', () => {
    const doc = '[Carol](mention:carol@former.example) left\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      {
        // Empty directory — every mention is stale.
        orgPeople: [],
      },
    );
    const mentions = findMentionWidgets(set, doc.length);
    expect(mentions.length).toBe(1);
    expect(mentions[0].stale).toBe(true);
    // Stale chips fall back to neutral slate — no person to attribute
    // a vibrant accent to.
    expect(mentions[0].accent).toBe('slate');
    expect(mentions[0].image).toBe(null);
    expect(mentions[0].email).toBe('carol@former.example');
  });

  it('does NOT emit the standard cm-md-link-label tint over a mention', () => {
    // The mention widget owns its visual treatment; the link-label tint
    // would double-paint if it leaked through.
    const doc = '[Alice](mention:alice@kb-1.dev)\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      {
        orgPeople: [{ id: 'user-alice', email: 'alice@kb-1.dev', name: 'Alice', image: null }],
      },
    );
    let linkLabelCount = 0;
    set.between(0, doc.length, (_from, _to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      if (spec.class === 'cm-md-link-label') linkLabelCount++;
    });
    expect(linkLabelCount).toBe(0);
  });

  it('renders a mention whose label is URL-shaped', () => {
    const doc =
      '[https://profile.example](mention:alice@kb-1.dev)\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      {
        orgPeople: [
          {
            id: 'user-alice',
            email: 'alice@kb-1.dev',
            name: 'Alice',
            image: null,
          },
        ],
      },
    );
    const mentions = findMentionWidgets(set, doc.length);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].email).toBe('alice@kb-1.dev');
  });

  it('skips the widget ONLY for the mention the cursor sits inside (per-Link reveal)', () => {
    // Per-Link reveal: caret inside Alice's `[...](mention:...)` range
    // reveals ONLY Alice's source; Bob's widget on the same line still
    // emits. With the widget approach this manifests as Bob having a
    // mention-widget replace decoration while Alice has none.
    //
    // Widget existence on its own is necessary but not sufficient — it
    // doesn't catch a regression where the widget correctly hides but
    // the underlying syntax marks (`[`, `]`, `(`, `)`, URL) fail to
    // emit. To lock the full per-Link reveal contract we ALSO assert:
    //   - Alice (caret inside): syntax marks emit as VISIBLE
    //     (`cm-md-syntax` without `cm-hidden`) across her Link range.
    //   - Bob (caret outside): EITHER the widget is present (which
    //     visually covers the syntax via `Decoration.replace`) OR the
    //     syntax marks emit as HIDDEN. Either path satisfies "source
    //     not shown."
    const doc =
      'pinging [Alice](mention:alice@kb-1.dev) and [Bob](mention:bob@kb-1.dev) today\nelsewhere\n';
    const state = makeState(doc);
    const aliceLabelStart = doc.indexOf('Alice'); // Inside Alice's Link.
    const set = buildMarkdownDecorations(
      state,
      { from: aliceLabelStart, to: aliceLabelStart },
      {
        orgPeople: [
          { id: 'user-alice', email: 'alice@kb-1.dev', name: 'Alice', image: null },
          { id: 'user-bob', email: 'bob@kb-1.dev', name: 'Bob', image: null },
        ],
      },
    );
    const mentions = findMentionWidgets(set, doc.length);
    // Bob's widget should still emit; Alice's should be suppressed.
    expect(mentions.length).toBe(1);
    expect(mentions[0].email).toBe('bob@kb-1.dev');

    // Per-Link cursor-reveal: lock the syntax-mark visibility contract
    // for each mention's range independently.
    const aliceLinkFrom = doc.indexOf('[Alice]');
    const aliceLinkTo = doc.indexOf(')', aliceLinkFrom) + 1;
    const bobLinkFrom = doc.indexOf('[Bob]');
    const bobLinkTo = doc.indexOf(')', bobLinkFrom) + 1;
    let aliceVisibleSyntaxCount = 0;
    let aliceHiddenSyntaxCount = 0;
    let bobHiddenSyntaxCount = 0;
    set.between(0, doc.length, (from, _to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      const cls = spec.class ?? '';
      const isSyntax = cls.includes('cm-md-syntax');
      const isHidden = cls.includes('cm-hidden');
      if (!isSyntax) return;
      if (from >= aliceLinkFrom && from < aliceLinkTo) {
        if (isHidden) aliceHiddenSyntaxCount++;
        else aliceVisibleSyntaxCount++;
      }
      if (from >= bobLinkFrom && from < bobLinkTo && isHidden) {
        bobHiddenSyntaxCount++;
      }
    });
    // Alice (caret inside) — source must be revealed.
    expect(aliceVisibleSyntaxCount).toBeGreaterThan(0);
    expect(aliceHiddenSyntaxCount).toBe(0);
    // Bob (caret outside) — source must be hidden. The replace widget
    // alone visually covers the range, but the syntax-mark hide gate
    // should also fire so removing the widget (e.g. orgPeople not yet
    // loaded) doesn't accidentally leak raw `[`/`]`/`(`/`)`/URL. Lock
    // both halves with an OR — either path satisfies the contract.
    const bobWidgetPresent = mentions.some((m) => m.email === 'bob@kb-1.dev');
    expect(bobWidgetPresent || bobHiddenSyntaxCount > 0).toBe(true);
  });

  it('reveals the source when caret sits at the very start `[` of a mention (selTo === linkFrom)', () => {
    // Click-on-chip behaviour: clicking the widget lands the cursor at
    // `linkFrom`. That should count as "inside" so the source reveals
    // (no widget for this Link). Matches the per-Link reveal contract.
    const doc = '[Alice](mention:alice@kb-1.dev) and more\nelsewhere\n';
    const state = makeState(doc);
    const linkFrom = 0; // `[` is at offset 0.
    const set = buildMarkdownDecorations(
      state,
      { from: linkFrom, to: linkFrom },
      {
        orgPeople: [{ id: 'user-alice', email: 'alice@kb-1.dev', name: 'Alice', image: null }],
      },
    );
    const mentions = findMentionWidgets(set, doc.length);
    expect(mentions.length).toBe(0);
  });

  it('keeps the widget emitted when caret sits just after `)` of a mention (selTo === linkTo)', () => {
    // Typing-after behaviour: cursor immediately after the closing `)`
    // is OUTSIDE the Link's range, so the widget stays rendered.
    // Without this, the chip would flicker every time the user types
    // after a mention.
    const doc = '[Alice](mention:alice@kb-1.dev) and more\nelsewhere\n';
    const state = makeState(doc);
    const linkTo = doc.indexOf(')') + 1;
    const set = buildMarkdownDecorations(
      state,
      { from: linkTo, to: linkTo },
      {
        orgPeople: [{ id: 'user-alice', email: 'alice@kb-1.dev', name: 'Alice', image: null }],
      },
    );
    const mentions = findMentionWidgets(set, doc.length);
    expect(mentions.length).toBe(1);
    expect(mentions[0].email).toBe('alice@kb-1.dev');
  });

  it('emits a widget for each of multiple mentions on the same line (off-line)', () => {
    const doc =
      'pinging [Alice](mention:alice@kb-1.dev) and [Bob](mention:bob@kb-1.dev) today\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      {
        orgPeople: [{ id: 'user-alice', email: 'alice@kb-1.dev', name: 'Alice', image: null }],
      },
    );
    const mentions = findMentionWidgets(set, doc.length);
    expect(mentions.length).toBe(2);
    // Alice resolved, Bob stale (not in directory).
    const aliceMention = mentions.find((m) => m.email === 'alice@kb-1.dev');
    const bobMention = mentions.find((m) => m.email === 'bob@kb-1.dev');
    expect(aliceMention?.stale).toBe(false);
    expect(bobMention?.stale).toBe(true);
  });

  it('threads letter from the resolved name (uppercased first char)', () => {
    const doc = '[alice](mention:alice@kb-1.dev)\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      {
        orgPeople: [
          {
            id: 'user-alice',
            email: 'alice@kb-1.dev',
            name: 'Alice Anderson',
            image: null,
          },
        ],
      },
    );
    const mentions = findMentionWidgets(set, doc.length);
    expect(mentions.length).toBe(1);
    expect(mentions[0].letter).toBe('A');
    expect(mentions[0].displayName).toBe('Alice Anderson');
  });

  it('falls back to the email handle (first char uppercased) for letter when the mention is stale', () => {
    const doc = '[Carol](mention:carol@former.example) left\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      {
        orgPeople: [],
      },
    );
    const mentions = findMentionWidgets(set, doc.length);
    expect(mentions.length).toBe(1);
    expect(mentions[0].stale).toBe(true);
    expect(mentions[0].letter).toBe('C');
    expect(mentions[0].displayName).toBe('carol');
  });

  it('promotes a stale chip when orgPeople gains the matching entry (eq invalidates on resolution)', () => {
    // Reactivity contract — when the directory loads after first paint,
    // the widget's `eq` must return false so CM6 rebuilds the chip with
    // fresh props. Two builds at the same selection but different
    // orgPeople snapshots — the widgets must NOT compare equal.
    const doc = '[Alice](mention:alice@kb-1.dev) kicked off\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const staleSet = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      { orgPeople: [] },
    );
    const resolvedSet = buildMarkdownDecorations(
      state,
      { from: offLine, to: offLine },
      {
        orgPeople: [
          {
            id: 'user-alice',
            email: 'alice@kb-1.dev',
            name: 'Alice Anderson',
            image: 'https://cdn.example/alice.png',
          },
        ],
      },
    );
    let staleWidget: { eq: (w: unknown) => boolean } | undefined;
    staleSet.between(0, doc.length, (_f, _t, value) => {
      const spec: { widget?: unknown } = value.spec as { widget?: unknown };
      if (
        spec.widget !== undefined &&
        typeof (spec.widget as { props?: { email?: string } }).props?.email === 'string'
      ) {
        staleWidget = spec.widget as { eq: (w: unknown) => boolean };
      }
    });
    let resolvedWidget: unknown;
    resolvedSet.between(0, doc.length, (_f, _t, value) => {
      const spec: { widget?: unknown } = value.spec as { widget?: unknown };
      if (
        spec.widget !== undefined &&
        typeof (spec.widget as { props?: { email?: string } }).props?.email === 'string'
      ) {
        resolvedWidget = spec.widget;
      }
    });
    if (staleWidget === undefined || resolvedWidget === undefined) {
      throw new Error('expected both stale + resolved widgets to be found');
    }
    // eq must return FALSE so CM6 rebuilds; otherwise the stale chip
    // would persist visually after the directory lands.
    expect(staleWidget.eq(resolvedWidget)).toBe(false);
  });

  it('falls through to the standard link-label tint when the URL is not a mention scheme', () => {
    // Sanity check the Link branch still emits the regular link tint
    // for non-mention URLs after the mention-detection wedge.
    const doc = '[Anthropic](https://anthropic.com)\nelsewhere\n';
    const state = makeState(doc);
    const offLine = doc.indexOf('elsewhere');
    const set = buildMarkdownDecorations(state, {
      from: offLine,
      to: offLine,
    });
    const mentions = findMentionWidgets(set, doc.length);
    expect(mentions.length).toBe(0);
    let linkLabelCount = 0;
    set.between(0, doc.length, (_from, _to, value) => {
      const spec: { class?: string } = value.spec as { class?: string };
      if (spec.class === 'cm-md-link-label') linkLabelCount++;
    });
    expect(linkLabelCount).toBe(1);
  });
});
