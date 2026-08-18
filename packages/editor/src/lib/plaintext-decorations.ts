/**
 * Live-Preview-style markdown decorations for the plaintext editor.
 *
 * Current scope (post-Slice-4 fix-pass + Slice p polish):
 *   - Headings (ATX h1–h6) with `# `-mark hide that extends one char
 *     past the HeaderMark to swallow the trailing space (so heading
 *     text starts flush at the left edge when the cursor is off-line).
 *   - Inline emphasis: bold (`**...**` / `__...__`), italic, GFM
 *     strikethrough (`~~...~~`), inline code (`` `...` ``).
 *   - Bullet + ordered lists with nested depth (0..5+, clamped).
 *   - Blockquotes (rendered as a callout: accent bar + tinted bg
 *     via the CSS in PlaintextEditor.svelte).
 *   - Fenced code blocks with syntax highlighting for a curated set
 *     of inner languages (TS/JS/TSX/JSX, Python, JSON, HTML, CSS).
 *   - GFM tables as block widgets (real `<table>` with rounded
 *     corners + header tint + subtle zebra; see TableWidget below
 *     and the `table.cm-md-table` rules in PlaintextEditor.svelte).
 *   - Inline images as widgets (`![alt](path)` → `<img>`), with
 *     attachment-path remapping via the optional `attachmentSrc`
 *     option threaded down from the editor mount.
 *   - GFM task lists (`- [ ]` / `- [x]`) rendering the 3-char marker
 *     as an interactive `<input type="checkbox">` widget. Click toggles
 *     the source via a single `view.dispatch` (undoable via Ctrl-Z).
 *     Cursor-on-line reveals the raw `[ ]`/`[x]` source for keyboard
 *     editing — same focus-aware reveal pattern as ListMark.
 *
 * Still deferred to later slices: GFM autolinks, footnotes, link
 * click/hover affordances.
 *
 * Slice F (focus-aware reveal): cursor-reveal AND-gated by editor
 * focus. When the editor loses DOM focus, every syntax char hides —
 * the document reads as a full Bear-style preview at rest. When the
 * editor regains focus, normal cursor-reveal resumes. Focus is a
 * VIEW-level concept (`EditorView.hasFocus`), but our decorations
 * live in a StateField (block widgets require that — see the
 * StateField comment at the bottom of this file). The fix is a tiny
 * bridge: a `ViewPlugin` listens for `update.focusChanged`, dispatches
 * a `focusEffect` carrying `view.hasFocus`, and a sibling
 * `editorFocusField` stores the boolean. The decoration field reads
 * that field via `tr.state.field(...)` and ANDs it with the cursor-
 * inside predicate. ListMarks follow the Slice L reveal pattern
 * (replacing Slice Q's always-visible behaviour): off-cursor, bullets
 * render as shape-glyph widgets (○/▷/●/▶ by depth) and ordered
 * numbers render as auto-numbered widgets. Bullet/task items reveal
 * the raw marker when the cursor is inside the item. Ordered items
 * reveal the raw marker only when the cursor is directly on the marker,
 * so body editing does not surface stale source numbers. Task-bearing
 * list items suppress the bullet entirely off-cursor — the checkbox IS
 * the leading affordance.
 *
 * Pattern target: Obsidian Live Preview. When the cursor (or selection
 * range) is outside a decorated range, the syntax characters (`**`,
 * `*`, `_`, `~~`, `` ` ``, `# `, `- `, `1. `, `> `, ` ``` `, image /
 * table source) are hidden — for inline marks via the
 * `.cm-md-syntax.cm-hidden` rule, for block widgets via
 * `Decoration.replace({ widget })`. When the cursor enters a range,
 * the syntax characters are revealed so the user can edit them.
 *
 * --- Pipeline placement ----------------------------------------------
 *
 * Markdown decorations are document-driven: they rebuild on doc changes
 * (the lezer-markdown parse tree updates) and on selection changes
 * (cursor-reveal). The result is exposed through EditorView.decorations.
 *
 * --- Architecture ----------------------------------------------------
 *
 * 1. `markdown({ extensions: [Strikethrough, Table, TaskList], codeLanguages })`
 *    from `@codemirror/lang-markdown` parses the doc into a lezer-
 *    markdown tree. GFM Strikethrough + GFM Table + GFM TaskList are
 *    enabled; Autolink remains off (later slice).
 *    `codeLanguages` nests an inner CodeMirror language inside fenced
 *    code blocks so `syntaxHighlighting(defaultHighlightStyle)`
 *    (mounted in the extension list below) lights up token classes
 *    via the lezer highlighter tags emitted by the inner parser.
 *
 * 2. A `StateField` (not a `ViewPlugin` — see the StateField comment
 *    near the bottom of this file for the block-decoration rationale)
 *    walks the tree via `syntaxTree(state).iterate(...)` on every
 *    transaction where the doc or selection changed, accumulating
 *    `Decoration.line(...)` for line-shaped nodes, `Decoration.mark(...)`
 *    for inline emphasis / inline-code / syntax characters, and
 *    `Decoration.replace({ widget })` for block widgets (Table) and
 *    inline widgets (Image). Items are sorted and fed through a
 *    single `RangeSetBuilder` so CM6's monotonic-position invariant
 *    holds at every offset.
 *
 * 3. The result is exposed via `EditorView.decorations.from(field)` so
 *    the rendered DOM picks them up. Block widgets force the StateField
 *    shape; mark + line decorations are happy from either side. See
 *    `markdownDecorationField` below.
 *
 * --- Lezer-markdown node names used here -----------------------------
 *
 *   Line-shaped:
 *     ATXHeading1..ATXHeading6  — `# Foo`, `## Foo`, ...
 *     ListItem                  — one entry in a BulletList or OrderedList
 *     Blockquote                — `> ...` (one or more contiguous lines)
 *     FencedCode                — ```lang ... ``` block
 *
 *   Inline-shaped (mark):
 *     StrongEmphasis            — `**bold**` or `__bold__`
 *     Emphasis                  — `*italic*` or `_italic_`
 *     Strikethrough             — `~~strike~~` (GFM)
 *     InlineCode                — `` `code` ``
 *
 *   Syntax-character children of the above (hidden when cursor outside):
 *     HeaderMark, EmphasisMark, StrikethroughMark, CodeMark,
 *     ListMark (the `-` / `*` / `1.` token), QuoteMark (the `>` token).
 *     For FencedCode the opening / closing fence is also `CodeMark`
 *     children of the FencedCode parent — we disambiguate by parent
 *     name.
 *
 * --- Cursor-reveal pattern -------------------------------------------
 *
 * For each decorated range we check whether the main selection's head
 * falls strictly within `[range.from, range.to]` (inclusive at both
 * ends so caret-at-boundary reveals — Obsidian behaviour). If yes, we
 * skip emitting `cm-hidden` marks for that range's syntax characters.
 * If no, we emit them. The decoration mark itself (bold/italic/...)
 * is always emitted; only the syntax-char visibility flips.
 *
 * For line-anchored block constructs (lists, blockquotes, fences) the
 * enclosing range is the entire BLOCK — so the cursor anywhere on
 * any line of a multi-line blockquote / fence reveals the syntax on
 * every line of that block. This matches Obsidian: enter the fence,
 * the ```` ``` ```` markers come into view; leave, they vanish.
 *
 * --- Nesting (lists) -------------------------------------------------
 *
 * BulletList and OrderedList nodes contain ListItems; each ListItem
 * may contain its own nested BulletList/OrderedList. We compute the
 * nesting depth on each ListItem by walking up via `node.parent` and
 * counting list ancestors. The depth feeds `cm-md-listitem-depth-N`
 * (N = 0..5+, clamped at 5 in CSS) which the stylesheet maps to a
 * `padding-left` proportional to depth.
 */

import {
  EditorView,
  Decoration,
  WidgetType,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Transaction,
} from '@codemirror/state';
import {
  syntaxTree,
  syntaxHighlighting,
  HighlightStyle,
  forceParsing,
  type Language,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { markdown } from '@codemirror/lang-markdown';
import {
  Autolink,
  parser as commonmarkParser,
  Strikethrough,
  Table,
  TaskList,
  type BlockContext,
  type Element as MarkdownElement,
  type InlineContext,
  type Line,
  type MarkdownConfig,
  type MarkdownParser,
} from '@lezer/markdown';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNodeRef, SyntaxNode } from '@lezer/common';
import {
  parseMentionUrl,
  parseWikilinkInner,
  resolveLinkTarget,
  resolvePerson,
  type LivePath,
  type OrgPerson,
} from './markdown-core';
import { accentForId } from '@kb-1/ui';
import { MentionChipWidget, type MentionChipProps } from './plaintext-mention-widget';

/* ---------------------------------------------------------------- *
 * Decoration tokens — kept module-private and reused per build so   *
 * RangeSet de-dup picks them up instead of allocating fresh marks.  *
 * Decoration.line decos are keyed by class — repeated `.add()` of   *
 * the same Decoration at the same line offset is a no-op, which is  *
 * what we want when a line has both (e.g.) a ListItem deco and a    *
 * nested code-block deco; we only add the most-specific one.        *
 * ---------------------------------------------------------------- */

const headingDeco = {
  1: Decoration.line({ class: 'cm-md-h1' }),
  2: Decoration.line({ class: 'cm-md-h2' }),
  3: Decoration.line({ class: 'cm-md-h3' }),
  4: Decoration.line({ class: 'cm-md-h4' }),
  5: Decoration.line({ class: 'cm-md-h5' }),
  6: Decoration.line({ class: 'cm-md-h6' }),
} as const;

// ListItem line decos by depth (0 = top-level, 1 = one nesting level, …).
// Clamp depth at 5 in the builder; the CSS handles 0..5.
const listItemDeco: readonly Decoration[] = [
  Decoration.line({ class: 'cm-md-listitem cm-md-listitem-depth-0' }),
  Decoration.line({ class: 'cm-md-listitem cm-md-listitem-depth-1' }),
  Decoration.line({ class: 'cm-md-listitem cm-md-listitem-depth-2' }),
  Decoration.line({ class: 'cm-md-listitem cm-md-listitem-depth-3' }),
  Decoration.line({ class: 'cm-md-listitem cm-md-listitem-depth-4' }),
  Decoration.line({ class: 'cm-md-listitem cm-md-listitem-depth-5' }),
];

// Task-list "checked" decorations (Slice L). Two decos work together:
//   - line deco dims the whole row (checkbox + text together).
//   - body mark applies the strikethrough to JUST the body text range
//     (after the TaskMarker), NOT the leading hidden syntax chars.
// We can't put line-through on the line itself: parent text-decoration
// in CSS draws across every in-flow descendant regardless of the
// child's own `text-decoration: none`, so the line-through would bleed
// across the zero-width hidden `-` / `[x]` chars and read as a short
// leading dash before the checkbox widget.
// Task-line marker (checked OR unchecked). Sibling of -task-checked,
// emitted on every task-bearing list item so CSS can gate task-line-
// specific styling (e.g. the on-cursor alignment column in
// PlaintextEditor.svelte excludes task lines via this class to keep
// the checkbox flush — task lines have their own visual column).
const listItemTaskDeco = Decoration.line({
  class: 'cm-md-listitem-task',
});
const listItemTaskCheckedDeco = Decoration.line({
  class: 'cm-md-listitem-task-checked',
});
const taskCheckedBodyMark = Decoration.mark({
  class: 'cm-md-listitem-task-checked-body',
});

const blockquoteLineDeco = Decoration.line({ class: 'cm-md-blockquote' });
// Fence-frame line decos (Slice T polish, decomposed in Slice T-polish-2).
//
// Two-layer decomposition so the monospace font-family survives the
// cursor-enter "reveal" transition:
//   - `cm-md-code-block-text`  → font-family + font-size + line-height.
//     ALWAYS applied to content lines, regardless of cursor position. The
//     "this is code, not prose" typography signal that must NOT toggle as
//     the user clicks in / out of the fence — otherwise the body reflows
//     into the editor's serif body face and the visual jump is jarring.
//   - `cm-md-code-block-card`  → background-tint + side padding. ONLY
//     applied off-fence. Paired with positional classes
//     (`-fence-top` / `-middle` / `-bottom` / `-only`) that add the
//     border + radius so the run reads as a single rounded slab.
// `code-fence-delim` still carries the collapse trigger for delimiter
// lines off-fence; on-fence the delimiter lines get NO decoration at all
// so the raw ` ```ts ` / ` ``` ` reveals as plain prose for editing.
const codeFenceDelimDeco = Decoration.line({
  class: 'cm-md-code-block-text cm-md-code-block-card cm-md-code-fence-delim',
});
const codeFenceTopDeco = Decoration.line({
  class: 'cm-md-code-block-text cm-md-code-block-card cm-md-code-fence-top',
});
const codeFenceBottomDeco = Decoration.line({
  class: 'cm-md-code-block-text cm-md-code-block-card cm-md-code-fence-bottom',
});
const codeFenceMiddleDeco = Decoration.line({
  class: 'cm-md-code-block-text cm-md-code-block-card cm-md-code-fence-middle',
});
const codeFenceOnlyDeco = Decoration.line({
  class: 'cm-md-code-block-text cm-md-code-block-card cm-md-code-fence-only',
});
// On-fence content-line deco — text-layer ONLY (monospace persists; no
// card chrome, no positional class, no language label).
const codeFenceTextOnlyDeco = Decoration.line({
  class: 'cm-md-code-block-text',
});
const horizontalRuleLineDeco = Decoration.line({ class: 'cm-md-hr' });

const boldMark = Decoration.mark({ class: 'cm-md-bold' });
const italicMark = Decoration.mark({ class: 'cm-md-italic' });
const strikeMark = Decoration.mark({ class: 'cm-md-strike' });
const codeMark = Decoration.mark({ class: 'cm-md-code' });
const linkLabelMark = Decoration.mark({ class: 'cm-md-link-label' });
const wikilinkLabelMark = Decoration.mark({ class: 'cm-md-wikilink-label' });

/**
 * Build the snapshot prop bag the `MentionChipWidget` mounts with. All
 * resolution happens here — the widget itself is a dumb prop sink so
 * the Svelte component never has to read query contexts (see the long
 * comment in `plaintext-mention-widget.ts` for the Path-α-vs-β rationale).
 *
 * Resolution falls through the same three layers UserAvatar uses:
 *   1. directory hit + `name`   → display name, letter from first char.
 *   2. directory hit + email    → email handle, letter from handle.
 *   3. directory miss (stale)   → email handle, letter from email,
 *                                  accent = slate, stale = true.
 *
 * The accent is hashed off the resolved person's `id` (their userId) —
 * the same input `<UserAvatar userId={...}>` consumes — so the editor
 * chip and the user's avatar everywhere else in the app paint in the
 * SAME accent. Stale chips fall back to neutral slate because there's
 * no person to attribute a color to.
 */
function buildMentionWidgetProps(email: string, resolved: OrgPerson | null): MentionChipProps {
  if (resolved === null) {
    const handle = email.split('@')[0] ?? email;
    const letter = (handle.length > 0 ? handle.charAt(0) : '?').toUpperCase();
    return {
      email,
      displayName: handle.length > 0 ? handle : email,
      letter,
      image: null,
      accent: 'slate',
      // Hover affordance: surface the full email even when the local-part
      // is what's shown as the label. Matches the old CSS chip's
      // `data-mention-email` attribute behavior.
      title: email,
      stale: true,
    };
  }
  const hasName = resolved.name.length > 0;
  const displayName = hasName ? resolved.name : (resolved.email.split('@')[0] ?? resolved.email);
  const letter = displayName.charAt(0).toUpperCase();
  return {
    email,
    displayName,
    letter,
    image: resolved.image ?? null,
    accent: accentForId(resolved.id),
    // Hover affordance — full email exposed even when the chip's label is
    // the resolved display name. Mirrors the old CSS chip's
    // `data-mention-email` attribute behavior.
    title: email,
    stale: false,
  };
}

/**
 * Walk a Link node's children to extract the mention email when the URL
 * uses the `mention:<email>` scheme. Returns `null` when the Link has no
 * URL child or the URL doesn't parse as a mention. Mirrors the inline
 * walk in the Link-branch of the decoration pass below — extracted so
 * the chip-paint gate AND the syntax-mark hide gate can both classify
 * a Link as "mention vs URL link" without duplicating the walk.
 */
function extractMentionEmailFromLink(link: SyntaxNode, state: EditorState): string | null {
  let child: SyntaxNode | null = link.firstChild;
  while (child !== null) {
    if (child.type.name === 'URL') {
      let raw = state.sliceDoc(child.from, child.to).trim();
      if (raw.startsWith('<') && raw.endsWith('>')) {
        raw = raw.slice(1, -1);
      }
      const parts = parseMentionUrl(raw);
      return parts !== null ? parts.email : null;
    }
    child = child.nextSibling;
  }
  return null;
}
const wikilinkBrokenMark = Decoration.mark({
  class: 'cm-md-wikilink-label cm-md-wikilink-broken',
});
const footnoteRefMark = Decoration.mark({ class: 'cm-md-footnote-ref' });
const footnoteRefBrokenMark = Decoration.mark({
  class: 'cm-md-footnote-ref cm-md-footnote-ref-broken',
});
// Inline label paint for FootnoteDef — the `name` between `[^` and `]:` gets
// link-color styling so the def line reads as "name: body" flowing prose, in
// the Bear Notes style. No gutter chip, no card chrome — just colored prose.
const footnoteDefLabelMark = Decoration.mark({
  class: 'cm-md-footnote-label',
});
const hiddenSyntaxMark = Decoration.mark({ class: 'cm-md-syntax cm-hidden' });
const visibleSyntaxMark = Decoration.mark({ class: 'cm-md-syntax' });

/* ---------------------------------------------------------------- *
 * Inner-language registry for fenced code blocks.                   *
 *                                                                   *
 * `@codemirror/lang-markdown`'s `codeLanguages` option accepts a    *
 * `(info: string) => Language | LanguageDescription | null`. The    *
 * `info` string is the text after the opening fence (e.g. "ts",     *
 * "typescript", "js"). We normalize via lower-case + trim and look  *
 * up the matching LanguageSupport from the imported lang packs.     *
 *                                                                   *
 * Returning a `Language` (not `LanguageSupport`) is what the API    *
 * expects when we already have an instantiated support module;      *
 * `LanguageSupport.language` is the Language field. We construct    *
 * the support modules once at module scope to avoid re-parsing the  *
 * lezer grammar on every fence.                                     *
 * ---------------------------------------------------------------- */

const jsSupport = javascript();
const tsSupport = javascript({ typescript: true });
const tsxSupport = javascript({ typescript: true, jsx: true });
const jsxSupport = javascript({ jsx: true });
const pySupport = python();
const jsonSupport = json();
const htmlSupport = html();
const cssSupport = css();

function lookupFenceLanguage(info: string): Language | null {
  const tag = info.trim().toLowerCase().split(/\s+/)[0] ?? '';
  switch (tag) {
    case 'js':
    case 'javascript':
    case 'mjs':
    case 'cjs':
      return jsSupport.language;
    case 'jsx':
      return jsxSupport.language;
    case 'ts':
    case 'typescript':
      return tsSupport.language;
    case 'tsx':
      return tsxSupport.language;
    case 'py':
    case 'python':
      return pySupport.language;
    case 'json':
    case 'jsonc':
      return jsonSupport.language;
    case 'html':
    case 'htm':
    case 'xhtml':
      return htmlSupport.language;
    case 'css':
      return cssSupport.language;
    default:
      return null;
  }
}

/* ---------------------------------------------------------------- *
 * Widgets — tables + images (Slice 4)                                *
 *                                                                    *
 * The Live-Preview pattern for tables and images is "replace the     *
 * source range with a widget when the cursor is outside; show raw    *
 * source when the cursor enters". `Decoration.replace({ widget })`   *
 * is the canonical CM6 mechanism for that swap.                      *
 *                                                                    *
 * Block widget = whole-line(s) replacement, used for Tables.         *
 * Inline widget = mid-line replacement, used for Images.             *
 * ---------------------------------------------------------------- */

/**
 * Block widget rendering a parsed markdown table as an HTML `<table>`.
 *
 * `rows[0]` is the header row; `rows[1..]` are body rows. Preview-mode
 * cell content runs through the same inline markdown grammar as prose,
 * so bold, links, wikilinks, and mention chips don't flatten to raw
 * source inside cells. Misaligned column counts are normalized to the
 * header's length (pad with empty cells, truncate extras) per GFM
 * convention.
 *
 * Equality: two TableWidget instances are equal when their normalized
 * cell grids match, which lets CM6's RangeSet skip DOM updates when the
 * underlying source didn't change in a way that affects the rendered
 * output (e.g. a cursor move past the table doesn't rebuild the DOM).
 */
type ColumnAlignment = 'left' | 'center' | 'right';

class TableWidget extends WidgetType {
  constructor(
    readonly header: readonly string[],
    readonly body: readonly (readonly string[])[],
    readonly alignments: readonly ColumnAlignment[],
    readonly inlineContext: TableInlineRenderContext,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof TableWidget)) return false;
    if (this.header.length !== other.header.length) return false;
    for (let i = 0; i < this.header.length; i++) {
      if (this.header[i] !== other.header[i]) return false;
    }
    if (this.alignments.length !== other.alignments.length) return false;
    for (let i = 0; i < this.alignments.length; i++) {
      if (this.alignments[i] !== other.alignments[i]) return false;
    }
    if (this.inlineContext.key !== other.inlineContext.key) return false;
    if (this.body.length !== other.body.length) return false;
    for (let r = 0; r < this.body.length; r++) {
      const a = this.body[r];
      const b = other.body[r];
      if (a.length !== b.length) return false;
      for (let c = 0; c < a.length; c++) {
        if (a[c] !== b[c]) return false;
      }
    }
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    // Wrap the table in a div so vertical spacing lives inside the
    // widget's outer border-box. Same shape as the heading
    // margin→padding fix (commit e8875767): CM6's heightmap measures
    // line/widget height via `getBoundingClientRect().height`, which
    // is the border-box and excludes margin. A bare `<table>` with
    // `margin: 1em 0` would under-count by ~32px and clicks below the
    // table would drift below the visual target. The wrap owns the
    // vertical padding so CM6 sees the full visual height.
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-wrap';
    const table = document.createElement('table');
    table.className = 'cm-md-table';
    const thead = document.createElement('thead');
    const headerTr = document.createElement('tr');
    const cols = this.header.length;
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th');
      appendTableInlineMarkdown(th, this.header[c] ?? '', view, this.inlineContext);
      const align = this.alignments[c] ?? 'left';
      th.style.textAlign = align;
      headerTr.appendChild(th);
    }
    thead.appendChild(headerTr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const row of this.body) {
      const tr = document.createElement('tr');
      // Pad / truncate to header column count (GFM convention). Empty
      // cells render as empty `<td>` — no widget collapse.
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        appendTableInlineMarkdown(td, row[c] ?? '', view, this.inlineContext);
        const align = this.alignments[c] ?? 'left';
        td.style.textAlign = align;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // Tables are an editing affordance — letting the user click inside
  // the widget to position the cursor is desirable so they can click a
  // cell to start editing. CM6 default for block widgets is non-atomic
  // (clicks pass through to position the cursor at the widget's seam),
  // which is what we want: clicking the table moves the caret into the
  // source range, which trips cursor-reveal and shows the raw markdown.
  ignoreEvent(): boolean {
    return false;
  }
}

interface TableInlineRenderContext {
  key: string;
  livePaths: readonly LivePath[];
  orgPeople: readonly OrgPerson[];
  onWikilinkClick?: (encodedTarget: string, event: MouseEvent) => void;
}

type InlineElement = MarkdownElement & {
  readonly children?: readonly InlineElement[];
};

type TableInlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'strong' | 'emphasis' | 'strike'; children: readonly TableInlinePart[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: readonly TableInlinePart[] }
  | { kind: 'mention'; props: MentionChipProps }
  | { kind: 'wikilink'; target: string; label: string; resolved: boolean };

let tableInlineParser: MarkdownParser | null = null;

function getTableInlineParser(): MarkdownParser {
  tableInlineParser ??= commonmarkParser.configure([Strikethrough, Autolink, wikilinkExtension]);
  return tableInlineParser;
}

function tableInlineContextKey(
  livePaths: readonly LivePath[],
  orgPeople: readonly OrgPerson[],
): string {
  return JSON.stringify({
    livePaths: livePaths.map((p) => [p.path, p.noteId]),
    orgPeople: orgPeople.map((p) => [p.id, p.email, p.name, p.image ?? null]),
  });
}

function inlineElementName(parser: MarkdownParser, element: InlineElement): string {
  return parser.nodeSet.types[element.type]?.name ?? '';
}

function childElements(element: InlineElement): readonly InlineElement[] {
  return element.children ?? [];
}

function stripAngleUrl(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
}

function normalizeInlineHref(raw: string): string {
  const trimmed = stripAngleUrl(raw);
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('xmpp:')
  ) {
    return trimmed;
  }
  if (trimmed.startsWith('www.')) return `https://${trimmed}`;
  if (trimmed.includes('@') && !trimmed.includes('/')) return `mailto:${trimmed}`;
  return trimmed;
}

function pushTextPart(parts: TableInlinePart[], text: string): void {
  if (text.length === 0) return;
  const last = parts[parts.length - 1];
  if (last?.kind === 'text') {
    parts[parts.length - 1] = { kind: 'text', text: last.text + text };
  } else {
    parts.push({ kind: 'text', text });
  }
}

function linkUrlFromElement(
  parser: MarkdownParser,
  link: InlineElement,
  source: string,
): string | null {
  for (const child of childElements(link)) {
    if (inlineElementName(parser, child) === 'URL') {
      return stripAngleUrl(source.slice(child.from, child.to));
    }
  }
  return null;
}

function linkLabelEnd(parser: MarkdownParser, link: InlineElement, source: string): number | null {
  for (const child of childElements(link)) {
    if (inlineElementName(parser, child) !== 'LinkMark') continue;
    if (child.to - child.from === 1 && source.slice(child.from, child.to) === ']') {
      return child.from;
    }
  }
  return null;
}

function wikilinkPartsFromElement(
  parser: MarkdownParser,
  wikilink: InlineElement,
  source: string,
): { target: string; label: string } | null {
  let targetText = '';
  let aliasText: string | null = null;
  for (const child of childElements(wikilink)) {
    const name = inlineElementName(parser, child);
    if (name === 'WikilinkTarget') targetText = source.slice(child.from, child.to);
    else if (name === 'WikilinkAlias') aliasText = source.slice(child.from, child.to);
  }
  const parts = parseWikilinkInner(targetText + (aliasText !== null ? '|' : ''));
  if (parts === null) return null;
  const target = parts.target.trim();
  if (target.length === 0) return null;
  return { target, label: aliasText ?? targetText };
}

function tableInlinePartsFromRange(
  parser: MarkdownParser,
  source: string,
  from: number,
  to: number,
  elements: readonly InlineElement[],
  context: Pick<TableInlineRenderContext, 'livePaths' | 'orgPeople'>,
): TableInlinePart[] {
  const parts: TableInlinePart[] = [];
  let pos = from;
  for (const element of elements) {
    if (element.to <= from || element.from >= to) continue;
    if (element.from > pos) pushTextPart(parts, source.slice(pos, element.from));
    parts.push(...tableInlinePartsFromElement(parser, source, element, context));
    pos = Math.max(pos, element.to);
  }
  if (pos < to) pushTextPart(parts, source.slice(pos, to));
  return parts;
}

function tableInlinePartsFromElement(
  parser: MarkdownParser,
  source: string,
  element: InlineElement,
  context: Pick<TableInlineRenderContext, 'livePaths' | 'orgPeople'>,
): TableInlinePart[] {
  const name = inlineElementName(parser, element);
  const children = childElements(element);
  if (
    name === 'EmphasisMark' ||
    name === 'StrikethroughMark' ||
    name === 'CodeMark' ||
    name === 'LinkMark' ||
    name === 'WikilinkMark' ||
    name === 'WikilinkAliasMark'
  ) {
    return [];
  }
  if (name === 'Escape') {
    return [{ kind: 'text', text: source.slice(element.from + 1, element.to) }];
  }
  if (name === 'StrongEmphasis') {
    return [
      {
        kind: 'strong',
        children: tableInlinePartsFromRange(
          parser,
          source,
          element.from,
          element.to,
          children,
          context,
        ),
      },
    ];
  }
  if (name === 'Emphasis') {
    return [
      {
        kind: 'emphasis',
        children: tableInlinePartsFromRange(
          parser,
          source,
          element.from,
          element.to,
          children,
          context,
        ),
      },
    ];
  }
  if (name === 'Strikethrough') {
    return [
      {
        kind: 'strike',
        children: tableInlinePartsFromRange(
          parser,
          source,
          element.from,
          element.to,
          children,
          context,
        ),
      },
    ];
  }
  if (name === 'InlineCode') {
    const childParts = tableInlinePartsFromRange(
      parser,
      source,
      element.from,
      element.to,
      children,
      context,
    );
    return [
      {
        kind: 'code',
        text: childParts.map((part) => (part.kind === 'text' ? part.text : '')).join(''),
      },
    ];
  }
  if (name === 'Link') {
    const href = linkUrlFromElement(parser, element, source);
    const labelEnd = linkLabelEnd(parser, element, source);
    if (href === null || labelEnd === null)
      return [{ kind: 'text', text: source.slice(element.from, element.to) }];
    const mention = parseMentionUrl(href);
    if (mention !== null) {
      const resolved = resolvePerson(mention.email, context.orgPeople);
      return [{ kind: 'mention', props: buildMentionWidgetProps(mention.email, resolved) }];
    }
    return [
      {
        kind: 'link',
        href: normalizeInlineHref(href),
        children: tableInlinePartsFromRange(
          parser,
          source,
          element.from + 1,
          labelEnd,
          children,
          context,
        ),
      },
    ];
  }
  if (name === 'URL') {
    const raw = source.slice(element.from, element.to);
    return [
      { kind: 'link', href: normalizeInlineHref(raw), children: [{ kind: 'text', text: raw }] },
    ];
  }
  if (name === 'Wikilink') {
    const parsed = wikilinkPartsFromElement(parser, element, source);
    if (parsed === null) return [{ kind: 'text', text: source.slice(element.from, element.to) }];
    const resolved = resolveLinkTarget({ raw: parsed.target, livePaths: context.livePaths });
    return [
      {
        kind: 'wikilink',
        target: parsed.target,
        label: parsed.label,
        resolved: resolved !== null,
      },
    ];
  }
  if (children.length > 0) {
    return tableInlinePartsFromRange(parser, source, element.from, element.to, children, context);
  }
  return [{ kind: 'text', text: source.slice(element.from, element.to) }];
}

export function parseTableCellInlineMarkdown(
  source: string,
  context: Pick<TableInlineRenderContext, 'livePaths' | 'orgPeople'> = {
    livePaths: [],
    orgPeople: [],
  },
): TableInlinePart[] {
  const parser = getTableInlineParser();
  const elements = parser.parseInline(source, 0) as readonly InlineElement[];
  return tableInlinePartsFromRange(parser, source, 0, source.length, elements, context);
}

function appendTableInlineParts(
  parent: HTMLElement,
  parts: readonly TableInlinePart[],
  view: EditorView,
  context: TableInlineRenderContext,
): void {
  for (const part of parts) {
    if (part.kind === 'text') {
      parent.appendChild(document.createTextNode(part.text));
    } else if (part.kind === 'strong') {
      const strong = document.createElement('strong');
      strong.className = 'cm-md-bold';
      appendTableInlineParts(strong, part.children, view, context);
      parent.appendChild(strong);
    } else if (part.kind === 'emphasis') {
      const em = document.createElement('em');
      em.className = 'cm-md-italic';
      appendTableInlineParts(em, part.children, view, context);
      parent.appendChild(em);
    } else if (part.kind === 'strike') {
      const strike = document.createElement('s');
      strike.className = 'cm-md-strike';
      appendTableInlineParts(strike, part.children, view, context);
      parent.appendChild(strike);
    } else if (part.kind === 'code') {
      const code = document.createElement('code');
      code.className = 'cm-md-code';
      code.textContent = part.text;
      parent.appendChild(code);
    } else if (part.kind === 'mention') {
      parent.appendChild(new MentionChipWidget(part.props).toDOM(view));
    } else if (part.kind === 'link') {
      const link = document.createElement('a');
      link.className = 'cm-md-link-label';
      link.href = part.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.addEventListener('mousedown', (event) => {
        event.stopPropagation();
      });
      appendTableInlineParts(link, part.children, view, context);
      parent.appendChild(link);
    } else if (part.kind === 'wikilink') {
      const link = document.createElement('a');
      link.href = '#';
      link.className = part.resolved
        ? 'cm-md-wikilink-label'
        : 'cm-md-wikilink-label cm-md-wikilink-broken';
      link.textContent = part.label;
      link.addEventListener('mousedown', (event) => {
        event.stopPropagation();
      });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        context.onWikilinkClick?.(encodeURIComponent(part.target), event);
      });
      parent.appendChild(link);
    }
  }
}

function appendTableInlineMarkdown(
  parent: HTMLElement,
  source: string,
  view: EditorView,
  context: TableInlineRenderContext,
): void {
  appendTableInlineParts(parent, parseTableCellInlineMarkdown(source, context), view, context);
}

/**
 * Image-widget render mode. Three branches the source URL can take:
 *
 *   - `normal`  — render `<img>` against `resolvedSrc`; the existing
 *                 `onerror` fallback paints the broken-image glyph if
 *                 the load fails.
 *   - `pending` — paste/drop optimistic placeholder from documents that
 *                 already contain a pending upload sentinel. Render a
 *                 small spinner overlay instead of `<img>`.
 *   - `failed`  — upload failed sentinel. Render the same broken-image
 *                 glyph the `onerror` path uses, so the user gets a
 *                 consistent "didn't load" signal.
 */
type ImageWidgetMode = 'normal' | 'pending' | 'failed';

const PENDING_UPLOAD_PREFIX = 'pending-upload://';
const UPLOAD_FAILED_PREFIX = 'upload-failed://';

function classifyImageUrl(rawUrl: string): ImageWidgetMode {
  if (rawUrl.startsWith(PENDING_UPLOAD_PREFIX)) return 'pending';
  if (rawUrl.startsWith(UPLOAD_FAILED_PREFIX)) return 'failed';
  return 'normal';
}

const BROKEN_IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true" width="28" height="28" fill="currentColor" viewBox="0 0 256 256"><path d="M216,42H40A14,14,0,0,0,26,56V200a14,14,0,0,0,14,14h64a6,6,0,0,0,5.69-4.1l15.12-45.36,37.42-15a6,6,0,0,0,3.34-3.34l15-37.42L225.9,93.69A6,6,0,0,0,230,88V56A14,14,0,0,0,216,42ZM117.77,154.43a6,6,0,0,0-3.46,3.67L99.68,202H40a2,2,0,0,1-2-2V171.17l52.58-52.58a2,2,0,0,1,2.83,0L126,151.15ZM218,83.68,174.1,98.31a6,6,0,0,0-3.67,3.46l-15.05,37.61L138.1,146.3l-36.2-36.2a14,14,0,0,0-19.8,0L38,154.2V56a2,2,0,0,1,2-2H216a2,2,0,0,1,2,2Zm9.51,33.18a6,6,0,0,0-5.41-.82L198.3,124a6,6,0,0,0-3.67,3.47L180,164l-36.56,14.63A6,6,0,0,0,140,182.3L132,206.1a6,6,0,0,0,5.69,7.9H216a14,14,0,0,0,14-14V121.73A6,6,0,0,0,227.51,116.86ZM218,200a2,2,0,0,1-2,2H146.06l4.42-13.26,36.37-14.55a6,6,0,0,0,3.34-3.34l14.55-36.37L218,130.06Z"/></svg>';

function renderBrokenFallback(alt: string): HTMLSpanElement {
  const fallback = document.createElement('span');
  fallback.className = 'cm-md-image-broken';
  // Keep `alt` on the aria-label so screen readers can still identify
  // a failed-image as "broken image: <alt>"; visually we render only
  // the muted Phosphor ImageBroken glyph (no trailing alt-text span).
  fallback.setAttribute('aria-label', alt || 'broken image');
  fallback.innerHTML = BROKEN_IMAGE_SVG;
  return fallback;
}

/**
 * Inline widget rendering a markdown image as an `<img>`. Source range
 * is `![alt](url)`; widget replaces the whole range when cursor is
 * outside.
 *
 * `resolvedSrc` is the final URL after attachment-path remapping; `alt`
 * is the raw alt text (may be empty — valid markdown). Sizing is
 * `max-width: 100%; height: auto` via CSS; v1 has no captions, no
 * custom sizing syntax, no figure wrapping.
 *
 * `mode` carries the optimistic-sentinel state (pending upload /
 * upload failed / normal) so a paste-in-progress renders a spinner
 * and a failed paste renders the broken-image glyph. See
 * `plaintext-image-upload.ts` for the upload pipeline that mints the
 * sentinel URLs.
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly resolvedSrc: string,
    readonly alt: string,
    readonly mode: ImageWidgetMode = 'normal',
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ImageWidget &&
      other.resolvedSrc === this.resolvedSrc &&
      other.alt === this.alt &&
      other.mode === this.mode
    );
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'cm-md-image-widget';

    // Pending upload — small inline spinner. We render an inline
    // <span> with a CSS-animated rotation; the CSS keyframes live in
    // PlaintextEditor.svelte alongside the rest of the editor styles.
    if (this.mode === 'pending') {
      wrapper.dataset.state = 'pending';
      const spinner = document.createElement('span');
      spinner.className = 'cm-md-image-spinner';
      spinner.setAttribute('role', 'img');
      spinner.setAttribute('aria-label', this.alt ? `Uploading ${this.alt}…` : 'Uploading image…');
      // Phosphor CircleNotch — looks like a spinner once we rotate it
      // via CSS. Single arc + transparent fill so the spin is visually
      // clean. Same icon weight as the broken-image glyph.
      spinner.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="20" height="20" fill="currentColor" viewBox="0 0 256 256"><path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93,40,128a88,88,0,0,0,176,0c0-35-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z"/></svg>';
      wrapper.appendChild(spinner);
      return wrapper;
    }

    // Upload failed (sentinel persisted across an error) — same
    // broken-image glyph the runtime `<img>.onerror` falls back to,
    // so the user gets a consistent "didn't load" signal.
    if (this.mode === 'failed') {
      wrapper.dataset.state = 'broken';
      wrapper.appendChild(renderBrokenFallback(this.alt));
      return wrapper;
    }

    // Normal path.
    const img = document.createElement('img');
    img.className = 'cm-md-image';
    img.src = this.resolvedSrc;
    img.alt = this.alt;
    img.loading = 'lazy';
    const alt = this.alt;
    // On load failure swap the <img> for a muted Phosphor ImageBroken
    // glyph (light-weight, viewBox 0 0 256 256). The browser's default
    // broken-image icon is OS-specific and doesn't match kb-1's visual
    // language — see PlaintextEditor.svelte `.cm-md-image-widget` rules.
    img.onerror = () => {
      wrapper.dataset.state = 'broken';
      wrapper.textContent = '';
      wrapper.appendChild(renderBrokenFallback(alt));
    };
    wrapper.appendChild(img);
    return wrapper;
  }

  // Allow clicks to pass through so the caret can land inside the
  // source range — same affordance as TableWidget. The user clicking
  // an image to edit its markdown is the expected gesture.
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Inline widget rendering a GFM task-list checkbox (`- [ ]` / `- [x]`).
 *
 * Source-range contract: the widget REPLACES the 3-char `TaskMarker`
 * range (`[ ]` / `[x]` / `[X]`) only — the leading list bullet (`- `)
 * is suppressed via the `ListMark`-branch (task-bearing items emit no
 * bullet glyph; the checkbox IS the leading affordance). The trailing
 * item text renders normally.
 *
 * Visual register (Slice L redesign): the widget renders custom glyphs
 * in `currentColor`, not the browser-native `<input type="checkbox">`.
 *   - Unchecked: a small rounded-corner outline square at ~0.45 opacity.
 *   - Checked:   the Phosphor `Check` SVG path in currentColor, no tint.
 * Both glyphs sit on the text baseline and read as typographic
 * punctuation, not a UI control. Bear-clean — the original native
 * checkbox's blue accent fought the editor's quiet palette.
 *
 * Toggle: a `mousedown` listener inside `toDOM` reads the current marker
 * text from the doc (via the `view` param passed to `toDOM`), flips the
 * source, and dispatches a single `view.dispatch({ changes })`. The
 * sync plugin (PlaintextSyncPlugin in PlaintextEditor.svelte) writes
 * the change back to Y.Text with `PLAINTEXT_USER_ORIGIN`, which is
 * tracked by the UndoManager — so Ctrl-Z reverses the toggle exactly
 * like undoing a typed character.
 *
 * Why mousedown, not click: when the redecoration after the dispatch
 * destroys this widget's DOM between mousedown and mouseup, the
 * browser silently drops the `click` event. mousedown fires before any
 * DOM mutation so the handler runs reliably. Same class of bug as
 * `feedback_click_event_cancellation_on_dom_mutation.md`.
 *
 * `ignoreEvent` returns `true` so CM6 doesn't repurpose the click to
 * position the caret at the widget's seam. The widget owns its events.
 *
 * Equality: two TaskCheckboxWidgets are equal when their checked state
 * AND source-range position match. Source position matters because
 * after edits above the line the same `checked` state at a different
 * offset is still a logically different widget (different toggle target).
 */
// Phosphor `Check` SVG path data (viewBox 0 0 256 256, weight: regular).
// Hardcoded here so the widget can render inline without mounting a
// Svelte component inside a CM6 DOM widget. Same inline-SVG pattern as
// `BROKEN_IMAGE_SVG` above.
const CHECK_SVG_PATH =
  'M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z';

class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly markerFrom: number,
    readonly markerTo: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof TaskCheckboxWidget &&
      other.checked === this.checked &&
      other.markerFrom === this.markerFrom &&
      other.markerTo === this.markerTo
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = this.checked
      ? 'cm-md-task-checkbox cm-md-task-checkbox-checked'
      : 'cm-md-task-checkbox cm-md-task-checkbox-unchecked';
    // Custom inline-SVG glyph in `currentColor`:
    //   - Checked   → Phosphor `Check` icon path on a transparent box.
    //   - Unchecked → an empty rounded-corner square (the box itself).
    // CSS in PlaintextEditor.svelte sizes the box, sets the opacity,
    // and paints the border for the unchecked state. The widget DOM
    // is identical-shape across both states (one <span> wrapper, one
    // <svg> inner) so CSS class-toggling is the only branch the
    // browser sees on toggle.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 256 256');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.classList.add('cm-md-task-checkbox-glyph');
    if (this.checked) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', CHECK_SVG_PATH);
      path.setAttribute('fill', 'currentColor');
      svg.appendChild(path);
    }
    // A11y: expose role/state for screen readers; the widget is
    // visually a checkbox even though it's not an <input>.
    wrap.setAttribute('role', 'checkbox');
    wrap.setAttribute('aria-checked', this.checked ? 'true' : 'false');
    wrap.appendChild(svg);

    const onMouseDown = (event: MouseEvent): void => {
      // Left-click only — right-click and middle-click stay out of the
      // toggle path so the browser's context menu / paste-with-middle-
      // click defaults aren't repurposed.
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      // Re-read the marker from the live doc — the constructor-captured
      // positions can stale across edits above the line, but in the
      // common case (toggling the same widget instance) they're current.
      // If the slice doesn't look like a TaskMarker any more, bail —
      // the next decoration rebuild will replace this widget with a
      // fresh one matching the current parse.
      const { from, to } = this.currentRange(view);
      if (from === null || to === null) return;
      const current = view.state.sliceDoc(from, to);
      if (!/^\[[ xX]\]$/.test(current)) return;
      const next = current === '[ ]' ? '[x]' : '[ ]';
      view.dispatch({
        changes: { from, to, insert: next },
      });
    };
    wrap.addEventListener('mousedown', onMouseDown);
    return wrap;
  }

  /**
   * Recompute the marker range against the current doc. The widget is
   * constructed with absolute positions; if edits land BEFORE the marker
   * the positions drift, but CM6 rebuilds the decoration set on every
   * doc change so a stale widget rarely survives a click. We still
   * read fresh from `view.state` here as a belt-and-suspenders: the
   * constructor positions are the target on the post-rebuild doc, but
   * inside an in-flight transaction (rare) they might not match.
   *
   * Returns `{from, to}` of the marker if the slice still looks like a
   * task marker; `{null, null}` otherwise.
   */
  private currentRange(view: EditorView): {
    from: number | null;
    to: number | null;
  } {
    const docLen = view.state.doc.length;
    if (this.markerTo > docLen) return { from: null, to: null };
    return { from: this.markerFrom, to: this.markerTo };
  }

  ignoreEvent(): boolean {
    // Atomic to CM6 — we handle mousedown ourselves; don't let CM6
    // hijack the event to position the caret at the widget seam.
    return true;
  }
}

/**
 * Inline widget rendering an unordered-list bullet glyph (Slice L).
 *
 * Source-range contract: replaces the `ListMark` range (the `-` / `*` /
 * `+` char) when the cursor is OFF the ListItem; cursor-inside reveals
 * the raw `-`. Same toggle pattern as `HorizontalRule`'s reveal.
 *
 * Glyph cycle by depth (Phosphor SVG paths, 256×256 viewBox):
 *   depth 0 → solid circle  (Phosphor Circle weight=fill)
 *   depth 1 → empty circle  (Phosphor Circle weight=regular)
 *   depth 2 → solid triangle (Phosphor Triangle weight=fill, points up)
 *   depth 3 → empty triangle (Phosphor Triangle weight=regular, points up)
 *   depth 4+ cycles through the set.
 *
 * Phosphor paths inlined (rather than mounting Svelte components inside
 * a CM6 widget) match the same pattern as TaskCheckboxWidget's CHECK_SVG_PATH.
 *
 * The widget is non-interactive (no toggle, no click handler).
 * `ignoreEvent()` returns `true` so CM6 doesn't try to position the
 * caret at the widget seam; clicks on the bullet pass through to the
 * surrounding `.cm-content` and CM6 handles cursor placement normally.
 *
 * Equality: by depth only — same depth at any source offset renders
 * identical DOM, so CM6's RangeSet de-dupes correctly across rebuilds.
 */
const CIRCLE_FILL_PATH = 'M232,128A104,104,0,1,1,128,24,104.13,104.13,0,0,1,232,128Z';
const CIRCLE_REGULAR_PATH =
  'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z';
// Diamond paths (Phosphor `Diamond` icon — fill + regular weights).
// Lifted verbatim from `phosphor-svelte/lib/Diamond.svelte`. Replaces
// the earlier triangle pair: deep-nesting bullets read as cleaner /
// more even alongside the top-level filled dot + level-2 hollow circle
// (a triangle leans visually heavier on one side; a diamond is radial
// like the circles).
const DIAMOND_FILL_PATH =
  'M240,128a15.85,15.85,0,0,1-4.67,11.28l-96.05,96.06a16,16,0,0,1-22.56,0h0l-96-96.06a16,16,0,0,1,0-22.56l96.05-96.06a16,16,0,0,1,22.56,0l96.05,96.06A15.85,15.85,0,0,1,240,128Z';
const DIAMOND_REGULAR_PATH =
  'M235.33,116.72,139.28,20.66a16,16,0,0,0-22.56,0l-96,96.06a16,16,0,0,0,0,22.56l96.05,96.06h0a16,16,0,0,0,22.56,0l96.05-96.06a16,16,0,0,0,0-22.56ZM128,224h0L32,128,128,32,224,128Z';

const BULLET_GLYPH_PATHS = [
  CIRCLE_FILL_PATH,
  CIRCLE_REGULAR_PATH,
  DIAMOND_FILL_PATH,
  DIAMOND_REGULAR_PATH,
] as const;

function bulletGlyphPathForDepth(depth: number): string {
  // Cycle by modulo so depth-4 wraps to depth-0's glyph, depth-5 to
  // depth-1's, etc. Negative depth shouldn't happen (listItemDepth
  // clamps at 0) but be defensive.
  const n = depth < 0 ? 0 : depth;
  const idx = n % BULLET_GLYPH_PATHS.length;
  return BULLET_GLYPH_PATHS[idx] ?? BULLET_GLYPH_PATHS[0];
}

class BulletGlyphWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof BulletGlyphWidget && other.depth === this.depth;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet-glyph';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML =
      '<svg viewBox="0 0 256 256" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
      `<path d="${bulletGlyphPathForDepth(this.depth)}"/>` +
      '</svg>';
    return span;
  }

  ignoreEvent(): boolean {
    // Not interactive — let CM6 handle clicks via the surrounding
    // .cm-content so caret placement works normally.
    return true;
  }
}

/**
 * Inline widget rendering an ordered-list number (Slice L).
 *
 * Source-range contract: replaces the `ListMark` range (e.g. `1.` / `5.`)
 * when the cursor is OFF the enclosing ListItem; cursor-inside reveals
 * the raw source number.
 *
 * Display value: CommonMark-style auto-numbering. The first item in an
 * `OrderedList` sets the start; subsequent items render `start + offset`
 * regardless of what was written in source. So:
 *
 *   1. foo  → 1.
 *   1. bar  → 2.
 *   1. baz  → 3.
 *
 * and:
 *
 *   5. foo  → 5.
 *   1. bar  → 6.
 *
 * The displayed glyph is `<n>.` (period delimiter) — even when the
 * source used `)`, we normalize to a period because that's the
 * canonical CommonMark display in most renderers and reads cleaner.
 *
 * Equality: by display value only.
 */
class OrderedNumberWidget extends WidgetType {
  constructor(readonly displayValue: number) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof OrderedNumberWidget && other.displayValue === this.displayValue;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-ordered-number';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.displayValue.toFixed(0) + '.';
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Line widget rendering the fence's info-string (e.g. "ts", "python") as a
 * small muted label pinned to the top-right corner of the rendered code
 * box. Emitted only when the cursor is OFF the fence — when the cursor
 * enters, the opening fence line reveals (raw ```ts) so a corner label
 * would duplicate information. The label sits inside the bordered region
 * via absolute positioning anchored to the line's relative-positioned
 * box (see `.cm-md-code-fence-top::after` rules in
 * `PlaintextEditor.svelte`).
 *
 * We use `Decoration.line({ attributes: { 'data-fence-lang': lang } })`
 * to attach the label text, then CSS `content: attr(...)` renders it.
 * That keeps the widget surface a plain HTML attribute — no extra DOM
 * node, no CM6 widget bookkeeping. The CSS handles font-size, position,
 * and color.
 */
const fenceLangAttrCache = new Map<string, Decoration>();
function fenceTopWithLang(lang: string): Decoration {
  // Cache the per-language Decoration.line so repeated builds on the same
  // doc reuse the same Decoration reference and CM6's RangeSet de-dupes
  // it identically to the static `codeFenceTopDeco` above.
  const existing = fenceLangAttrCache.get(lang);
  if (existing !== undefined) return existing;
  const deco = Decoration.line({
    class: 'cm-md-code-block-text cm-md-code-block-card cm-md-code-fence-top',
    attributes: { 'data-fence-lang': lang },
  });
  fenceLangAttrCache.set(lang, deco);
  return deco;
}
function fenceOnlyWithLang(lang: string): Decoration {
  const key = `__only__${lang}`;
  const existing = fenceLangAttrCache.get(key);
  if (existing !== undefined) return existing;
  const deco = Decoration.line({
    class: 'cm-md-code-block-text cm-md-code-block-card cm-md-code-fence-only',
    attributes: { 'data-fence-lang': lang },
  });
  fenceLangAttrCache.set(key, deco);
  return deco;
}

/* ---------------------------------------------------------------- *
 * URL resolution — attachment paths vs absolute URLs                *
 *                                                                    *
 * Markdown can store attachments as bare paths in `![](path)`. The   *
 * host may pass `attachmentSrc` to resolve those paths at render      *
 * time; omitted hooks leave the source URL untouched.                 *
 *                                                                    *
 * Heuristic: anything with a recognized URL scheme prefix             *
 * (`http(s)://`, `data:`, `blob:`, `mailto:`) OR starting with `/`   *
 * (root-relative) is treated as already-resolved. Anything else is   *
 * an attachment path → run through `attachmentSrc()`.                *
 *                                                                    *
 * `attachmentSrc` is optional — when missing (Storybook / no vault   *
 * context), bare paths pass through verbatim; the browser will       *
 * render a broken-image icon, which is the same fallback Milkdown    *
 * gets when its remap is omitted.                                    *
 * ---------------------------------------------------------------- */

const ABSOLUTE_URL_RE = /^(?:https?:|data:|blob:|mailto:|file:|\/\/|\/|#)/i;

function resolveImageUrl(
  rawUrl: string,
  attachmentSrc: ((path: string) => string) | undefined,
): string {
  const url = rawUrl.trim();
  if (url === '') return url;
  if (ABSOLUTE_URL_RE.test(url)) return url;
  if (attachmentSrc) return attachmentSrc(url);
  return url;
}

/* ---------------------------------------------------------------- *
 * Helpers                                                            *
 * ---------------------------------------------------------------- */

/**
 * List-item nesting depth — count BulletList/OrderedList ancestors
 * above this node (exclusive of the node itself; a top-level ListItem
 * sits directly under one BulletList/OrderedList → its depth is 0).
 *
 * Lezer-markdown trees nest as:
 *   BulletList
 *     ListItem
 *       BulletList         ← nested list lives inside the parent ListItem
 *         ListItem         ← depth = 1
 *           BulletList
 *             ListItem     ← depth = 2
 *
 * So depth = (# of BulletList/OrderedList ancestors) - 1.
 */
function listItemDepth(node: SyntaxNode): number {
  let depth = -1;
  let parent: SyntaxNode | null = node.parent;
  while (parent !== null) {
    const n = parent.type.name;
    if (n === 'BulletList' || n === 'OrderedList') depth++;
    parent = parent.parent;
  }
  if (depth < 0) depth = 0;
  if (depth > 5) depth = 5;
  return depth;
}

/**
 * Does this ListItem contain a GFM `Task` child (i.e. is it a task-list
 * item, `- [ ] …` / `- [x] …`)?
 *
 * Lezer-markdown's TaskList extension nests the `Task` block directly
 * under `ListItem`:
 *
 *   ListItem
 *     ListMark        ← `- `
 *     Task            ← block; spans `[ ]` + inline content
 *       TaskMarker    ← `[ ]` / `[x]` / `[X]`
 *
 * Walk the ListItem's direct children looking for a `Task` node. We
 * stop at the first match — a ListItem has at most one Task child by
 * GFM's grammar.
 */
function listItemHasTask(listItem: SyntaxNode): boolean {
  let child: SyntaxNode | null = listItem.firstChild;
  while (child !== null) {
    if (child.type.name === 'Task') return true;
    child = child.nextSibling;
  }
  return false;
}

/**
 * Is this ListItem nested inside an OrderedList (vs a BulletList)?
 * Looks at the immediate parent only — that's where lezer-markdown
 * attaches the ListItem under a list-block node.
 */
function listItemIsOrdered(listItem: SyntaxNode): boolean {
  const parent = listItem.parent;
  if (parent === null) return false;
  return parent.type.name === 'OrderedList';
}

/**
 * Parse the leading numeric run from a `ListMark` source string. Lezer-
 * markdown's ListMark for an OrderedList item is the literal source
 * (e.g. `1.`, `42)`, `5.`); we strip the trailing delimiter and parse
 * the digits. Returns `null` for non-numeric marks (bullet lists).
 */
function parseOrderedMark(markText: string): number | null {
  const m = /^(\d+)/.exec(markText);
  if (m === null) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Pre-pass: walk every `OrderedList` in the tree and assign a display
 * number to each of its direct `ListItem` children. The first item's
 * source-mark sets the start; subsequent items get `start + offset`
 * (offset = position among ListItem siblings, 0-indexed). Returns a
 * `Map<listItemFrom, displayNumber>` keyed by the absolute source
 * offset of each ListItem so the main walk can look up by position.
 *
 * Why a pre-pass: the main walk emits the `ListMark` widget when it
 * enters the `ListMark` node, which is a grandchild of the OrderedList.
 * At that point we'd need to walk back up to count siblings — easier
 * to do it once up-front and look up.
 *
 * Cheap — single tree walk; only descends into OrderedList nodes
 * shallowly to read each ListItem's first ListMark child.
 */
function computeOrderedListNumbers(
  tree: ReturnType<typeof syntaxTree>,
  state: EditorState,
): Map<number, number> {
  const numbers = new Map<number, number>();
  tree.iterate({
    enter: (n: SyntaxNodeRef) => {
      if (n.type.name !== 'OrderedList') return undefined;
      // Walk direct children — every ListItem under this OrderedList.
      // Read the first ListMark text inside the FIRST ListItem to set
      // the start; subsequent items get sequential numbers.
      let start: number | null = null;
      let offset = 0;
      let child: SyntaxNode | null = n.node.firstChild;
      while (child !== null) {
        if (child.type.name === 'ListItem') {
          if (start === null) {
            // Find this item's leading ListMark child.
            let mark: SyntaxNode | null = child.firstChild;
            while (mark !== null) {
              if (mark.type.name === 'ListMark') {
                const txt = state.sliceDoc(mark.from, mark.to);
                const parsed = parseOrderedMark(txt);
                if (parsed !== null) start = parsed;
                break;
              }
              mark = mark.nextSibling;
            }
            // Defensive: if no ListMark found or non-numeric, fall back
            // to 1. Shouldn't happen for an OrderedList per the grammar.
            if (start === null) start = 1;
          }
          numbers.set(child.from, start + offset);
          offset += 1;
        }
        child = child.nextSibling;
      }
      // Nested OrderedLists are still visited by the iterator on their
      // own enter event and get their own start/offset scope; this
      // direct-child loop does not fold their ListItems into the parent.
      return undefined;
    },
  });
  return numbers;
}

/**
 * Unescape the subset of inline markdown escapes that GFM permits inside
 * a regular text run. Per CommonMark §6.1 the escapable set is the ASCII
 * punctuation: `!"#$%&'()*+,-./:;<=>?@[\]^_\``{|}~`. Anything else after
 * a backslash stays verbatim (the backslash is preserved). GFM extends
 * the set with `|` already, which is already an ASCII punct so no
 * special case.
 *
 * Examples:
 *   `a\|b`     → `a|b`     (pipe inside table cell)
 *   `\\`       → `\`
 *   `\*x`      → `*x`      (escaped emphasis marker)
 *   `\z`       → `\z`      (unescapable — backslash kept)
 *
 * Cheap, allocation-free for strings without backslashes — checked first
 * via `indexOf` so a cell with no escapes pays nothing.
 */
export function unescapeMarkdownInline(text: string): string {
  if (!text.includes('\\')) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 92 /* '\' */ && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      // ASCII punctuation set per CommonMark §6.1.
      const isPunct =
        (next >= 33 && next <= 47) /* ! " # $ % & ' ( ) * + , - . / */ ||
        (next >= 58 && next <= 64) /* : ; < = > ? @ */ ||
        (next >= 91 && next <= 96) /* [ \ ] ^ _ ` */ ||
        (next >= 123 && next <= 126); /* { | } ~ */
      if (isPunct) {
        out += text[i + 1];
        i++;
        continue;
      }
    }
    out += text[i];
  }
  return out;
}

/**
 * Parse a GFM delimiter row's cell content into an alignment per column.
 *
 * Per GFM §4.10:
 *   `:---`   → left
 *   `:---:`  → center
 *   `---:`   → right
 *   `---`    → default (left)
 *
 * The cell text we receive has been trimmed and stripped of surrounding
 * pipes already (caller slices from TableCell or splits the delimiter
 * line). Whitespace inside is tolerated.
 */
export function parseColumnAlignment(cell: string): ColumnAlignment {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/**
 * Walk a `Table` lezer node and extract header + body cells as plain
 * text plus per-column alignment from the delimiter row. Cell text is
 * unescaped via {@link unescapeMarkdownInline} so escaped pipes (`\|`)
 * render as literal `|`.
 *
 * Lezer-markdown structure for a GFM table:
 *
 *   Table
 *     TableHeader        ← row of TableCells (the header row)
 *       TableCell
 *       TableCell
 *       …
 *     TableDelimiter     ← the `| --- | --- |` row (one node, line-level)
 *     TableRow           ← body row 0
 *       TableCell
 *       TableCell
 *       …
 *     TableRow           ← body row 1
 *     …
 *
 * `TableDelimiter` is a line-shaped node with no `TableCell` children —
 * we slice its source text directly and split on `|` to get per-column
 * delimiter tokens.
 *
 * Both `(| a | b |)` (trailing-pipe) and `(a | b)` (no-trailing-pipe)
 * GFM table syntaxes parse to the same TableCell structure — lezer
 * normalizes them. So cell extraction reads the same regardless.
 */
export function parseTableNode(
  table: SyntaxNode,
  state: EditorState,
  options: { unescapeCells?: boolean } = {},
): { header: string[]; body: string[][]; alignments: ColumnAlignment[] } {
  const unescapeCells = options.unescapeCells ?? true;
  const header: string[] = [];
  const body: string[][] = [];
  let alignments: ColumnAlignment[] = [];
  let child: SyntaxNode | null = table.firstChild;
  while (child !== null) {
    const cname = child.type.name;
    if (cname === 'TableHeader' || cname === 'TableRow') {
      const cells: string[] = [];
      let cell: SyntaxNode | null = child.firstChild;
      while (cell !== null) {
        if (cell.type.name === 'TableCell') {
          // Slice the cell's source text and trim outer whitespace.
          // Inner whitespace (multiple spaces between words) survives,
          // matching how the GFM rendering reads cell content.
          const raw = state.sliceDoc(cell.from, cell.to).trim();
          cells.push(unescapeCells ? unescapeMarkdownInline(raw) : raw);
        }
        cell = cell.nextSibling;
      }
      if (cname === 'TableHeader') {
        header.push(...cells);
      } else {
        body.push(cells);
      }
    } else if (cname === 'TableDelimiter') {
      // Slice the delimiter row's source line and split on bare `|`.
      // We strip a leading and trailing pipe if present (the optional
      // outer-pipe form), then split. No escape-aware splitting needed:
      // delimiter rows contain only `-`, `:`, `|`, and whitespace.
      let raw = state.sliceDoc(child.from, child.to).trim();
      if (raw.startsWith('|')) raw = raw.slice(1);
      if (raw.endsWith('|')) raw = raw.slice(0, -1);
      alignments = raw.split('|').map((part) => parseColumnAlignment(part));
    }
    child = child.nextSibling;
  }
  // Pad alignments to header column count with 'left' (default).
  while (alignments.length < header.length) alignments.push('left');
  return { header, body, alignments };
}

/**
 * Walk an `Image` lezer node and pull out alt text + URL.
 *
 * Children for an inline image `![alt](url)` appear as:
 *
 *   Image
 *     LinkMark      ← `![`  (2 chars, from..from+2)
 *     <inline alt>  ← zero or more inline nodes — the alt text as
 *                     parsed inline markdown. NOT a LinkLabel — that
 *                     node only appears for reference-style links.
 *                     For most plain alt text there are no child
 *                     nodes here, just raw source between the two
 *                     LinkMarks.
 *     LinkMark      ← `]`   (1 char) — the close-bracket
 *     LinkMark      ← `(`   (1 char)
 *     URL           ← the bare URL (with `<>` stripped if present)
 *     LinkTitle     ← optional title (ignored)
 *     LinkMark      ← `)`   (1 char)
 *
 * Reference-style image (`![alt][ref]`) emits a LinkLabel child
 * instead of `(URL)`. kb-1 has no reference-link infrastructure
 * today (no link-reference definitions are parsed) so we treat that
 * shape as malformed and return null.
 *
 * Alt-text extraction strategy: rather than walk inline children
 * (which can be multiple node types: Emphasis, InlineCode, plain
 * text gaps with no node), slice the source range between the
 * opening `![` and the close-bracket LinkMark. That's the unambiguous
 * span the parser already validated. We also unescape the slice so
 * `![a\]b](url)` recovers `a]b` as the alt text.
 *
 * Empty alt (`![](url)`) is valid. Empty URL is degenerate; return
 * null so the caller falls back to raw markdown rendering. URLs
 * wrapped in angle brackets (`<url>`) survive as the URL node's
 * slice — strip the brackets here.
 */
export function parseImageNode(
  image: SyntaxNode,
  state: EditorState,
): { alt: string; url: string } | null {
  let url: string | null = null;
  let closeBracketPos: number | null = null;
  let openParenPos: number | null = null;
  let child: SyntaxNode | null = image.firstChild;
  while (child !== null) {
    const cname = child.type.name;
    if (cname === 'URL') {
      let raw = state.sliceDoc(child.from, child.to).trim();
      // Strip `<>` wrapper used for URLs containing parens / spaces.
      if (raw.startsWith('<') && raw.endsWith('>')) {
        raw = raw.slice(1, -1);
      }
      url = raw;
    } else if (cname === 'LinkMark') {
      // LinkMarks come in order: `![`, `]`, `(`, `)`. The `]` is the
      // first single-char LinkMark we encounter (the `![` is 2 chars).
      const len = child.to - child.from;
      if (len === 1 && closeBracketPos === null) {
        // First single-char LinkMark = the `]`.
        const ch = state.sliceDoc(child.from, child.to);
        if (ch === ']') {
          closeBracketPos = child.from;
        } else if (ch === '(') {
          openParenPos = child.from;
        }
      } else if (len === 1 && openParenPos === null) {
        const ch = state.sliceDoc(child.from, child.to);
        if (ch === '(') openParenPos = child.from;
      }
    }
    child = child.nextSibling;
  }
  if (url === null || url === '') return null;
  // Alt text is everything between `![` (image.from + 2) and the
  // close-bracket. Fall back to '' if we couldn't locate the close.
  let alt = '';
  if (closeBracketPos !== null && closeBracketPos >= image.from + 2) {
    alt = unescapeMarkdownInline(state.sliceDoc(image.from + 2, closeBracketPos));
  }
  return { alt, url };
}

/* ---------------------------------------------------------------- *
 * Wikilink inline-parser extension (Slice 5)                         *
 *                                                                    *
 * Obsidian-style `[[target]]` / `[[target#heading]]` / `[[target|     *
 * alias]]` is not part of CommonMark, so lezer-markdown doesn't emit  *
 * a node for it by default. We add an `InlineParser` that runs        *
 * BEFORE the standard `Link` parser (which handles `[label](url)`)    *
 * and recognizes the `[[…]]` shape.                                   *
 *                                                                    *
 * The parser emits the following node structure for `[[t|alias]]`:    *
 *                                                                    *
 *   Wikilink                   ← outer span [[t|alias]]               *
 *     WikilinkMark             ← opening `[[`                          *
 *     WikilinkTarget           ← target text `t` (or `t#heading`)     *
 *     WikilinkAliasMark        ← pipe `|` (only when alias present)   *
 *     WikilinkAlias            ← alias text `alias`                   *
 *     WikilinkMark             ← closing `]]`                          *
 *                                                                    *
 * For the plain `[[t]]` case the AliasMark + Alias children are       *
 * omitted. This keeps the decoration walker's job mechanical: emit    *
 * the tinted label on Wikilink{Target,Alias}, and the cursor-reveal    *
 * syntax mark on WikilinkMark + the pipe.                              *
 *                                                                    *
 * Constraints — match the local wikilink parser so the same set of    *
 * inputs round-trips:                                                  *
 *                                                                    *
 *   - Inner text may not contain `[`, `]`, or newline. Bail (return  *
 *     -1) on those — partial input like `[[foo` or `[[a[b]]` stays   *
 *     unstyled until the user closes it cleanly.                     *
 *   - Empty target (`[[]]`, `[[|alias]]`) is dropped per              *
 *     `parseWikilinkInner` — we still emit the structural nodes so   *
 *     the cursor-reveal mark works (user can see the brackets while  *
 *     typing), but the decoration walker skips emitting a label for  *
 *     empty targets so we don't paint a 0-width tinted span.         *
 * ---------------------------------------------------------------- */

const CHAR_LBRACKET = 91; // '['
const CHAR_RBRACKET = 93; // ']'
const CHAR_NEWLINE = 10; // '\n'
const CHAR_PIPE = 124; // '|'

const wikilinkExtension: MarkdownConfig = {
  defineNodes: ['Wikilink', 'WikilinkMark', 'WikilinkTarget', 'WikilinkAliasMark', 'WikilinkAlias'],
  parseInline: [
    {
      name: 'Wikilink',
      // Run before the standard `Link` parser so `[[` is recognized as
      // a wikilink open rather than two adjacent reference-link opens.
      // The standard inline parsers list (per the lezer-markdown docs:
      // Escape, Entity, InlineCode, HTMLTag, Emphasis, HardBreak, Link,
      // Image) puts Link sixth from the end; we install before it.
      before: 'Link',
      parse(cx: InlineContext, next: number, pos: number): number {
        // Fast bail: the first char must be `[`. CommonMark guarantees
        // `next === cx.char(pos)` so we use `next` directly.
        if (next !== CHAR_LBRACKET) return -1;
        if (cx.char(pos + 1) !== CHAR_LBRACKET) return -1;

        const openEnd = pos + 2;
        let pipePos = -1;
        let scan = openEnd;
        while (scan < cx.end) {
          const ch = cx.char(scan);
          // Disallow `[`, `]` in the inner content. A `]` here means we
          // need the NEXT char to also be `]` (the close); a bare `]`
          // (or a `[`) inside is invalid wikilink syntax.
          if (ch === CHAR_RBRACKET) {
            if (cx.char(scan + 1) === CHAR_RBRACKET) {
              // Found the close `]]`.
              const closeStart = scan;
              const closeEnd = scan + 2;
              // Build children: open mark, target (and optional
              // alias-mark + alias), close mark. Empty inner segments
              // are omitted so positions stay valid (lezer-markdown
              // rejects zero-width child nodes).
              const children: ReturnType<typeof cx.elt>[] = [];
              children.push(cx.elt('WikilinkMark', pos, openEnd));
              if (pipePos !== -1) {
                if (pipePos > openEnd) {
                  children.push(cx.elt('WikilinkTarget', openEnd, pipePos));
                }
                children.push(cx.elt('WikilinkAliasMark', pipePos, pipePos + 1));
                if (closeStart > pipePos + 1) {
                  children.push(cx.elt('WikilinkAlias', pipePos + 1, closeStart));
                }
              } else if (closeStart > openEnd) {
                children.push(cx.elt('WikilinkTarget', openEnd, closeStart));
              }
              children.push(cx.elt('WikilinkMark', closeStart, closeEnd));
              cx.addElement(cx.elt('Wikilink', pos, closeEnd, children));
              return closeEnd;
            }
            // Bare `]` inside — bail.
            return -1;
          }
          if (ch === CHAR_LBRACKET || ch === CHAR_NEWLINE) return -1;
          if (ch === CHAR_PIPE && pipePos === -1) pipePos = scan;
          scan++;
        }
        // Ran off the end without finding `]]` — unmatched, bail.
        return -1;
      },
    },
  ],
};

/* ---------------------------------------------------------------- *
 * Footnote extension (Slice 4 of plaintext-editor Apple lane)        *
 *                                                                    *
 * GFM-style footnotes: inline references `[^id]` plus block           *
 * definitions `[^id]: definition text`. Not part of CommonMark or     *
 * lezer-markdown's bundled extensions, so we define our own with the  *
 * same shape as `wikilinkExtension` above (inline parser + block      *
 * parser + node spec list).                                           *
 *                                                                    *
 * Inline reference shape `[^foo]`:                                    *
 *                                                                    *
 *   FootnoteRef                                                       *
 *     FootnoteRefMark    ← `[^`                                       *
 *     FootnoteLabel      ← `foo` (id text)                            *
 *     FootnoteRefMark    ← `]`                                        *
 *                                                                    *
 * Block definition shape `[^foo]: body text`:                         *
 *                                                                    *
 *   FootnoteDef                                                       *
 *     FootnoteDefMark    ← `[^`                                       *
 *     FootnoteLabel      ← `foo`                                      *
 *     FootnoteDefMark    ← `]:`                                       *
 *     (body text inline-parsed by the surrounding paragraph)          *
 *                                                                    *
 * The block-definition shape is intentionally simple — single-line     *
 * canonical, multi-line graceful-fallback. We treat the line as a     *
 * paragraph-shaped block; if the user puts continuation text on the   *
 * following lines, the parser will pick it up as a separate paragraph *
 * which is fine for v1.                                                *
 *                                                                    *
 * Id constraint: alphanumeric, `_`, and `-`. Matches GFM's footnote   *
 * id regex (`[A-Za-z0-9_-]+`). Empty ids bail (-1) and the source     *
 * stays as raw text — same shape as wikilink's empty-target handling. *
 * ---------------------------------------------------------------- */

const CHAR_CARET = 94; // '^'
const CHAR_COLON = 58; // ':'

/** Test whether a char code is a valid footnote-id char. */
function isFootnoteIdChar(ch: number): boolean {
  return (
    (ch >= 48 && ch <= 57) /* 0-9 */ ||
    (ch >= 65 && ch <= 90) /* A-Z */ ||
    (ch >= 97 && ch <= 122) /* a-z */ ||
    ch === 95 /* _ */ ||
    ch === 45 /* - */
  );
}

/**
 * Test whether a line looks like the start of a footnote definition:
 * `[^<id>]:` at column 0 (no indent). Used by both the `endLeaf`
 * predicate (paragraph-interrupt) and `parse` (the actual block
 * match). Kept as a small shared helper so the two stay in lockstep.
 */
function looksLikeFootnoteDefStart(line: Line): boolean {
  if (line.pos !== line.basePos) return false;
  const text = line.text;
  const start = line.pos;
  if (text.charCodeAt(start) !== CHAR_LBRACKET) return false;
  if (text.charCodeAt(start + 1) !== CHAR_CARET) return false;
  let i = start + 2;
  const idStart = i;
  while (i < text.length && isFootnoteIdChar(text.charCodeAt(i))) i++;
  if (i === idStart) return false;
  if (text.charCodeAt(i) !== CHAR_RBRACKET) return false;
  if (text.charCodeAt(i + 1) !== CHAR_COLON) return false;
  return true;
}

const footnoteExtension: MarkdownConfig = {
  defineNodes: [
    'FootnoteRef',
    'FootnoteRefMark',
    'FootnoteLabel',
    'FootnoteDef',
    'FootnoteDefMark',
  ],
  parseInline: [
    {
      name: 'FootnoteRef',
      // Run before the standard `Link` parser (and after `Wikilink` —
      // wikilink runs `before: 'Link'` too, but `[[` requires two
      // brackets so the two parsers don't shadow each other; lezer
      // tries each in order and the first to return >= 0 wins).
      before: 'Link',
      parse(cx: InlineContext, next: number, pos: number): number {
        // Fast bail: must start with `[^`.
        if (next !== CHAR_LBRACKET) return -1;
        if (cx.char(pos + 1) !== CHAR_CARET) return -1;
        // First id char must exist and be valid.
        let scan = pos + 2;
        if (scan >= cx.end) return -1;
        if (!isFootnoteIdChar(cx.char(scan))) return -1;
        // Consume the id run.
        const idStart = scan;
        while (scan < cx.end && isFootnoteIdChar(cx.char(scan))) {
          scan++;
        }
        const idEnd = scan;
        if (idStart === idEnd) return -1;
        // Next char must be `]`.
        if (scan >= cx.end || cx.char(scan) !== CHAR_RBRACKET) return -1;
        const closeStart = scan;
        const closeEnd = scan + 1;
        // Build children + element.
        const children = [
          cx.elt('FootnoteRefMark', pos, idStart),
          cx.elt('FootnoteLabel', idStart, idEnd),
          cx.elt('FootnoteRefMark', closeStart, closeEnd),
        ];
        cx.addElement(cx.elt('FootnoteRef', pos, closeEnd, children));
        return closeEnd;
      },
    },
  ],
  parseBlock: [
    {
      name: 'FootnoteDef',
      // Run before LinkReference — same reason wikilink runs before
      // Link: `[^id]: body` would otherwise be eligible as the start of
      // a link-reference definition under lezer-markdown's default
      // parser (which requires `[label]: url` shape, but the leading
      // `[` matches and we want our parse to win unambiguously).
      before: 'LinkReference',
      // CommonMark paragraphs continue across non-blank lines, so a
      // `[^id]: body` line that immediately follows a paragraph (no
      // blank line between) would be absorbed into the paragraph and
      // never reach our `parse()` callback. `endLeaf` lets us interrupt
      // the running paragraph when we see a definition start, mirroring
      // how Table / SetextHeading interrupt paragraphs in the bundled
      // GFM parsers.
      endLeaf(_cx: BlockContext, line: Line): boolean {
        return looksLikeFootnoteDefStart(line);
      },
      parse(cx: BlockContext, line: Line): boolean {
        // Footnote definitions must start at column 0 (no indent). This
        // is a deliberate v1 simplification: indented continuation lines
        // remain readable as part of the body paragraph that follows.
        if (!looksLikeFootnoteDefStart(line)) return false;
        const text = line.text;
        const start = line.pos;
        // Re-scan for the id-end + `]:` positions — the predicate above
        // already verified shape, so this just locates offsets.
        let i = start + 2;
        const idStart = i;
        while (i < text.length && isFootnoteIdChar(text.charCodeAt(i))) {
          i++;
        }
        const idEnd = i;
        // Convert line-relative offsets to document-absolute.
        const lineStart = cx.lineStart;
        const refStart = lineStart + start; // `[`
        const labelStart = lineStart + idStart;
        const labelEnd = lineStart + idEnd;
        const closeStart = lineStart + i; // `]`
        const closeEnd = lineStart + i + 2; // after `]:`
        const lineEnd = lineStart + text.length;
        // Inline-parse the body text after `]:` so emphasis / inline
        // code / wikilinks inside the definition get their own nodes
        // (same shape lezer-markdown uses for ATXHeading / TableCell —
        // see lezer-markdown/dist/index.js parseInline call sites).
        const bodyChildren = cx.parser.parseInline(text.slice(i + 2), closeEnd);
        const children = [
          cx.elt('FootnoteDefMark', refStart, labelStart),
          cx.elt('FootnoteLabel', labelStart, labelEnd),
          cx.elt('FootnoteDefMark', closeStart, closeEnd),
          ...bodyChildren,
        ];
        cx.addElement(cx.elt('FootnoteDef', refStart, lineEnd, children));
        // Consume the line so it's not also parsed as a paragraph.
        cx.nextLine();
        return true;
      },
    },
  ],
};

/* ---------------------------------------------------------------- *
 * Tree walk + decoration build                                      *
 * ---------------------------------------------------------------- */

/**
 * Build the markdown decoration set for the given state. Pulled out
 * of the plugin class so unit tests can call it without instantiating
 * an EditorView.
 *
 * Cursor-reveal: `cursor` is the main selection head; when it falls
 * inside an emphasis / code / list / blockquote / fence range
 * (inclusive boundaries) we skip the `cm-hidden` mark for that range's
 * syntax children so the user sees the raw markdown around their caret.
 *
 * Focus-gating (Slice F): cursor-reveal is AND-gated by `focused`.
 * When the editor has lost DOM focus we force `intersects()` to return
 * false everywhere — every syntax char gets `hiddenSyntaxMark`, the
 * document reads as Bear-style preview. ListMark (Slice L) participates
 * in this gate too: when unfocused, every bullet renders as its
 * shape-glyph / auto-number widget and every checkbox engages. Widget
 * replaces (Table/Image) also re-engage when focus is false, since
 * their "cursor inside" check uses the same `intersects` helper.
 *
 * For ATX heading lines we always hide the `#`-run + the single
 * trailing space (the `HeaderMark` child); revealing the heading
 * marker on caret placement isn't part of this slice — line-level
 * decorations stay stable so the line doesn't visually reflow under
 * the caret. (Obsidian itself reveals the marker on heading lines,
 * but adding that affordance is a one-liner future slice.)
 */
export function buildMarkdownDecorations(
  state: EditorState,
  selection: { from: number; to: number },
  options: {
    attachmentSrc?: (path: string) => string;
    focused?: boolean;
    livePaths?: readonly LivePath[];
    /** Org directory for mention chip resolution. Defaults to empty —
     *  every mention then renders with the stale modifier, which is the
     *  honest signal in a no-vault context (Storybook, no-org tests). */
    orgPeople?: readonly OrgPerson[];
    onWikilinkClick?: (encodedTarget: string, event: MouseEvent) => void;
  } = {},
): DecorationSet {
  const attachmentSrc = options.attachmentSrc;
  const livePaths = options.livePaths ?? [];
  const orgPeople = options.orgPeople ?? [];
  const onWikilinkClick = options.onWikilinkClick;
  // Default to `true` (focused) when omitted so existing callers / tests
  // exercise the same cursor-reveal behaviour they always have. The
  // production wiring in `markdownDecorationField` passes the real
  // focus state from `editorFocusField`.
  const focused = options.focused ?? true;
  const selFrom = selection.from;
  const selTo = selection.to;
  // Reveal a widget / decorated range when the user's selection range
  // intersects [from, to] — drag-right and drag-left across a widget
  // both reveal, matching Obsidian's behaviour. For a collapsed caret
  // this collapses to the previous `cursor` semantics (selFrom = selTo
  // = head). For a heading line we still use the line-as-context
  // intersection check — selection touching any part of the line
  // reveals the marker.
  //
  // Focus-gate: when the editor is unfocused, no range "intersects" —
  // ALL syntax chars hide, the doc reads as Bear-style preview at rest.
  // ListMark (Slice L) participates in this gate: unfocused → every
  // bullet renders as a shape-glyph widget and every ordered number
  // as an auto-numbered widget. Same path as focused-but-cursor-out.
  const intersects = (from: number, to: number): boolean =>
    focused && selFrom <= to && selTo >= from;
  // Two passes' worth of items collected first, sorted, then fed into
  // a single RangeSetBuilder. CM6's RangeSetBuilder requires monotonic
  // `from` and ordered `startSide` at equal positions. Decoration.line
  // has startSide -200, Decoration.mark has startSide 5e8, so a single
  // ordered walk yields the correct sequence once we sort.
  //
  // The `replace` kind covers `Decoration.replace({ widget })` for
  // Table (block) and Image (inline). It packs `from` + `to` like
  // `mark` but emits via `builder.add(from, to, replaceDeco)`.
  //
  // Table / Image source ranges that the cursor is *inside* are
  // tracked here as `skipChildrenIn` — when set, the iterator's
  // inner walk skips emitting child decorations (e.g. the `*` and
  // `_` inside a table cell's text won't get hidden as emphasis
  // syntax, because the whole table is in "raw markdown" mode).
  type DecoItem =
    | { kind: 'line'; pos: number; deco: Decoration }
    | { kind: 'mark'; from: number; to: number; deco: Decoration }
    | { kind: 'replace'; from: number; to: number; deco: Decoration };
  const items: DecoItem[] = [];
  const pushVisibleMark = (from: number, to: number): void => {
    items.push({ kind: 'mark', from, to, deco: visibleSyntaxMark });
  };

  // Widget-replaced ranges (Table / Image) skip child decoration by
  // returning `false` from the iterate enter callback below, which
  // prevents descent into the replaced subtree. No separate membership
  // bookkeeping is needed.

  const tree = syntaxTree(state);

  // -- Footnote definition pre-pass ----------------------------------
  // Collect the set of footnote ids that are defined somewhere in the
  // doc, so the inline-reference branch can mark refs without a
  // matching definition as "broken" (same broken-link visual register
  // as wikilinks). We walk the tree once cheaply for FootnoteDef nodes
  // and read their FootnoteLabel child. Two-pass design intentionally
  // mirrors how `getLivePaths` flows through the wikilink branch — the
  // resolution context is computed before the main walk emits marks.
  //
  // We also collect `rawFootnoteDefLines` in the same pass — the set of
  // doc-line numbers occupied by a FootnoteDef where the selection's
  // head sits on that line (focus-gated). Inline decoration branches
  // consult this set to drop the entire line back to raw markdown when
  // the cursor is in the def, mirroring how the FencedCode branch
  // treats a fence's full range as "raw mode" when `cursorOnFence` is
  // true. FootnoteDef is single-line per the parser (see the
  // `[^id]: body` parseBlock above — `lineEnd = lineStart + text.length`)
  // so a per-line set is sufficient; if multi-line continuation lands
  // later, extend to a per-range structure.
  const footnoteDefIds = new Set<string>();
  const rawFootnoteDefLines = new Set<number>();
  const cursorLineNumber = focused ? state.doc.lineAt(selTo).number : -1;
  tree.iterate({
    enter: (n: SyntaxNodeRef) => {
      if (n.type.name === 'FootnoteDef') {
        let child: SyntaxNode | null = n.node.firstChild;
        while (child !== null) {
          if (child.type.name === 'FootnoteLabel') {
            footnoteDefIds.add(state.sliceDoc(child.from, child.to));
            break;
          }
          child = child.nextSibling;
        }
        if (focused) {
          const defLine = state.doc.lineAt(n.from).number;
          if (defLine === cursorLineNumber) {
            rawFootnoteDefLines.add(defLine);
          }
        }
        return false;
      }
      return undefined;
    },
  });

  /**
   * True when `pos` lies on a FootnoteDef line the cursor is currently
   * on. Used by inline decoration branches to suppress range styling
   * (bold / italic / strike / inline-code), force visible syntax
   * marks, and skip widget replacements (mention chips) so the entire
   * def line drops back to raw markdown — the same shape FencedCode
   * uses for cursor-on-fence.
   *
   * Cheap: O(1) per call (Set lookup + line lookup), and only computed
   * for nodes whose decoration emission would otherwise change. The
   * empty-set fast-path covers the common case (no footnote def, or
   * cursor not on a def line).
   */
  const isInRawFootnoteDefLine = (pos: number): boolean => {
    if (rawFootnoteDefLines.size === 0) return false;
    return rawFootnoteDefLines.has(state.doc.lineAt(pos).number);
  };

  // -- Ordered-list auto-numbering pre-pass (Slice L) ----------------
  // Walk OrderedList nodes and assign a display number to each direct
  // ListItem child. The main walk's ListMark branch looks up by
  // `listItem.from` to render the auto-numbered widget instead of the
  // raw source number.
  const orderedNumbers = computeOrderedListNumbers(tree, state);

  tree.iterate({
    enter: (node: SyntaxNodeRef) => {
      const name = node.type.name;

      // -- Table (GFM) ----------------------------------------------
      // Block-widget replacement when cursor is outside the table's
      // source range. Cursor inside any part of the table (header,
      // delimiter row, body, any cell) → skip the widget and let raw
      // pipe-syntax render via the underlying source. We also push
      // the table's range into `widgetRanges` so descending children
      // (TableHeader / TableRow / TableCell / TableDelimiter / any
      // inline marks inside cells) don't emit competing decorations
      // beneath the replace.
      if (name === 'Table') {
        const from = node.from;
        const to = node.to;
        const cursorInside = intersects(from, to);
        if (!cursorInside) {
          const { header, body, alignments } = parseTableNode(node.node, state, {
            unescapeCells: false,
          });
          // Defensive: a Table parse with no header row would render
          // a useless empty <table>. Fall through to raw markdown in
          // that pathological case — simplicity-pressure says don't
          // build mechanism to render nothing, the source is fine.
          if (header.length > 0) {
            items.push({
              kind: 'replace',
              from,
              to,
              deco: Decoration.replace({
                widget: new TableWidget(header, body, alignments, {
                  key: tableInlineContextKey(livePaths, orgPeople),
                  livePaths,
                  orgPeople,
                  onWikilinkClick,
                }),
                block: true,
              }),
            });
            // Returning false would skip descent; but we need to skip
            // descent because we don't want child decorations inside
            // the widget range. The iterate API uses the enter
            // function's return value: `false` = don't descend. Note
            // the return signature: tree.iterate's `enter` returning
            // `false` skips children. We're inside an arrow function
            // assigned to `enter`, so `return false` works.
            return false;
          }
        }
        // Cursor inside (or header was empty) → raw source. Do not
        // descend into TableCell children, otherwise chips/links/bold
        // render while the user is trying to edit pipe syntax, which
        // is the backwards half of the table-cell editing behavior.
        return false;
      }

      // -- Image (inline) -------------------------------------------
      // Inline replacement with `<img>` widget when cursor is outside
      // the source range. Image children: LinkMark (`![`, `](`, `)`)
      // / LinkLabel (alt text) / URL (image src). Extract those, build
      // the resolved URL via the attachment-path remap, and emit the
      // replace. We don't recurse into children — they're inside the
      // replaced range anyway.
      if (name === 'Image') {
        const from = node.from;
        const to = node.to;
        const cursorInside = intersects(from, to);
        if (cursorInside) {
          // Cursor inside → show raw `![alt](url)` markdown. Skip
          // the widget but still descend so LinkMark children get
          // the standard cm-md-syntax (visible) marker — keeps the
          // visual model consistent with other syntax marks.
          return undefined;
        }
        const parsed = parseImageNode(node.node, state);
        if (parsed === null) {
          // Malformed parse (no URL child); fall back to raw markdown.
          return undefined;
        }
        // Sentinel detection runs on the *raw* URL before attachment-
        // path remapping, so `pending-upload://<uuid>` /
        // `upload-failed://<uuid>` short-circuit straight to the spinner
        // / broken-image rendering — `attachmentSrc` won't recognize
        // those schemes anyway. Normal paths fall through to the usual
        // resolve-then-render flow.
        const mode = classifyImageUrl(parsed.url);
        const resolvedSrc = mode === 'normal' ? resolveImageUrl(parsed.url, attachmentSrc) : '';
        items.push({
          kind: 'replace',
          from,
          to,
          deco: Decoration.replace({
            widget: new ImageWidget(resolvedSrc, parsed.alt, mode),
          }),
        });
        return false;
      }

      // -- Escapes inside link labels -------------------------------
      // CommonMark requires nested `[` / `]` characters in link labels
      // to be escaped. Keep those escapes in the source so the parser
      // retains the outer Link node, but hide only the slash while the
      // link is rendered. The normal line-based Link reveal still shows
      // the original Markdown when the user edits that line.
      if (name === 'Escape') {
        const escaped = state.sliceDoc(node.from, node.to);
        if (escaped === '\\[' || escaped === '\\]') {
          let link: SyntaxNode | null = node.node.parent;
          while (link !== null && link.type.name !== 'Link') link = link.parent;

          if (link !== null) {
            let closeBracket: number | null = null;
            let child: SyntaxNode | null = link.firstChild;
            while (child !== null) {
              if (
                child.type.name === 'LinkMark' &&
                state.sliceDoc(child.from, child.to) === ']'
              ) {
                closeBracket = child.from;
                break;
              }
              child = child.nextSibling;
            }

            const escapeLine = state.doc.lineAt(node.from);
            if (
              closeBracket !== null &&
              node.to <= closeBracket &&
              !intersects(escapeLine.from, escapeLine.to)
            ) {
              items.push({
                kind: 'mark',
                from: node.from,
                to: node.from + 1,
                deco: hiddenSyntaxMark,
              });
            }
          }
        }
        return false;
      }

      // -- Link (inline) --------------------------------------------
      // `[label](url)` — emit a `.cm-md-link-label` mark over the
      // label range so CSS can paint a subtle tint. The bracket /
      // paren syntax chars (LinkMark) and the URL slice are handled
      // by the syntax-mark branch below: line-based reveal — same line
      // as cursor renders raw markdown, off-line collapses to the
      // tinted label. Click handling lives in plaintext-link-affordance.
      //
      // Mentions ride on this exact shape — `[Name](mention:email)` is a
      // CommonMark inline link with a custom URL scheme (no new node, no
      // schema change). When the URL parses via `parseMentionUrl` we emit
      // a `Decoration.replace` + `MentionChipWidget` (see
      // `plaintext-mention-widget.ts`) that mounts the canonical
      // `<Avatar>` Svelte component in place of the link's source range,
      // instead of the default link tint. Per-Link reveal gating: cursor
      // INSIDE the source range skips the widget so raw markdown surfaces
      // for editing; OUTSIDE emits the widget.
      if (name === 'Link') {
        // Shape A (URL links): skip the label paint when cursor is on
        // the Link's line — click lands as text-position (no
        // `.cm-md-link-label` class for the affordance handler to
        // match). Use selection head (`selTo` for collapsed cursors).
        //
        // Mentions diverge: the chip's click handler doesn't navigate
        // (it's currently a no-op — see plaintext-link-affordance), so
        // the click-cancellation problem URL links solve via line-based
        // gating doesn't apply. Per-Link reveal is what Yoh actually
        // expects: only the Link the cursor sits inside reveals its
        // raw `[Name](mention:email)` source; sibling mentions on the
        // same line stay rendered as chips.
        //
        // Inclusion rule: cursor INSIDE iff `selTo >= linkFrom &&
        // selTo < linkTo`. `selTo === linkFrom` (click landed on the
        // chip's leading `[`) counts as inside so the click reveals
        // the source. `selTo === linkTo` (cursor just after `)`)
        // counts as outside so typing-after doesn't flicker the chip.
        // Locate the close-bracket position AND classify the Link as
        // mention vs URL link by walking children. The first single-
        // char LinkMark equal to `]` is the close-bracket.
        let closeBracket: number | null = null;
        let child: SyntaxNode | null = node.node.firstChild;
        while (child !== null) {
          if (child.type.name === 'LinkMark') {
            const len = child.to - child.from;
            if (len === 1 && closeBracket === null) {
              const ch = state.sliceDoc(child.from, child.to);
              if (ch === ']') {
                closeBracket = child.from;
              }
            }
          }
          child = child.nextSibling;
        }
        const mentionEmail = extractMentionEmailFromLink(node.node, state);
        // Chip-paint gate: per-Link for mentions, line-based for URL
        // links. `linkFrom`/`linkTo` are the full Link's source span
        // (including `[`, `]`, `(url)`). For URL links we keep the
        // line-based behaviour to preserve the click-cancellation
        // workaround documented in plaintext-link-affordance.
        //
        // Footnote-def override: when the Link sits on a FootnoteDef
        // line the cursor is on, suppress the chip regardless of the
        // per-Link rule. This drops mention chips inside a footnote
        // body back to raw `[Name](mention:email)` source as part of
        // the line-wide raw-markdown mode the rest of the inline
        // decorations honor via `isInRawFootnoteDefLine`.
        const linkFrom = node.from;
        const linkTo = node.to;
        let suppressChip: boolean;
        if (mentionEmail !== null) {
          const cursorInsideLink = focused && selTo >= linkFrom && selTo < linkTo;
          suppressChip = cursorInsideLink || isInRawFootnoteDefLine(linkFrom);
        } else {
          const linkLine = state.doc.lineAt(linkFrom).number;
          const cursorLine = state.doc.lineAt(selTo).number;
          suppressChip = focused && linkLine === cursorLine;
        }
        if (!suppressChip && closeBracket !== null && closeBracket > node.from + 1) {
          if (mentionEmail !== null) {
            // Mention: emit a Decoration.replace + MentionChipWidget
            // covering the ENTIRE link source span. The widget mounts
            // <MentionChip> (which composes the canonical <Avatar>) so
            // visual parity with HISTORY / byline / file-row avatars is
            // structural. Skip descent — the widget replaces the source
            // range completely; child syntax marks (the `[`, `]`, `(`,
            // `)`, URL slice) aren't visible while the widget renders.
            //
            // When the cursor enters the source range (`suppressChip`
            // true), this branch is skipped, the iterator descends, and
            // the syntax-mark hide/reveal branch below paints the raw
            // markdown for in-place editing — exactly the same per-Link
            // reveal contract the CSS chip honored.
            const resolved = resolvePerson(mentionEmail, orgPeople);
            const props = buildMentionWidgetProps(mentionEmail, resolved);
            items.push({
              kind: 'replace',
              from: linkFrom,
              to: linkTo,
              deco: Decoration.replace({
                widget: new MentionChipWidget(props),
              }),
            });
            return false;
          }
          items.push({
            kind: 'mark',
            from: node.from + 1,
            to: closeBracket,
            deco: linkLabelMark,
          });
        }
        // Descend so children (LinkMark, URL, inline emphasis inside
        // the label) get their own decorations — including the syntax-
        // mark hide/reveal for `[`, `](`, `mention:email`, `)`.
        return undefined;
      }

      // -- Autolink (GFM) -------------------------------------------
      // GFM's Autolink extension emits a bare `URL` node (no enclosing
      // `Link`, no `LinkMark` children) for matches against
      // `http(s)://`, `www.`, `mailto:`, `xmpp:`, and bare emails. See
      // `@lezer/markdown`'s `Autolink` definition — it calls
      // `cx.addElement(cx.elt("URL", absPos, end))` directly.
      //
      // Detection rule: a `URL` node whose parent is NOT `Link` or
      // `Image` is an autolink. The `[label](url)` / `![alt](url)`
      // cases own their URL child via the syntax-mark branch below
      // (cursor-reveal of the parenthesized URL).
      //
      // Decoration: emit `.cm-md-link-label` over the URL range so
      // CSS paints the sky tint + pointer cursor (same visual register
      // as inline link labels — semantically equivalent: tinted
      // clickable text that opens a destination). Shape A line-based
      // reveal: cursor on the same line → skip the paint so a click
      // lands as text-position (default CM6) and the user can edit
      // the URL source character-by-character.
      //
      // Click handling lives in `plaintext-link-affordance.ts`; the
      // handler recognizes `.cm-md-link-label` already, resolves the
      // ancestor, and now handles the `URL`-as-ancestor case (no
      // wrapping Link) by slicing the URL text directly.
      if (name === 'URL') {
        const parent = node.node.parent;
        const pname = parent?.type.name;
        if (pname !== 'Link' && pname !== 'Image') {
          const urlLine = state.doc.lineAt(node.from).number;
          const cursorLine = state.doc.lineAt(selTo).number;
          const cursorOnSameLine = focused && urlLine === cursorLine;
          if (!cursorOnSameLine) {
            items.push({
              kind: 'mark',
              from: node.from,
              to: node.to,
              deco: linkLabelMark,
            });
          }
          // No children to descend into (Autolink's URL node is a
          // leaf — `cx.elt("URL", from, to)` with no nested elts).
          return false;
        }
      }

      // -- Wikilink (Slice 5) ---------------------------------------
      // `[[target]]` / `[[target#heading]]` / `[[target|alias]]`.
      // Emitted by our custom `wikilinkExtension` inline parser (see
      // top of file). Children: WikilinkMark (`[[` and `]]`),
      // WikilinkTarget (target+heading text), optional WikilinkAliasMark
      // (`|`) + WikilinkAlias (alias text).
      //
      // Decoration plan:
      //   - WikilinkMark ranges → cm-md-syntax cursor-reveal (hidden
      //     when selection is outside the Wikilink; visible when inside).
      //   - When an alias is present: target+pipe also collapse as
      //     syntax (the alias is the user-facing label), so off-cursor
      //     the reader sees just the alias text tinted.
      //   - When no alias: the target is the visible label.
      //   - Label range gets `cm-md-wikilink-label` (resolved) or
      //     `cm-md-wikilink-broken` (unresolved against livePaths) so
      //     CSS can paint distinct tones.
      //   - Empty target (`[[]]`) → emit no label, only the syntax
      //     marks so the user still sees the brackets while typing.
      //
      // Resolution uses the same parser and resolver as the click flow,
      // so visual state stays consistent with interaction.
      if (name === 'Wikilink') {
        const wikilinkNode = node.node;
        const wikilinkFrom = wikilinkNode.from;
        // Shape A: line-based reveal. Cursor on the wikilink's line →
        // reveal raw `[[target]]` + skip label paint so a click lands as
        // text-position (default CM6) instead of follow. Use `selTo` as
        // the head — collapsed-cursor case is selFrom === selTo, range
        // selection uses the active end for the line check.
        const wikilinkLine = state.doc.lineAt(wikilinkFrom).number;
        const cursorLine = state.doc.lineAt(selTo).number;
        const cursorOnSameLine = focused && wikilinkLine === cursorLine;

        // Walk children once to identify each segment.
        let openMark: SyntaxNode | null = null;
        let closeMark: SyntaxNode | null = null;
        let targetNode: SyntaxNode | null = null;
        let aliasMark: SyntaxNode | null = null;
        let aliasNode: SyntaxNode | null = null;
        let child: SyntaxNode | null = wikilinkNode.firstChild;
        while (child !== null) {
          const cname = child.type.name;
          if (cname === 'WikilinkMark') {
            if (openMark === null) openMark = child;
            else closeMark = child;
          } else if (cname === 'WikilinkTarget') {
            targetNode = child;
          } else if (cname === 'WikilinkAliasMark') {
            aliasMark = child;
          } else if (cname === 'WikilinkAlias') {
            aliasNode = child;
          }
          child = child.nextSibling;
        }

        // Syntax-char marks: the opening `[[` and closing `]]` always.
        // Line-based reveal — hidden when cursor is off the line, visible
        // when on the same line.
        const syntaxDeco = cursorOnSameLine ? visibleSyntaxMark : hiddenSyntaxMark;
        if (openMark !== null && openMark.from < openMark.to) {
          items.push({
            kind: 'mark',
            from: openMark.from,
            to: openMark.to,
            deco: syntaxDeco,
          });
        }
        if (closeMark !== null && closeMark.from < closeMark.to) {
          items.push({
            kind: 'mark',
            from: closeMark.from,
            to: closeMark.to,
            deco: syntaxDeco,
          });
        }

        // Resolve the target against livePaths so we can pick the
        // resolved vs broken label tone. Use the canonical parser so
        // `[[target#heading|alias]]` splits the same way the load/save
        // path does — heading is part of the target span visually but
        // we resolve against just the page name.
        const targetText =
          targetNode !== null ? state.sliceDoc(targetNode.from, targetNode.to) : '';
        const parts = parseWikilinkInner(targetText + (aliasNode !== null ? '|' : ''));
        // `parseWikilinkInner` accepts the full inner including the
        // optional `|alias` tail; we pass `target+|` so we get back the
        // bare target without dragging in alias-text again. The trailing
        // `|` shouldn't normally happen but `parseWikilinkInner` handles
        // an empty alias by returning `alias: undefined`, which is what
        // we want — we only care about `parts.target` here.
        const resolved =
          parts !== null ? resolveLinkTarget({ raw: parts.target, livePaths }) : null;
        const labelDeco = resolved !== null ? wikilinkLabelMark : wikilinkBrokenMark;

        // Label emission: alias takes precedence when present. Skip the
        // label paint entirely when the cursor is on the same line —
        // Shape A wants the link to render as raw markdown so a click
        // lands as text-position (the click handler gates on the
        // `.cm-md-{link,wikilink}-label` class via `closest()`; without
        // the class, the default CM6 click-to-position runs).
        if (aliasNode !== null && aliasNode.from < aliasNode.to) {
          if (!cursorOnSameLine) {
            // Tint the alias as the visible label.
            items.push({
              kind: 'mark',
              from: aliasNode.from,
              to: aliasNode.to,
              deco: labelDeco,
            });
            // Hide the target + pipe as syntax (off-cursor only — same-
            // line already reveals everything via syntaxDeco above).
            if (targetNode !== null && targetNode.from < targetNode.to) {
              items.push({
                kind: 'mark',
                from: targetNode.from,
                to: targetNode.to,
                deco: syntaxDeco,
              });
            }
            if (aliasMark !== null && aliasMark.from < aliasMark.to) {
              items.push({
                kind: 'mark',
                from: aliasMark.from,
                to: aliasMark.to,
                deco: syntaxDeco,
              });
            }
          }
        } else if (!cursorOnSameLine && targetNode !== null && targetNode.from < targetNode.to) {
          // No alias — the target IS the label.
          items.push({
            kind: 'mark',
            from: targetNode.from,
            to: targetNode.to,
            deco: labelDeco,
          });
        }
        // Skip descent — there are no nested decoratable nodes inside a
        // Wikilink (the children are all syntax-level spans we just
        // handled).
        return false;
      }

      // -- FootnoteRef (Slice 4 of plaintext Apple lane) -------------
      // Inline `[^id]` reference. Children: FootnoteRefMark `[^`,
      // FootnoteLabel `id`, FootnoteRefMark `]`. We paint a small
      // superscript span over the FootnoteLabel range when the cursor
      // is OFF the line, and hide the surrounding `[^` / `]` syntax
      // chars; cursor on the line reveals everything as raw text.
      //
      // Broken-state: if no matching FootnoteDef exists in the doc,
      // the label paints with `cm-md-footnote-ref-broken` so CSS can
      // tint it with the same dotted-underline broken-link register
      // used by wikilinks.
      if (name === 'FootnoteRef') {
        const refNode = node.node;
        const refLine = state.doc.lineAt(refNode.from).number;
        const cursorLine = state.doc.lineAt(selTo).number;
        const cursorOnSameLine = focused && refLine === cursorLine;

        let openMark: SyntaxNode | null = null;
        let closeMark: SyntaxNode | null = null;
        let labelNode: SyntaxNode | null = null;
        let child: SyntaxNode | null = refNode.firstChild;
        while (child !== null) {
          const cname = child.type.name;
          if (cname === 'FootnoteRefMark') {
            if (openMark === null) openMark = child;
            else closeMark = child;
          } else if (cname === 'FootnoteLabel') {
            labelNode = child;
          }
          child = child.nextSibling;
        }

        const syntaxDeco = cursorOnSameLine ? visibleSyntaxMark : hiddenSyntaxMark;
        if (openMark !== null && openMark.from < openMark.to) {
          items.push({
            kind: 'mark',
            from: openMark.from,
            to: openMark.to,
            deco: syntaxDeco,
          });
        }
        if (closeMark !== null && closeMark.from < closeMark.to) {
          items.push({
            kind: 'mark',
            from: closeMark.from,
            to: closeMark.to,
            deco: syntaxDeco,
          });
        }

        if (!cursorOnSameLine && labelNode !== null && labelNode.from < labelNode.to) {
          const id = state.sliceDoc(labelNode.from, labelNode.to);
          const isBroken = !footnoteDefIds.has(id);
          items.push({
            kind: 'mark',
            from: labelNode.from,
            to: labelNode.to,
            deco: isBroken ? footnoteRefBrokenMark : footnoteRefMark,
          });
        }
        // Skip descent — children are syntax-level spans we just
        // handled.
        return false;
      }

      // -- FootnoteDef (Slice 4 + Bear-inline rework) ----------------
      // Block definition `[^id]: body text`. Rendered in the Bear Notes
      // style: the line flows as ordinary prose with `name:` painted
      // inline in link color at the start. No gutter chip, no card
      // chrome — the def reads as `name: body…` with the `name` portion
      // colored like a link, and the `:` flowing as plain text.
      //
      // Off-line: hide `[^` (open mark) and the `]` of the close mark
      // via cm-hidden; paint the FootnoteLabel name with
      // `cm-md-footnote-label` for link-tone color; leave the `:` of
      // the close mark visible and unstyled so it reads as ordinary
      // punctuation in the paragraph.
      //
      // Cursor ON the def line: drop the ENTIRE presentation back to
      // raw markdown — the inline-range / syntax-char gates already
      // keyed off `isInRawFootnoteDefLine` reveal raw `**bold**` /
      // `*italic*` / `[[wikilink]]` text, and here we likewise reveal
      // `[^` and `]` and skip the label paint so the source surfaces.
      if (name === 'FootnoteDef') {
        const defNode = node.node;
        const line = state.doc.lineAt(defNode.from);
        const cursorOnSameLine = focused && state.doc.lineAt(selTo).number === line.number;

        let openMark: SyntaxNode | null = null;
        let closeMark: SyntaxNode | null = null;
        let labelNode: SyntaxNode | null = null;
        let child: SyntaxNode | null = defNode.firstChild;
        while (child !== null) {
          const cname = child.type.name;
          if (cname === 'FootnoteDefMark') {
            if (openMark === null) openMark = child;
            else closeMark = child;
          } else if (cname === 'FootnoteLabel') {
            labelNode = child;
          }
          child = child.nextSibling;
        }

        // Hide `[^` (open mark) off-line, reveal on-line.
        const syntaxDeco = cursorOnSameLine ? visibleSyntaxMark : hiddenSyntaxMark;
        if (openMark !== null && openMark.from < openMark.to) {
          items.push({
            kind: 'mark',
            from: openMark.from,
            to: openMark.to,
            deco: syntaxDeco,
          });
        }
        // Paint the label name in link color off-line; on-line drop the
        // paint so the user edits the raw id text without recolor.
        if (!cursorOnSameLine && labelNode !== null && labelNode.from < labelNode.to) {
          items.push({
            kind: 'mark',
            from: labelNode.from,
            to: labelNode.to,
            deco: footnoteDefLabelMark,
          });
        }
        // Close mark is the two chars `]:`. Hide just the `]` off-line;
        // leave the `:` visible (it flows as ordinary punctuation in
        // the Bear-style "name: body" inline render). On-line, reveal
        // the `]` so the raw `]:` source surfaces. Parser guarantees
        // closeMark spans `]:` (length 2) when present.
        if (closeMark !== null && closeMark.from < closeMark.to) {
          const bracketEnd = Math.min(closeMark.from + 1, closeMark.to);
          if (bracketEnd > closeMark.from) {
            items.push({
              kind: 'mark',
              from: closeMark.from,
              to: bracketEnd,
              deco: syntaxDeco,
            });
          }
        }
        // Descend so any inline marks (Wikilink, emphasis) inside the
        // body text get their own decorations.
        return undefined;
      }

      // -- Heading lines ---------------------------------------------
      // ATXHeading1..6 — emit a line decoration for the whole line and
      // hide the leading `#`s + trailing space (the HeaderMark child)
      // when the cursor is not on the line.
      const headingMatch = /^ATXHeading([1-6])$/.exec(name);
      if (headingMatch) {
        const level = Number(headingMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6;
        const line = state.doc.lineAt(node.from);
        items.push({
          kind: 'line',
          pos: line.from,
          deco: headingDeco[level],
        });
        return;
      }

      // -- TaskMarker (GFM task list) --------------------------------
      // `[ ]` / `[x]` / `[X]` at the start of a list item's content.
      // Lezer-markdown's TaskList extension nests inside a ListItem:
      //
      //   ListItem
      //     ListMark            ← `- ` (suppressed on task items — Slice L)
      //     Task                ← block; spans `[ ]` + inline content
      //       TaskMarker        ← exactly 3 chars: `[ ]` / `[x]` / `[X]`
      //       (inline content from offset 3)
      //
      // Replace the 3-char TaskMarker range with a custom-glyph checkbox
      // widget when the cursor is OFF the enclosing ListItem; show raw
      // `[ ]` / `[x]` source when the cursor is on the line (so the user
      // can keyboard-edit it). Uses the same `intersects(listItem.from,
      // listItem.to)` predicate as ListMark — focus-gated by Slice F.
      if (name === 'TaskMarker') {
        const parent = node.node.parent;
        // TaskMarker's parent is the `Task` block; the enclosing ListItem
        // is one level above. Reveal range is the LISTITEM so cursor on
        // any source line of the item reveals the checkbox-as-text (the
        // item itself may span multiple lines via wrap or nested content).
        const listItem = parent !== null ? parent.parent : null;
        const revealFrom = listItem !== null ? listItem.from : node.from;
        const revealTo = listItem !== null ? listItem.to : node.to;
        const cursorInside = intersects(revealFrom, revealTo);
        if (cursorInside) {
          // Same line as cursor (or wrapping in a multi-line item) —
          // show raw `[ ]`/`[x]` source via the visible-syntax mark so
          // the user can keyboard-toggle by editing the character.
          items.push({
            kind: 'mark',
            from: node.from,
            to: node.to,
            deco: visibleSyntaxMark,
          });
          return;
        }
        // Off-line: replace with the checkbox widget. Read the marker
        // text now (build-time) so the widget's initial render matches
        // the doc; the click-handler re-reads on dispatch in case the
        // doc shifted between rebuild and click.
        const markerText = state.sliceDoc(node.from, node.to);
        const checked = markerText === '[x]' || markerText === '[X]';
        items.push({
          kind: 'replace',
          from: node.from,
          to: node.to,
          deco: Decoration.replace({
            widget: new TaskCheckboxWidget(checked, node.from, node.to),
          }),
        });
        return false;
      }

      // -- ListItem line ---------------------------------------------
      // Bullet / ordered list line — emit a line deco per LINE of the
      // ListItem (a single item can wrap onto multiple display lines
      // via soft wrap, but lezer's ListItem.from..to spans EXACTLY the
      // source lines of that item including any nested list). Depth
      // comes from the ancestor walk; CSS turns it into indent.
      if (name === 'ListItem') {
        const depth = listItemDepth(node.node);
        const deco = listItemDeco[depth] ?? listItemDeco[5];
        // Apply line deco to every source line in this ListItem that
        // isn't already covered by a nested ListItem (those will be
        // emitted by the deeper iterate-enter call with their own
        // depth). We can't easily know "covered by child" in the
        // enter callback, but emitting the same Decoration.line at
        // the same line.from is a no-op in the builder — the deeper
        // child's line deco will land first (parent enters first but
        // we sort items by depth-first source position so... no, that
        // still emits the shallower one first at the same offset).
        //
        // Cleanest approach: only emit the ListItem line deco for the
        // FIRST source line of the item (the one with the marker).
        // Deeper child ListItems handle their own first lines. Wrapped
        // content lines of THIS item still get the deco indirectly via
        // the depth class on the first line — CSS `padding-left` on
        // .cm-line only affects the directly-decorated line, so wrap
        // content of a multi-paragraph item won't get indent without
        // more work. For MVP that's fine; most kb-1 list items are
        // one line.
        const startLine = state.doc.lineAt(node.from);
        // Slice L: if this is a task-list item AND its TaskMarker is
        // checked, also emit a `cm-md-listitem-task-checked` line deco
        // so CSS can strike-through + dim the body text (the checkbox
        // widget's own DOM is excluded by selector specificity).
        if (listItemHasTask(node.node)) {
          // Emit the task-line class on every task-bearing item (checked
          // or unchecked) — sibling of -task-checked, gates task-line-
          // specific CSS like the on-cursor alignment column exclusion.
          items.push({
            kind: 'line',
            pos: startLine.from,
            deco: listItemTaskDeco,
          });
          // Walk to the Task child → TaskMarker grandchild to read the
          // marker text + capture the body range. Cheap — at most a
          // couple of sibling hops.
          let taskChild: SyntaxNode | null = node.node.firstChild;
          let markerText = '';
          let bodyFrom = -1;
          let bodyTo = -1;
          while (taskChild !== null) {
            if (taskChild.type.name === 'Task') {
              let mc: SyntaxNode | null = taskChild.firstChild;
              while (mc !== null) {
                if (mc.type.name === 'TaskMarker') {
                  markerText = state.sliceDoc(mc.from, mc.to);
                  bodyFrom = mc.to;
                  bodyTo = taskChild.to;
                  break;
                }
                mc = mc.nextSibling;
              }
              break;
            }
            taskChild = taskChild.nextSibling;
          }
          if (markerText === '[x]' || markerText === '[X]') {
            items.push({
              kind: 'line',
              pos: startLine.from,
              deco: listItemTaskCheckedDeco,
            });
            if (bodyFrom >= 0 && bodyTo > bodyFrom) {
              items.push({
                kind: 'mark',
                from: bodyFrom,
                to: bodyTo,
                deco: taskCheckedBodyMark,
              });
            }
          }
        }
        items.push({
          kind: 'line',
          pos: startLine.from,
          deco,
        });
        return;
      }

      // -- Blockquote lines ------------------------------------------
      // Blockquote.from..to spans every `> ` line in the run. Emit
      // one line deco per source line within. We don't return early
      // because the iterator still needs to descend into QuoteMark
      // children for cursor-reveal.
      if (name === 'Blockquote') {
        const fromLine = state.doc.lineAt(node.from).number;
        const toLine = state.doc.lineAt(node.to).number;
        for (let i = fromLine; i <= toLine; i++) {
          const line = state.doc.line(i);
          items.push({
            kind: 'line',
            pos: line.from,
            deco: blockquoteLineDeco,
          });
        }
        return;
      }

      // -- Horizontal rule (Slice R) ---------------------------------
      // `---` / `***` / `___` on its own line. Lezer-markdown emits a
      // single `HorizontalRule` node spanning the source chars with NO
      // syntax-mark children — `cx.addNode(Type.HorizontalRule, from)`
      // creates an atomic node. So we emit the line deco AND the
      // hide/reveal mark directly here (rather than letting the generic
      // syntax-mark branch catch a HeaderMark-style child, which doesn't
      // exist for HR).
      //
      // Bear-style render: when cursor is OFF the line, the `---` chars
      // collapse via cm-md-syntax.cm-hidden and the line renders as a
      // thin hairline rule via CSS (.cm-line.cm-md-hr:not(.cm-activeLine)
      // gets a top border). When cursor is ON the line (cm-activeLine),
      // chars reveal and the border drops, so the user sees raw `---`
      // for editing.
      if (name === 'HorizontalRule') {
        const line = state.doc.lineAt(node.from);
        items.push({
          kind: 'line',
          pos: line.from,
          deco: horizontalRuleLineDeco,
        });
        // Emit the source-char mark. Reveal range is the line itself —
        // cursor anywhere on the HR line reveals the `---`. Use the same
        // intersects() helper as everywhere else.
        const cursorInside = intersects(line.from, line.to);
        if (node.from < node.to) {
          items.push({
            kind: 'mark',
            from: node.from,
            to: node.to,
            deco: cursorInside ? visibleSyntaxMark : hiddenSyntaxMark,
          });
        }
        return false;
      }

      // -- Fenced code block -----------------------------------------
      // FencedCode.from..to spans the opening fence line through the
      // closing fence line (inclusive). Apply line deco to every line
      // in the block — opening fence, body, closing fence — so they
      // all get the monospace / background-tint look. Inner-language
      // syntax highlighting lights up via the nested parser already
      // configured on the markdown() call; we don't compute any inner
      // tokens here.
      //
      // Frame + focus-aware reveal (Slice T polish):
      //   - Opening + closing delimiter lines (` ```ts ` / ` ``` `)
      //     get `cm-md-code-fence-delim` which collapses them to zero
      //     height when the cursor is OFF-fence (CSS in
      //     PlaintextEditor.svelte). When the cursor is ON any line of
      //     the fence, the delim class no longer collapses (the CSS
      //     scopes the collapse to `:not(.cm-activeLine)` siblings —
      //     see the rule for why we don't toggle the class itself).
      //     We toggle classes instead via `cursorInside`: off-fence
      //     emits the *-delim class; on-fence emits the plain code-block
      //     line deco so the delimiter lines render full-size for
      //     editing.
      //   - First / middle / last content lines get top / middle /
      //     bottom classes that paint a border + radius so the run
      //     reads as one rounded box. Single-content-line fence uses
      //     the `*-only` class (rounds all four corners).
      //   - The opening fence's info-string (e.g. "ts", "py") becomes
      //     a `data-fence-lang` attribute on the first content line —
      //     CSS renders it as a corner label via `::after`. The label
      //     stays even when on-fence (informational; the on-fence raw
      //     ` ```ts ` is in a different visual register so they don't
      //     duplicate).
      if (name === 'FencedCode') {
        const fromLine = state.doc.lineAt(node.from).number;
        const toLine = state.doc.lineAt(node.to).number;
        const cursorOnFence = intersects(node.from, node.to);
        // Extract the info-string from the opening fence line — the text
        // after the opening ` ``` ` (or `~~~`) on the first line. Lezer
        // emits a `CodeInfo` child for this; fall back to slicing if
        // it's missing (no language tag → empty label, CSS hides it).
        let fenceLang = '';
        let codeInfoNode: SyntaxNode | null = node.node.firstChild;
        while (codeInfoNode !== null) {
          if (codeInfoNode.type.name === 'CodeInfo') {
            fenceLang = state.sliceDoc(codeInfoNode.from, codeInfoNode.to).trim();
            break;
          }
          codeInfoNode = codeInfoNode.nextSibling;
        }

        // A fence with no content lines (opening + closing on
        // consecutive lines, e.g. ` ``` `\n` ``` `) has toLine -
        // fromLine == 1. Both lines are delimiters; no content. We
        // still emit the delim class on both so they collapse off-
        // cursor; the box visually disappears. Cheap pathological
        // case — no border ever shows.
        const contentFromLine = fromLine + 1;
        const contentToLine = toLine - 1;
        const hasContent = contentFromLine <= contentToLine;
        const singleContent = hasContent && contentFromLine === contentToLine;

        // On-fence: drop the CARD chrome (border, background, padding,
        // language label) — same Shape-A pattern as links / wikilinks.
        // The user is editing raw markdown; showing the rendered card
        // while the delimiters are visible reads as double-rendering
        // (you see both the markdown source AND the preview).
        //
        // BUT — keep the text-layer typography. Content lines still get
        // `cm-md-code-block-text` so the body stays monospace at the
        // same font-size / line-height across the toggle. Otherwise the
        // body reflows into the editor's default serif face as soon as
        // the cursor enters, and the visual jump is jarring (text width
        // changes, vertical rhythm changes). Delimiter lines (the
        // ` ```ts ` and closing ` ``` ` rows) get NO decoration — they
        // reveal as plain prose at the editor's normal serif body face,
        // which is what the user expects to see when editing the raw
        // markdown delimiters.
        //
        // The inner-language syntax highlighter
        // (`syntaxHighlighting(defaultHighlightStyle)`) still colors TS
        // keywords / strings / numbers via `tok-*` spans, so the code
        // remains visually distinguishable from prose.
        if (cursorOnFence) {
          if (hasContent) {
            for (let i = contentFromLine; i <= contentToLine; i++) {
              const line = state.doc.line(i);
              items.push({
                kind: 'line',
                pos: line.from,
                deco: codeFenceTextOnlyDeco,
              });
            }
          }
          return;
        }

        // Off-fence: render the card. Delimiter lines collapse to zero
        // height; content lines paint a rounded bordered box with the
        // language label in the top-right corner.
        for (let i = fromLine; i <= toLine; i++) {
          const line = state.doc.line(i);
          let deco: Decoration;
          if (i === fromLine || i === toLine) {
            deco = codeFenceDelimDeco;
          } else if (singleContent) {
            deco = fenceLang.length > 0 ? fenceOnlyWithLang(fenceLang) : codeFenceOnlyDeco;
          } else if (i === contentFromLine) {
            deco = fenceLang.length > 0 ? fenceTopWithLang(fenceLang) : codeFenceTopDeco;
          } else if (i === contentToLine) {
            deco = codeFenceBottomDeco;
          } else {
            deco = codeFenceMiddleDeco;
          }
          items.push({
            kind: 'line',
            pos: line.from,
            deco,
          });
        }
        return;
      }

      // -- Inline emphasis / inline-code -----------------------------
      let rangeMark: Decoration | null = null;
      if (name === 'StrongEmphasis') rangeMark = boldMark;
      else if (name === 'Emphasis') rangeMark = italicMark;
      else if (name === 'Strikethrough') rangeMark = strikeMark;
      else if (name === 'InlineCode') rangeMark = codeMark;

      if (rangeMark !== null) {
        // Footnote-def cursor-reveal: when the cursor is on a FootnoteDef
        // line, drop the entire line to raw markdown. Skip emitting the
        // styling mark (`cm-md-bold` / `cm-md-em` / `cm-md-strike` /
        // `cm-md-code`) so the asterisks / backticks / tildes show as
        // literal source characters. The syntax-mark branch below
        // forces the surrounding `*` / `**` / `` ` `` chars visible
        // via the same `isInRawFootnoteDefLine` check.
        if (isInRawFootnoteDefLine(node.from)) {
          return;
        }
        items.push({
          kind: 'mark',
          from: node.from,
          to: node.to,
          deco: rangeMark,
        });
        return;
      }

      // -- Syntax characters -----------------------------------------
      // HeaderMark / EmphasisMark / StrikethroughMark / CodeMark /
      // ListMark / QuoteMark. Reveal when the cursor sits inside the
      // enclosing decorated range; hide otherwise.
      //
      // Reveal range definitions:
      //   HeaderMark            → enclosing heading line (parent ATXHeading*)
      //   EmphasisMark /
      //     StrikethroughMark /
      //     inline CodeMark     → enclosing inline node (parent StrongEmphasis /
      //                            Emphasis / Strikethrough / InlineCode)
      //   ListMark              → enclosing ListItem (so cursor on the
      //                            list-item line reveals the marker)
      //   QuoteMark             → enclosing Blockquote (cursor anywhere
      //                            in the multi-line quote reveals the
      //                            `>` on every line of that block — the
      //                            block-as-edit-context behaviour)
      //   FencedCode's CodeMark → enclosing FencedCode (cursor anywhere
      //                            in the fence reveals the ``` markers)
      const isSyntaxMark =
        name === 'HeaderMark' ||
        name === 'EmphasisMark' ||
        name === 'StrikethroughMark' ||
        name === 'CodeMark' ||
        name === 'ListMark' ||
        name === 'QuoteMark' ||
        // LinkMark / URL — only treat as syntax when their parent is a
        // Link node (the only context we render). Image's own LinkMark
        // / URL children are handled via the Image widget-replace path
        // above and we skip descent when the cursor is outside, so this
        // branch never sees them in that case; when the cursor is INSIDE
        // an Image (raw markdown mode), Image returns `undefined` to
        // descend, and the same hide/reveal logic applies cleanly
        // because parent.type.name === 'Image' falls through to the
        // generic `parent.from..parent.to` reveal range, which matches
        // Image's full source range — same behaviour we want for Link.
        (name === 'LinkMark' &&
          node.node.parent !== null &&
          (node.node.parent.type.name === 'Link' || node.node.parent.type.name === 'Image')) ||
        (name === 'URL' &&
          node.node.parent !== null &&
          (node.node.parent.type.name === 'Link' || node.node.parent.type.name === 'Image'));
      if (isSyntaxMark) {
        const parent = node.node.parent;
        if (parent === null) return;
        // ListMark (Slice L redesign):
        //   - Task and bullet items keep the old item-wide reveal:
        //     cursor inside the enclosing ListItem shows raw source.
        //   - Ordered items are stricter: body editing still shows the
        //     computed number, and only a cursor on the `1.` source mark
        //     reveals it. That keeps stale source numbers from visually
        //     perturbing the active ordered-list item.
        //   - Off-cursor:
        //       * task-bearing ListItem (has a `Task` child) → suppress
        //         the bullet entirely (the checkbox is the leading
        //         affordance; emitting any bullet here is redundant).
        //       * BulletList item → replace with a `BulletGlyphWidget`
        //         (○ / ▷ / ● / ▶ cycling by depth).
        //       * OrderedList item → replace with an `OrderedNumberWidget`
        //         showing the auto-numbered display value (start +
        //         offset within the OrderedList).
        // Reversal of Slice Q's "always visible" behaviour: presentation
        // now switches between raw source (on-cursor) and a typographic
        // glyph widget (off-cursor), same pattern as HorizontalRule.
        if (name === 'ListMark') {
          // ListMark's parent is the ListItem.
          if (parent.type.name !== 'ListItem') {
            // Defensive — shouldn't happen per the grammar. Fall back to
            // the generic cursor-reveal path below.
          } else {
            const listItem = parent;
            // Off-cursor: pick the widget for this ListItem's flavour.
            if (listItemHasTask(listItem)) {
              const cursorInside = intersects(listItem.from, listItem.to);
              if (cursorInside) {
                pushVisibleMark(node.from, node.to);
                return;
              }
              // Task-bearing item — suppress the bullet entirely. Hide
              // via the cm-hidden syntax mark so the source range stays
              // selectable but renders as zero-width. The checkbox
              // widget (emitted from the TaskMarker branch) is the
              // leading affordance; a bullet here is redundant + ugly.
              items.push({
                kind: 'mark',
                from: node.from,
                to: node.to,
                deco: hiddenSyntaxMark,
              });
              return;
            }
            if (listItemIsOrdered(listItem)) {
              const cursorInsideMark = intersects(node.from, node.to);
              if (cursorInsideMark) {
                pushVisibleMark(node.from, node.to);
                return;
              }
              const display = orderedNumbers.get(listItem.from);
              if (display !== undefined) {
                items.push({
                  kind: 'replace',
                  from: node.from,
                  to: node.to,
                  deco: Decoration.replace({
                    widget: new OrderedNumberWidget(display),
                  }),
                });
                return;
              }
              // No precomputed number (shouldn't happen) → fall through
              // to the visible mark so the user still sees the source.
              items.push({
                kind: 'mark',
                from: node.from,
                to: node.to,
                deco: visibleSyntaxMark,
              });
              return;
            }
            // Bullet list item — emit the shape-glyph widget.
            const cursorInside = intersects(listItem.from, listItem.to);
            if (cursorInside) {
              pushVisibleMark(node.from, node.to);
              return;
            }
            const depth = listItemDepth(listItem);
            items.push({
              kind: 'replace',
              from: node.from,
              to: node.to,
              deco: Decoration.replace({
                widget: new BulletGlyphWidget(depth),
              }),
            });
            return;
          }
        }
        let revealFrom: number;
        let revealTo: number;
        // Mention-link override: per-Link reveal range with the same
        // inclusion rule as the chip-paint gate above (selTo INSIDE iff
        // selTo >= linkFrom && selTo < linkTo). Computed up-front so
        // the standard `pname === 'Link'` branch keeps line-based reveal
        // for non-mention URL links.
        let mentionLinkOverride: boolean | null = null;
        const pname = parent.type.name;
        if (pname.startsWith('ATXHeading')) {
          const line = state.doc.lineAt(parent.from);
          revealFrom = line.from;
          revealTo = line.to;
        } else if (pname === 'ListItem') {
          revealFrom = parent.from;
          revealTo = parent.to;
        } else if (pname === 'Blockquote') {
          revealFrom = parent.from;
          revealTo = parent.to;
        } else if (pname === 'FencedCode') {
          revealFrom = parent.from;
          revealTo = parent.to;
        } else if (pname === 'Link') {
          // Per-Link reveal for mentions, line-based for URL links.
          // URL links keep line-based to preserve the documented click-
          // cancellation workaround in plaintext-link-affordance; mention
          // chips don't navigate so the workaround doesn't apply, and
          // per-Link reveal matches Yoh's expectation that clicking a
          // chip reveals only that one's source.
          if (extractMentionEmailFromLink(parent, state) !== null) {
            revealFrom = parent.from;
            revealTo = parent.to;
            mentionLinkOverride = focused && selTo >= parent.from && selTo < parent.to;
          } else {
            const line = state.doc.lineAt(parent.from);
            revealFrom = line.from;
            revealTo = line.to;
          }
        } else {
          revealFrom = parent.from;
          revealTo = parent.to;
        }
        // Footnote-def cursor-reveal override: when the cursor is on a
        // FootnoteDef line, force the syntax chars on that line visible
        // regardless of their enclosing inline node. Mirrors the
        // FencedCode `cursorInside` shape — once the cursor enters the
        // line, the entire line drops to raw markdown so `**bold**` and
        // `*italic*` show their asterisks, ``` `code` ``` shows backticks,
        // `~~strike~~` shows tildes, etc. Computed AFTER the parent-based
        // reveal so it can only widen the reveal, never narrow it.
        const inRawFootnoteDef = isInRawFootnoteDefLine(node.from);
        const cursorInside =
          inRawFootnoteDef || (mentionLinkOverride ?? intersects(revealFrom, revealTo));
        // Heading `# `-fix: lezer-markdown's HeaderMark covers only the
        // `#` run, not the trailing space between `#` and the heading
        // text. Without extending the hide range, the space stays
        // visible and the heading reads as indented by one character.
        // Extend `to` by 1 when the next char is a space AND we're
        // inside an ATX heading parent. The hidden-mark variant will
        // collapse the space along with the `#`; the visible-mark
        // variant keeps both visible so the user can edit naturally.
        const markFrom = node.from;
        let markTo = node.to;
        if (
          name === 'HeaderMark' &&
          pname.startsWith('ATXHeading') &&
          markTo < state.doc.length &&
          state.doc.sliceString(markTo, markTo + 1) === ' '
        ) {
          markTo += 1;
        }
        items.push({
          kind: 'mark',
          from: markFrom,
          to: markTo,
          deco: cursorInside ? visibleSyntaxMark : hiddenSyntaxMark,
        });
        return;
      }
    },
  });

  // Sort: by position ascending. At equal positions, `Decoration.line`
  // (startSide -200) sorts before `Decoration.mark` (startSide 5e8).
  // The lezer iterator already yields parent-before-child / depth-first
  // in source order, so for line decos at the same offset we want the
  // DEEPEST (most specific) one to land last — but RangeSetBuilder
  // dedupes by class via the Decoration reference, and adding the same
  // line decoration twice at the same offset is fine (no DOM dup).
  // For different line decos at the same offset (e.g. a ListItem deco
  // and an inner blockquote's first line deco), CM6 stacks the classes
  // on the same `.cm-line` element. Sort stably; order at equal `from`
  // doesn't materially affect the rendered class set.
  items.sort((a, b) => {
    const ap = a.kind === 'line' ? a.pos : a.from;
    const bp = b.kind === 'line' ? b.pos : b.from;
    if (ap !== bp) return ap - bp;
    // At equal positions: line < replace < mark. Decoration.line uses
    // startSide -200, Decoration.replace uses startSide -1 (block) or
    // -3e8 (inline replace varies by spec; CM6 normalizes), and
    // Decoration.mark uses startSide 5e8. RangeSetBuilder asserts
    // monotonic startSide at equal positions; we emit in the canonical
    // order so the assertion holds without sorting on the exact side
    // number ourselves.
    const order = (k: typeof a.kind): number => (k === 'line' ? 0 : k === 'replace' ? 1 : 2);
    return order(a.kind) - order(b.kind);
  });

  const builder = new RangeSetBuilder<Decoration>();
  for (const item of items) {
    if (item.kind === 'line') {
      builder.add(item.pos, item.pos, item.deco);
    } else {
      // CM6 mark / replace decorations require from < to (zero-width
      // marks would be widgets). The lezer parser only emits non-empty
      // mark nodes for the shapes we listen to, but guard defensively
      // to avoid throwing on a malformed parse.
      if (item.from < item.to) {
        builder.add(item.from, item.to, item.deco);
      }
    }
  }
  return builder.finish();
}

/* ---------------------------------------------------------------- *
 * Focus bridge (Slice F)                                            *
 *                                                                    *
 * Focus lives on the EditorView (`view.hasFocus`), not the state.    *
 * Our decorations live in a StateField (block widgets require it —  *
 * see the StateField comment below). To get focus into state we use *
 * a tiny ViewPlugin that listens for `update.focusChanged` and       *
 * dispatches a `focusEffect` carrying the new `hasFocus` boolean.    *
 * A sibling `editorFocusField` stores the boolean for the decoration *
 * field to read.                                                     *
 *                                                                    *
 * Why a separate field instead of carrying focus on the decoration   *
 * field's value: keeps the focus state observable from `tr.state.    *
 * field(editorFocusField)` in any other extension that might want    *
 * it, and keeps the decoration field's value type a plain            *
 * `DecorationSet` (so `EditorView.decorations.from(f)` keeps         *
 * working unchanged). Two narrow fields beats one widened tuple.     *
 * ---------------------------------------------------------------- */

const focusEffect = StateEffect.define<boolean>();

/**
 * Effect carrying a "the livePaths snapshot the editor was constructed
 * with has changed; rebuild wikilink resolution" signal. Dispatched by
 * the host whenever its `livePaths` prop reference shifts (vault tree
 * update, vault switch). Mirrors `livePathsChangedMeta` in the Crepe-
 * side wikilink plugin — same trigger, different transport (CM6 effects
 * vs ProseMirror tx meta).
 *
 * Carries `null` as a payload (CM6's `StateEffect<T>` requires a typed
 * payload, and `null` is the cheapest sentinel — the bare existence of
 * the effect is the signal, not its value).
 */
export const livePathsChangedEffect = StateEffect.define();

/**
 * Sibling of `livePathsChangedEffect` for the org directory — dispatched
 * when the host's `orgPeople` reference shifts (org switch, member
 * added/removed). Triggers a decoration rebuild so mention chips re-
 * resolve from stale to fresh (or vice versa) without needing a doc
 * edit. Mirrors `orgPeopleChangedMeta` in the Crepe-side
 * mention-decoration plugin — same trigger, different transport.
 */
export const mentionDirectoryChangedEffect = StateEffect.define();

/**
 * Viewport-driven rebuild signal. The decoration StateField is blind to
 * pure viewport-scroll transactions and to lezer parser-extension
 * transactions — without a kick, the DecorationSet built at mount only
 * covers the initially-parsed prefix of the doc. For long notes that
 * means the bottom half renders raw markdown until the user touches the
 * editor.
 *
 * `viewportRebuildTrigger` (below) watches view-layer signals
 * (`viewportChanged`, syntax-tree growth) and dispatches this effect.
 * The StateField recognizes it the same way it recognizes the other
 * three custom effects and rebuilds the DecorationSet against the now-
 * larger parsed region.
 *
 * Payload is `null` — the effect itself is the signal.
 */
const viewportRebuildEffect = StateEffect.define();

const editorFocusField = StateField.define<boolean>({
  // Initial focus assumption: editor mounts unfocused. The browser
  // will fire a focus event (and our bridge will dispatch the effect)
  // if/when the user clicks in or programmatic focus lands. With this
  // default the editor renders as Bear-style preview on first paint —
  // no `#`/`**`/`_` visible — which is exactly the "calm at rest"
  // behaviour Slice F is after.
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(focusEffect)) return effect.value;
    }
    return value;
  },
});

const focusBridge = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      // Reconcile the field's initial-false default against whatever
      // focus state the view actually has at mount. In practice the
      // editor is unfocused at construction so both sides agree, but
      // if a parent component programmatically focuses before the
      // first update cycle this avoids a one-frame stale render.
      const initial = view.hasFocus;
      if (initial !== view.state.field(editorFocusField, false)) {
        // Dispatch in a microtask — dispatching synchronously inside a
        // ViewPlugin constructor is rejected by CM6 (it warns about
        // re-entrant transactions). queueMicrotask defers past the
        // current update cycle.
        queueMicrotask(() => {
          if (view.hasFocus === initial) {
            view.dispatch({ effects: focusEffect.of(initial) });
          }
        });
      }
    }
    update(update: ViewUpdate) {
      if (update.focusChanged) {
        // Defer the dispatch — CM6 rejects re-entrant transactions
        // inside a ViewPlugin's `update`. queueMicrotask runs after the
        // current update cycle settles. Read `view.hasFocus` again in
        // the microtask in case focus has bounced (rare but cheap to
        // guard against — avoids dispatching a stale value).
        const view = update.view;
        const target = view.hasFocus;
        queueMicrotask(() => {
          if (view.hasFocus === target) {
            view.dispatch({ effects: focusEffect.of(target) });
          }
        });
      }
    }
  },
);

/* ---------------------------------------------------------------- *
 * Viewport rebuild trigger (long-note tail-paint fix)               *
 *                                                                    *
 * The decoration StateField only rebuilds on `docChanged`, selection *
 * change, or one of three custom effects. It does NOT see plain      *
 * viewport-scroll transactions, and it does NOT see the lezer parser-*
 * extension transactions that fire as CM6's incremental parser walks *
 * past its initial parse-time budget into the newly-visible region.  *
 *                                                                    *
 * Result for long notes: the DecorationSet built at mount only       *
 * covers the prefix the parser had time to walk before mount-paint;  *
 * anything past that paints raw markdown until the user touches the  *
 * editor.                                                             *
 *                                                                    *
 * This ViewPlugin watches view-layer signals — `viewportChanged`     *
 * (the user scrolled, or the editor was just resized into a viewport *
 * that exposes new content) and syntax-tree growth (the incremental  *
 * parser walked further on its own) — and dispatches a synthetic     *
 * effect the StateField listens for.                                  *
 *                                                                    *
 * `forceParsing(view, viewport.to, 50)` gives the parser up to 50ms  *
 * to extend the tree to cover the new visible range before we sample *
 * `lastTreeLen` — so the "tree grew" baseline reflects post-force    *
 * state, otherwise the next update would re-fire on the parser's     *
 * own catch-up.                                                       *
 * ---------------------------------------------------------------- */

const viewportRebuildTrigger = ViewPlugin.define((view) => {
  let lastTreeLen = syntaxTree(view.state).length;
  return {
    update(u: ViewUpdate) {
      const treeLen = syntaxTree(u.state).length;
      const treeGrew = treeLen > lastTreeLen;
      if (u.viewportChanged || treeGrew) {
        // Bump the baseline synchronously so a follow-up `update`
        // landing before the microtask doesn't re-schedule from the
        // same parser advance. `forceParsing` inside the microtask may
        // extend the tree further; we re-sync `lastTreeLen` there.
        lastTreeLen = treeLen;
        // Defer the entire side-effect chain to a microtask. Both
        // `forceParsing` (which dispatches its own transactions when the
        // parser advances) and our own dispatch hit CM6's re-entrant-
        // update prohibition if called from inside `ViewPlugin.update`
        // ("Calls to EditorView.update are not allowed while an update
        // is in progress"). Same shape as `focusBridge` above.
        const view = u.view;
        queueMicrotask(() => {
          forceParsing(view, view.viewport.to, 50);
          lastTreeLen = syntaxTree(view.state).length;
          view.dispatch({ effects: viewportRebuildEffect.of(null) });
        });
      }
    },
  };
});

/* ---------------------------------------------------------------- *
 * StateField                                                        *
 *                                                                    *
 * Block decorations (Table widget's `block: true` replace) MUST come *
 * from a StateField — CM6 throws `RangeError: Block decorations may  *
 * not be specified via plugins` when a ViewPlugin's `decorations`    *
 * facet contributes a block-shaped deco. The simplest fix is to host *
 * the entire decoration set in a StateField; mark + line decorations *
 * are happy from either side, and unifying avoids the bookkeeping of *
 * a split provider.                                                   *
 *                                                                    *
 * Update triggers: doc change (tree contents shifted), selection     *
 * change (cursor-reveal may have flipped), or a `focusEffect` in the *
 * transaction (focus-gate flipped). All three are reflected in the   *
 * `Transaction` object we receive in `update`.                       *
 * ---------------------------------------------------------------- */

function markdownDecorationField(options: {
  attachmentSrc?: (path: string) => string;
  getLivePaths?: () => readonly LivePath[];
  getOrgPeople?: () => readonly OrgPerson[];
  onWikilinkClick?: (encodedTarget: string, event: MouseEvent) => void;
}): StateField<DecorationSet> {
  // `getLivePaths` / `getOrgPeople` are getters (not snapshots) so each
  // rebuild reads the latest reactive value the host passes down. Same
  // pattern as the Crepe-side wikilink + mention plugins.
  const getLivePaths = options.getLivePaths ?? (() => [] as readonly LivePath[]);
  const getOrgPeople = options.getOrgPeople ?? (() => [] as readonly OrgPerson[]);
  return StateField.define<DecorationSet>({
    create(state) {
      const sel = state.selection.main;
      const focused = state.field(editorFocusField, false);
      return buildMarkdownDecorations(
        state,
        { from: sel.from, to: sel.to },
        {
          attachmentSrc: options.attachmentSrc,
          focused,
          livePaths: getLivePaths(),
          orgPeople: getOrgPeople(),
          onWikilinkClick: options.onWikilinkClick,
        },
      );
    },
    update(value, tr: Transaction) {
      // Selection change OR doc change OR a focus-effect OR a
      // livePaths-changed effect OR a mention-directory-changed effect
      // triggers a rebuild. Other transactions (effects-only, viewport
      // scroll, …) keep the existing decoration set — but the set's
      // positions still need to be mapped through `tr.changes` so they
      // line up with the post-transaction document. CM6's RangeSet has
      // a `.map(changes)` for exactly this purpose; for doc-changed
      // transactions we rebuild entirely so mapping is a no-op there.
      let focusFlipped = false;
      let livePathsFlipped = false;
      let mentionDirectoryFlipped = false;
      let viewportFlipped = false;
      for (const effect of tr.effects) {
        if (effect.is(focusEffect)) focusFlipped = true;
        else if (effect.is(livePathsChangedEffect)) livePathsFlipped = true;
        else if (effect.is(mentionDirectoryChangedEffect)) {
          mentionDirectoryFlipped = true;
        } else if (effect.is(viewportRebuildEffect)) viewportFlipped = true;
      }
      if (
        !tr.docChanged &&
        !tr.selection &&
        !focusFlipped &&
        !livePathsFlipped &&
        !mentionDirectoryFlipped &&
        !viewportFlipped
      ) {
        return value;
      }
      const sel = tr.state.selection.main;
      const focused = tr.state.field(editorFocusField, false);
      return buildMarkdownDecorations(
        tr.state,
        { from: sel.from, to: sel.to },
        {
          attachmentSrc: options.attachmentSrc,
          focused,
          livePaths: getLivePaths(),
          orgPeople: getOrgPeople(),
          onWikilinkClick: options.onWikilinkClick,
        },
      );
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/**
 * The composed extension: language support + decoration ViewPlugin +
 * default highlight style (so the nested inner-language tokens inside
 * fenced code blocks actually paint).
 *
 * Mount via `extensions: [..., plaintextDecorations(), ...]` in the
 * `EditorState.create({...})` call. Safe to compose alongside the
 * existing peer-cursor consumer — they contribute to the same
 * `EditorView.decorations` facet and CM6 layers them naturally
 * (mark decorations stack via DOM nesting; widget + mark from the
 * peer-cursor layer remain independent of these line/mark decos).
 */
/**
 * Syntax-highlight style for fenced code blocks. Replaces CodeMirror's
 * `defaultHighlightStyle` (which uses light-mode-tuned hex literals like
 * `#708` and `#219` that disappear against the dark-mode fence bg) with
 * a small mapping that reads `--rd-syntax-*` CSS variables — those flip
 * per `[data-rd-mode]` in tokens.css, so the same style hits good
 * contrast on both backgrounds.
 *
 * Tag groups chosen for the curated set of fence languages
 * (TypeScript / Python / JSON / HTML / CSS) — covers keywords (control,
 * modifier, module, definition), strings + regex, numbers/bools/atoms,
 * function calls, type names, comments (italic), property access, and
 * operators (subtle). Punctuation deliberately left untinted.
 */
const kbCodeHighlightStyle = HighlightStyle.define([
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.definitionKeyword,
      t.modifier,
      t.moduleKeyword,
      t.operatorKeyword,
      t.self,
    ],
    color: 'var(--rd-syntax-keyword)',
  },
  {
    tag: [t.string, t.special(t.string), t.regexp],
    color: 'var(--rd-syntax-string)',
  },
  { tag: t.escape, color: 'var(--rd-syntax-number)' },
  {
    tag: [t.number, t.bool, t.null, t.atom],
    color: 'var(--rd-syntax-number)',
  },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    color: 'var(--rd-syntax-function)',
  },
  {
    tag: [t.typeName, t.standard(t.typeName), t.className, t.namespace],
    color: 'var(--rd-syntax-type)',
  },
  { tag: t.propertyName, color: 'var(--rd-syntax-property)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta],
    color: 'var(--rd-syntax-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [t.operator, t.compareOperator, t.logicOperator, t.arithmeticOperator],
    color: 'var(--rd-syntax-operator)',
  },
]);

export function plaintextDecorations(
  options: {
    attachmentSrc?: (path: string) => string;
    /**
     * Getter for the vault's live-path snapshot. Passed as a getter (not
     * a static snapshot) so each decoration rebuild reads the latest
     * reactive value the host owns — same shape as the Crepe-side
     * wikilink plugin in `wikilink-decoration-plugin.ts`. Omit when
     * there's no resolution context (Storybook, no-vault tests); every
     * wikilink will paint as broken, which matches reality.
     */
    getLivePaths?: () => readonly LivePath[];
    /**
     * Getter for the org's people directory — used to resolve mention
     * chips (`[Name](mention:email)`) to the matching `OrgPerson`. Same
     * getter pattern as `getLivePaths`: each rebuild reads the latest
     * reactive value the host owns. Omit when there's no org context;
     * every mention will paint with the stale modifier, which is the
     * honest signal in a no-vault context.
     */
    getOrgPeople?: () => readonly OrgPerson[];
    onWikilinkClick?: (encodedTarget: string, event: MouseEvent) => void;
  } = {},
): Extension {
  const opts = {
    attachmentSrc: options.attachmentSrc,
    getLivePaths: options.getLivePaths,
    getOrgPeople: options.getOrgPeople,
    onWikilinkClick: options.onWikilinkClick,
  };
  return [
    // Markdown language + GFM strikethrough + GFM table + GFM task-list
    // + GFM autolink + wikilink (custom) + nested code-fence languages.
    // `codeLanguages` returns a LanguageDescription per fence info string —
    // the markdown parser then mixes in that language's parser for the
    // fence body, so `defaultHighlightStyle` applied below picks up the
    // inner tokens (TS keywords, Python `def`, JSON strings, …).
    //
    // Autolink ordering note: wikilink's inline parser registers
    // `before: 'Link'` so `[[target]]` is claimed before the standard
    // Link parser. GFM Autolink registers its own `Autolink` inline
    // parser independently and emits bare `URL` nodes for `http://…`,
    // `https://…`, `www.…`, `mailto:…`, `xmpp:…`, and bare emails. It
    // does not interact with the `[…](…)` Link path and so coexists
    // with wikilink without conflict. The autolink decoration branch
    // recognizes top-level `URL` nodes (those whose parent is NOT a
    // Link or Image — Link/Image already own their URL children via
    // the existing cursor-reveal pattern).
    markdown({
      extensions: [Strikethrough, Table, TaskList, Autolink, wikilinkExtension, footnoteExtension],
      // Return the inner Language synchronously per fence info string.
      // `lang-markdown` accepts either a Language or a LanguageDescription;
      // since we eagerly construct LanguageSupport for the curated set
      // at module-load (cheap — five lezer grammars) the synchronous
      // path is simpler than the async LanguageDescription dance.
      codeLanguages: lookupFenceLanguage,
      // No keymap injection — the plaintext editor owns its own
      // keymap and we don't want lang-markdown's enter-handling
      // (list continuation, etc.) firing on .txt notes.
      addKeymap: false,
    }),
    // Without this, the nested fence languages parse but emit no
    // visible token classes. Default highlight style maps the lezer
    // highlight tags (keyword, string, number, …) to CSS variables on
    // CM6's theme classes (`.tok-keyword`, `.tok-string`, …) which
    // the default theme paints.
    syntaxHighlighting(kbCodeHighlightStyle, { fallback: true }),
    // StateField host (instead of a ViewPlugin) — block decorations
    // (Table widget's `block: true` replace) require this. See
    // `markdownDecorationField` for the rebuild policy.
    //
    // No `EditorView.atomicRanges` opt-in here. Earlier experiments
    // exposed our `DecorationSet` as atomic, intending to make arrow-
    // key motion jump over Table/Image widgets. Empirically that path
    // triggered CM6's internal TilePointer.advance to walk off the
    // parent stack (`Cannot destructure property 'tile' of
    // 'parents.pop()'`) — most likely an interaction with the
    // `Decoration.line` ranges this same field emits at coincident
    // offsets. The widget UX is fine without it: clicks reposition
    // the caret into the source range (TableWidget / ImageWidget
    // both set `ignoreEvent() = false`), which triggers cursor-reveal
    // and shows the raw markdown. Arrow keys step through the source
    // range character-by-character once revealed.
    //
    // Focus-bridge order: register `editorFocusField` (the storage)
    // before `markdownDecorationField` (the reader) so the field is
    // available when the decoration field's `create` callback runs.
    // The `focusBridge` ViewPlugin can sit anywhere — it only fires
    // effects, never reads sibling fields. Order between StateFields
    // matters in CM6; order among ViewPlugins doesn't for this case.
    editorFocusField,
    focusBridge,
    markdownDecorationField(opts),
    // Viewport-driven rebuild trigger — observes scroll / resize and
    // lezer parser-extension growth, dispatches `viewportRebuildEffect`
    // so the StateField above rebuilds against the newly-parsed tail.
    // Without this the bottom half of long notes paints raw markdown
    // until the user touches the editor. Order doesn't matter (it only
    // dispatches effects, never reads sibling fields).
    viewportRebuildTrigger,
  ];
}
