/**
 * Paste-a-URL-as-markdown-link for the plaintext (CM6) editor.
 *
 * Two behaviors, both editor-side only (the clipboard always holds the
 * raw URL, so pasting outside the editor is unaffected):
 *
 *   1. Any URL pasted over a text selection wraps the selection:
 *      select "see my research", paste a link → `[see my research](url)`.
 *      Same convention as GitHub / Obsidian.
 *
 *   2. A kb-1 note URL (`/app/org|private|public/vault/<slug>/<path>`)
 *      pasted with no selection inserts `[<note name>](url)` — the
 *      label is the note's filename stem taken from the URL itself, so
 *      links to notes in other vaults resolve without any lookup.
 *
 * Everything else falls through to CM6's default paste. Guards on the
 * wrap path: the selection must be single-line (wrapping a multi-line
 * selection breaks the markdown link) and must not itself be a URL
 * (pasting a URL over an old URL should replace it, not nest it).
 *
 * Sibling of `plaintext-image-upload.ts` — same `domEventHandlers`
 * paste hook. The two are disjoint: the image handler only acts when
 * the clipboard carries files, this one only when it carries plain
 * text, so mount order doesn't matter.
 */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

import { parseInVaultSelector } from './selector-url';

/** Matches the three vault route shapes; captures vault slug + selector. */
const VAULT_ROUTE_RE = /^\/app\/(?:org\/[^/]+|private|public)\/vault\/([^/]+)(\/.+)?$/;

function asHttpUrl(text: string): URL | null {
  if (/\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

/**
 * If `url` points at a note inside a kb-1 vault, return the note's
 * display label (filename stem, decoded); otherwise null. Routing
 * shape and note-vs-folder discrimination both delegate to the
 * canonical parser in `selector-url.ts`.
 */
export function noteLinkLabel(url: URL): string | null {
  const match = VAULT_ROUTE_RE.exec(url.pathname);
  if (!match) return null;
  const target = parseInVaultSelector(
    decodeURIComponent(match[1]),
    match[2] ?? '',
  );
  if (target.kind !== 'note') return null;
  const base = target.path.split('/').pop() ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  return stem.length > 0 ? stem : null;
}

/**
 * Backslash-escape the characters that would terminate or corrupt a
 * markdown link label: `\` itself, and both square brackets.
 */
function escapeLabel(label: string): string {
  return label.replace(/[\\[\]]/g, '\\$&');
}

/**
 * A plain CommonMark link destination ends at the first unescaped `)`.
 * `encodeURIComponent` leaves parens alone, so note names like
 * `plan (draft).md` survive into the URL — percent-encode them here so
 * the destination parses intact. %28/%29 decode back transparently on
 * navigation.
 */
function safeHref(url: URL): string {
  return url.href.replaceAll('(', '%28').replaceAll(')', '%29');
}

/**
 * Pure decision core, exported for tests. Returns the markdown to
 * insert in place of the pasted text, or null to let the default
 * paste run.
 */
export function linkPasteMarkdown(
  pasted: string,
  selected: string,
): string | null {
  const url = asHttpUrl(pasted.trim());
  if (!url) return null;
  if (selected.length > 0) {
    if (selected.includes('\n')) return null;
    if (asHttpUrl(selected.trim())) return null;
    return `[${escapeLabel(selected)}](${safeHref(url)})`;
  }
  const label = noteLinkLabel(url);
  return label === null ? null : `[${escapeLabel(label)}](${safeHref(url)})`;
}

/**
 * Build the CM6 extension. The dispatch goes through the normal
 * local-edit path (PLAINTEXT_USER_ORIGIN via the sync plugin), so the
 * inserted link is undoable and visible to peers like any typed text.
 */
export function plaintextLinkPaste(): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (!view.state.facet(EditorView.editable)) return false;
      const data = event.clipboardData;
      if (!data || data.files.length > 0) return false;
      const text = data.getData('text/plain');
      if (!text) return false;
      // Multi-cursor paste: transforming only the main range while
      // preventDefault() suppresses the rest would silently drop the
      // other cursors' pastes — fall through to CM6's default, which
      // handles multi-range correctly.
      if (view.state.selection.ranges.length !== 1) return false;
      const { from, to } = view.state.selection.main;
      const markdown = linkPasteMarkdown(text, view.state.sliceDoc(from, to));
      if (markdown === null) return false;
      event.preventDefault();
      view.dispatch({
        changes: { from, to, insert: markdown },
        selection: { anchor: from + markdown.length },
        scrollIntoView: true,
        userEvent: 'input.paste',
      });
      return true;
    },
  });
}
