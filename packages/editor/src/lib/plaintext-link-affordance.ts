/**
 * Link + wikilink click and hover affordances for the plaintext editor
 * (Slice 6 of the typography arc).
 *
 * Two related extensions live here:
 *
 *   - `plaintextLinkClickHandler(onWikilinkClick)` — a
 *     `EditorView.domEventHandlers({ click })` that listens for clicks
 *     on `.cm-md-link-label` (inline `[label](url)` link) and
 *     `.cm-md-wikilink-label` (`[[target]]` / `[[target|alias]]`,
 *     resolved or broken). URL links open in a new tab via
 *     `window.open`; wikilinks invoke the host-supplied callback with
 *     the same URL-encoded target the Markdown editor passes (so
 *     `DocumentCanvas.handleWikilinkClick` doesn't care which surface
 *     fired the click).
 *
 *   - `plaintextLinkHover(getLivePaths)` — a `hoverTooltip` that
 *     surfaces the resolved path (or "Note not found") for a wikilink
 *     when the pointer rests over it. URL links don't get a preview
 *     in v1: the visible text already conveys destination, and the
 *     interaction adds noise without value.
 *
 * Why a sibling file and not an addition to plaintext-decorations.ts:
 * decorations are about *painting* nodes; clicks and hovers are about
 * *interpreting* nodes. The syntax-tree walk to find the enclosing
 * Link / Wikilink at a position is symmetrical to the decoration
 * walk but the trigger (DOM event vs document/selection change) and
 * output (callback / tooltip vs `Decoration`) are different. Keeping
 * them split makes each easier to reason about; both consume the
 * lezer-markdown tree the decoration pipeline already mounts.
 *
 * Contract parity with MarkdownEditor.svelte's `handleHostClick`:
 *
 *   1. Wikilink click fires `onWikilinkClick(encodeURIComponent(target), event)`.
 *      The encoding mirrors `wikilink-decoration-plugin.ts` and is
 *      decoded by `DocumentCanvas.handleWikilinkClick`. Resolved and
 *      broken wikilinks both fire — `handleWikilinkClick` decides what
 *      to navigate to (resolved path / fallback `<target>.md`).
 *
 *   2. URL link click opens in a new tab with `noopener,noreferrer`
 *      and prevents default. Mod-click (cmd/ctrl) follows the same
 *      "new tab" path on the markdown side (the browser's anchor
 *      default), so behavior is consistent across both editors.
 *
 *   3. Mid-link caret editing is preserved: the click handler only
 *      fires when the click target is the LABEL element (the visible
 *      tinted span). Clicks on the syntax characters (`[[`, `]]`,
 *      `[`, `]`, `(...)`) — which are normally hidden but reveal when
 *      cursor is inside — land as normal text-position clicks because
 *      they don't carry the label class.
 *
 * Hover tooltip is plaintext-only in this slice; the Markdown editor
 * has no equivalent affordance today. Flag noted for parity work
 * later — the resolver chain is the same, so lifting this to a
 * shared utility once Markdown grows a hover surface is mechanical.
 */

import { EditorView, hoverTooltip, type Tooltip } from '@codemirror/view';
import {
  EditorSelection,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import {
  parseMentionUrl,
  parseWikilinkInner,
  resolveLinkTarget,
  type LivePath,
} from './markdown-core';

/**
 * Walk up the syntax tree from `pos` to find the nearest enclosing
 * `Link`, `Wikilink`, or bare `URL` (autolink) node. Returns `null`
 * when none is found (the click landed in body text or in a different
 * decorated range).
 *
 * A bare `URL` node — one whose parent is NOT `Link` or `Image` — is
 * emitted by lezer-markdown's `Autolink` extension for `http(s)://`,
 * `www.`, `mailto:`, `xmpp:`, and bare-email matches. The decoration
 * pipeline paints these as `.cm-md-link-label` so they share the click
 * affordance with inline `[label](url)` links.
 *
 * `side: -1` biases the resolver to prefer the node ending at `pos`
 * over one starting there, which matters for clicks near the closing
 * bracket. Both clicks happen inside the label span anyway (CM6's
 * `posAtDOM` lands inside the textNode the label wraps), so this is
 * defensive rather than load-bearing.
 */
export function resolveLinkAncestor(
  view: EditorView,
  pos: number,
): SyntaxNode | null {
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node !== null) {
    const name = node.type.name;
    if (name === 'Link' || name === 'Wikilink') return node;
    if (name === 'URL') {
      // Distinguish autolink from Link/Image's own URL child — only
      // the autolink case (top-level URL) is followed by the click
      // handler. Link/Image URL clicks are handled via the Link
      // branch reached by continuing to walk up the parent chain.
      const pname = node.parent?.type.name;
      if (pname !== 'Link' && pname !== 'Image') return node;
    }
    node = node.parent;
  }
  return null;
}

/**
 * Normalize a bare-URL match to an openable href.
 *
 *   - `http://…` / `https://…` / `mailto:…` / `xmpp:…` pass through.
 *   - `www.…` gets an `https://` prefix (GFM Autolink's `www.` branch
 *     is shorthand for an https URL).
 *   - A bare email (no scheme, contains `@`) gets a `mailto:` prefix.
 *
 * The Autolink parser's regex (`autolinkRE` in @lezer/markdown) already
 * guarantees the input matches one of these shapes, so we don't need
 * to defensively reject other inputs — anything we receive here came
 * from a URL node the parser produced.
 */
function normalizeAutolinkHref(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('xmpp:')
  ) {
    return trimmed;
  }
  if (trimmed.startsWith('www.')) {
    return `https://${trimmed}`;
  }
  // Bare email shape (Autolink's email branch).
  if (trimmed.includes('@')) {
    return `mailto:${trimmed}`;
  }
  return trimmed;
}

/**
 * Walk up the syntax tree from `pos` to find the nearest enclosing
 * `FootnoteRef` node — used by the hover-tooltip + mousedown handlers
 * to surface the matching definition. Returns `null` when the position
 * isn't inside a footnote reference.
 */
function resolveFootnoteRefAncestor(
  view: EditorView,
  pos: number,
): SyntaxNode | null {
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node !== null) {
    if (node.type.name === 'FootnoteRef') return node;
    node = node.parent;
  }
  return null;
}

/**
 * Read the label (`id`) text out of a FootnoteRef / FootnoteDef node by
 * walking its `FootnoteLabel` child. Returns `null` if no label child
 * is present (defensive — should not happen with a well-formed parse).
 */
function extractFootnoteLabel(
  view: EditorView,
  footnoteNode: SyntaxNode,
): string | null {
  let child: SyntaxNode | null = footnoteNode.firstChild;
  while (child !== null) {
    if (child.type.name === 'FootnoteLabel') {
      const raw = view.state.sliceDoc(child.from, child.to);
      return raw.length > 0 ? raw : null;
    }
    child = child.nextSibling;
  }
  return null;
}

/**
 * Find the first `FootnoteDef` node in the doc whose `FootnoteLabel`
 * matches the given id. Returns `null` when no definition exists
 * (broken-ref case — the caller shows nothing on hover).
 *
 * We walk the syntax tree once per call. The doc is bounded in size
 * (typical kb-1 note is a few hundred lines), so the cost is fine for
 * an event-driven hover/click handler. Caching would be an
 * optimization we don't need today.
 */
function findFootnoteDef(
  view: EditorView,
  id: string,
): SyntaxNode | null {
  const tree = syntaxTree(view.state);
  let match: SyntaxNode | null = null;
  tree.iterate({
    enter: (n) => {
      if (match !== null) return false;
      if (n.type.name === 'FootnoteDef') {
        const label = extractFootnoteLabel(view, n.node);
        if (label === id) {
          match = n.node;
          return false;
        }
      }
      return undefined;
    },
  });
  return match;
}

/**
 * Slice out the body text of a FootnoteDef node (everything after
 * the `[^id]:` prefix), trimmed of leading whitespace. Returns the
 * empty string when there is no body or the def is malformed.
 */
function extractFootnoteDefBody(
  view: EditorView,
  defNode: SyntaxNode,
): string {
  // The FootnoteDef carries three structural children we don't want in
  // the body: `[^` open mark, label, `]:` close mark. Everything after
  // the close-mark's `to` is body text.
  let closeMarkEnd: number | null = null;
  let child: SyntaxNode | null = defNode.firstChild;
  let sawLabel = false;
  while (child !== null) {
    if (child.type.name === 'FootnoteLabel') {
      sawLabel = true;
    } else if (child.type.name === 'FootnoteDefMark' && sawLabel) {
      closeMarkEnd = child.to;
      break;
    }
    child = child.nextSibling;
  }
  if (closeMarkEnd === null) return '';
  return view.state.sliceDoc(closeMarkEnd, defNode.to).trimStart();
}

/**
 * Extract the `(url)` portion of a `Link` node by walking its `URL`
 * child. Returns `null` for malformed Link nodes (missing URL).
 *
 * Mirrors the URL-extraction in `parseImageNode` (same file as the
 * decoration pipeline) — the lezer-markdown tree emits a `URL` child
 * for the parenthesized destination of an inline link, optionally
 * wrapped in `<...>` for URLs containing spaces / parens.
 */
export function extractLinkUrl(
  state: EditorState,
  linkNode: SyntaxNode,
): string | null {
  let child: SyntaxNode | null = linkNode.firstChild;
  while (child !== null) {
    if (child.type.name === 'URL') {
      let raw = state.sliceDoc(child.from, child.to).trim();
      if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);
      return raw.length > 0 ? raw : null;
    }
    child = child.nextSibling;
  }
  return null;
}

/**
 * Extract the bare target of a `Wikilink` node by walking its
 * `WikilinkTarget` child and feeding it through `parseWikilinkInner`
 * (the canonical splitter for `target#heading|alias`). Mirrors the
 * decoration-pipeline's resolution path so the same input maps to
 * the same target.
 *
 * Returns `null` for empty / malformed wikilinks — callers should
 * suppress the click in that case (let CM6 handle the position
 * normally so the user can finish typing the wikilink).
 */
function extractWikilinkTarget(
  view: EditorView,
  wikilinkNode: SyntaxNode,
): string | null {
  let targetChild: SyntaxNode | null = null;
  let aliasChild: SyntaxNode | null = null;
  let child: SyntaxNode | null = wikilinkNode.firstChild;
  while (child !== null) {
    const cname = child.type.name;
    if (cname === 'WikilinkTarget') targetChild = child;
    else if (cname === 'WikilinkAlias') aliasChild = child;
    child = child.nextSibling;
  }
  if (targetChild === null) return null;
  const targetText = view.state.sliceDoc(targetChild.from, targetChild.to);
  const parts = parseWikilinkInner(
    targetText + (aliasChild !== null ? '|' : ''),
  );
  if (parts === null) return null;
  const trimmed = parts.target.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Click handler extension. Pass the host's `onWikilinkClick` callback
 * to receive wikilink clicks with the URL-encoded target (mirrors
 * MarkdownEditor's contract).
 *
 * URL links open in a new tab unconditionally — `window.open` with
 * `noopener,noreferrer` so the opened page can't reach back into the
 * editor's window context. Modifier keys are not special-cased: the
 * default is already "new tab", and the markdown editor doesn't
 * special-case Cmd-click either.
 */
export function plaintextLinkClickHandler(
  onWikilinkClick: ((encodedTarget: string, event: MouseEvent) => void) | null,
): Extension {
  // Shape A interaction: line-based reveal of links on the cursor's
  // line means a click that lands ON a label span triggers a chain —
  // mousedown moves the cursor to that line → decoration rebuild → the
  // label span is removed from the DOM → mouseup target is gone → the
  // browser cancels the `click` event entirely. So we cannot wait for
  // `click` to fire to follow the link.
  //
  // Fix: catch the link at MOUSEDOWN time (label is still in DOM,
  // affordance handler runs before CM6's selection update), and follow
  // immediately. We also return `true` to short-circuit CM6's own
  // mousedown handling so the cursor doesn't move to the link's line —
  // the user's intent was to navigate, not to edit.
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      // Only left-click follows links; modifier-less click. Mod-click
      // and right-click pass through to default text-selection behavior.
      if (event.button !== 0) return false;
      const target = event.target;
      if (!(target instanceof Element)) return false;

      // Footnote-reference click → scroll the matching definition into
      // view (and place the caret at the definition for a brief flash
      // via the editor's normal selection-painted highlight). v1 keeps
      // it simple: same-doc anchor; no panel, no navigation. Broken
      // refs (no matching def) just no-op — the broken styling already
      // signals the missing target.
      const footnoteRef = target.closest('.cm-md-footnote-ref');
      if (footnoteRef instanceof HTMLElement) {
        const refPos = view.posAtDOM(footnoteRef);
        const refNode = resolveFootnoteRefAncestor(view, refPos + 1);
        if (refNode === null) return false;
        const id = extractFootnoteLabel(view, refNode);
        if (id === null) return false;
        const defNode = findFootnoteDef(view, id);
        if (defNode === null) {
          // Broken ref — suppress the default click so the caret
          // doesn't jump to a meaningless position; the tinted broken
          // styling already conveys "no target".
          event.preventDefault();
          return true;
        }
        // Scroll the definition into view and place the caret at its
        // start so CM6's active-line highlight gives a quiet flash. The
        // user can then read / edit the definition in place.
        view.dispatch({
          selection: EditorSelection.single(defNode.from),
          effects: EditorView.scrollIntoView(defNode.from, { y: 'center' }),
        });
        event.preventDefault();
        return true;
      }

      const label = target.closest(
        '.cm-md-link-label, .cm-md-wikilink-label',
      );
      if (!(label instanceof HTMLElement)) return false;
      const pos = view.posAtDOM(label);
      const linkNode = resolveLinkAncestor(view, pos + 1);
      if (linkNode === null) return false;
      if (linkNode.type.name === 'Link') {
        const url = extractLinkUrl(view.state, linkNode);
        if (url === null) return false;
        // Mention chips (`[Name](mention:email)`) suppress the click
        // entirely — the chip is a typographic affordance, not a
        // navigation surface. Returning false (without preventDefault)
        // lets CM6's default click-to-position run, so the user's caret
        // lands inside the source range and the line's Shape A reveal
        // exposes the raw markdown for editing. Mirrors Crepe-side
        // behaviour where mention chips have no click handler.
        if (parseMentionUrl(url) !== null) return false;
        if (url.startsWith('wikilink:') && onWikilinkClick !== null) {
          // Defensive: legacy `[label](wikilink:target)` form delegates
          // to the wikilink path.
          onWikilinkClick(url.slice('wikilink:'.length), event);
        } else {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        event.preventDefault();
        return true;
      }
      if (linkNode.type.name === 'URL') {
        // Autolink (GFM): the URL node IS the source range. Slice
        // directly — no `<…>` wrapping for autolinks (lezer's autolink
        // regex doesn't match angle-bracket forms). Normalize bare
        // `www.…` and bare emails to openable schemes.
        const raw = view.state.sliceDoc(linkNode.from, linkNode.to);
        const href = normalizeAutolinkHref(raw);
        if (href.length === 0) return false;
        window.open(href, '_blank', 'noopener,noreferrer');
        event.preventDefault();
        return true;
      }
      if (linkNode.type.name === 'Wikilink') {
        if (onWikilinkClick === null) return false;
        const rawTarget = extractWikilinkTarget(view, linkNode);
        if (rawTarget === null) return false;
        // URL-encode to match the markdown side's emission
        // (`onWikilinkClick(encodeURIComponent(raw), event)` in
        // MarkdownEditor.svelte's `handleHostClick`). The shared
        // `DocumentCanvas.handleWikilinkClick` decodes before
        // resolving, so the two surfaces feed it the same shape.
        onWikilinkClick(encodeURIComponent(rawTarget), event);
        event.preventDefault();
        return true;
      }
      return false;
    },
  });
}

/**
 * Hover-tooltip extension for wikilinks. Resolves the target against
 * `getLivePaths()` and shows the path (resolved) or "Note not found"
 * (unresolved). No tooltip for URL links — the destination is already
 * visible in the source on cursor-reveal, and a tooltip showing the
 * URL would be noise.
 *
 * Returns `null` when the hover position isn't inside a wikilink,
 * which is how `hoverTooltip` says "no tooltip here". CM6 handles
 * fade-in / fade-out timing; the default ~300ms delay matches the
 * usual OS tooltip cadence.
 */
export function plaintextLinkHover(
  getLivePaths: () => readonly LivePath[],
): Extension {
  return hoverTooltip((view, pos, _side): Tooltip | null => {
    // Footnote reference first — the parse tree resolver below would
    // otherwise descend into Link / Wikilink only; FootnoteRef is its
    // own top-level inline node. Resolution shape: ref id → matching
    // FootnoteDef body. No match → no tooltip (the broken styling
    // already signals the missing target; a "definition not found"
    // popover would just be noise on every hover).
    const footnoteRef = resolveFootnoteRefAncestor(view, pos);
    if (footnoteRef !== null) {
      const id = extractFootnoteLabel(view, footnoteRef);
      if (id === null) return null;
      const defNode = findFootnoteDef(view, id);
      if (defNode === null) return null;
      const body = extractFootnoteDefBody(view, defNode);
      if (body.length === 0) return null;
      return {
        pos: footnoteRef.from,
        end: footnoteRef.to,
        above: true,
        create() {
          // Same visual register as the wikilink preview — the
          // `cm-md-footnote-preview` class shares the `.cm-tooltip`
          // shell rules with `.cm-md-wikilink-preview` (see the
          // `:has(.cm-md-wikilink-preview, .cm-md-footnote-preview)`
          // shell selector in PlaintextEditor.svelte) so both popovers
          // get the translucent panel + hairline border treatment.
          const dom = document.createElement('div');
          dom.className = 'cm-md-footnote-preview';
          dom.textContent = body;
          dom.dataset.footnoteId = id;
          return { dom };
        },
      };
    }

    const node = resolveLinkAncestor(view, pos);
    if (node?.type.name !== 'Wikilink') return null;

    const rawTarget = extractWikilinkTarget(view, node);
    if (rawTarget === null) return null;

    const livePaths = getLivePaths();
    const resolved = resolveLinkTarget({ raw: rawTarget, livePaths });

    // Only display when fully resolved or fully broken — the parser
    // already filtered empty / malformed shapes via the null guard
    // above. Position the tooltip above the wikilink so it doesn't
    // obscure following text.
    return {
      pos: node.from,
      end: node.to,
      above: true,
      create() {
        const dom = document.createElement('div');
        dom.className = 'cm-md-wikilink-preview';
        if (resolved !== null) {
          // Show the resolved path. If a future LivePath shape grows a
          // display label / title field we'd surface that instead;
          // today `path` is what's available.
          dom.textContent = resolved.path;
          dom.dataset.state = 'resolved';
        } else {
          dom.textContent = `Note not found: ${rawTarget}`;
          dom.dataset.state = 'broken';
        }
        return { dom };
      },
    };
  });
}
