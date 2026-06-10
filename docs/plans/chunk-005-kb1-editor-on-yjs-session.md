# Chunk 005: KB-1 Editor on the One-File Session

## Purpose

Bring KB-1's CodeMirror 6 Markdown editor — the live-preview decorations,
widgets, keymaps, and theme, at full fidelity — into KB-2 and wire it to the
chunk-003 one-file Yjs session. This is the chunk where KB-2 becomes a product
a user opens and types into, with the KB-1 editing feel, against a Markdown
file on their own filesystem.

## Starting Context

main contains: the daemon front door serving UI + API on one port (002), the
one-file Yjs session — `packages/doc-session`, `GET/POST /api/demo-document`,
and a y-protocols WebSocket endpoint for `$KB2_HOME/demo-vault/hello-world.md`
(003), and `packages/ui` + Storybook seeded from KB-1 primitives and `--rd-*`
tokens (004).

KB-1 (sibling checkout of this repo, READ-ONLY) contains the editor to port.
A full inventory was done before this plan; the editor surface is ~11.8K LOC
across 22 files and is cleanly abstracted: no API calls inside editor code,
no store imports — the host supplies a Y.Doc, callbacks, and props.

## KB-1 Reference (required reading before implementing)

All under `apps/@kb-1/web/src/lib/` in the KB-1 repo:

- `components/app/editor/PlaintextEditor.svelte` — the editor component:
  extension pipeline, custom Yjs sync plugin (origin tagging + undo contract),
  theme CSS. This is the spine of the port.
- `components/app/editor/plaintext-decorations.ts` — the markdown
  live-preview system (largest piece).
- `components/app/editor/plaintext-list-keymap.ts`, `plaintext-link-paste.ts`,
  `plaintext-link-affordance.ts`, `plaintext-mention-widget.ts`,
  `plaintext-mention-keymap.ts` — extensions to port intact.
- `note/content-format.ts` — origin constants (`plaintext-user`,
  `plaintext-agent`) and path-based format routing.
- `components/app/editor/plaintext-awareness.ts` — read to understand the
  seams, but DO NOT port (presence; see exclusions).
- `channel/VaultChannelClient.ts` — read for the transport seam only; DO NOT
  port (KB-2 uses its simpler chunk-003 endpoint).
- KB-1's editor tests next to those files — port the transport-free ones.

## Decisions

- The editor lives in a new package `packages/editor` (`@kb-2/editor`):
  the Svelte editor component plus all ported CM6 extensions. `packages/ui`
  stays primitives/layout; `apps/web` hosts the editor on a route.
- Transport: a minimal client-side y-protocols sync provider (~100 lines or
  the y-websocket client) against the existing chunk-003 WebSocket endpoint.
  No VaultChannelClient port, no multiplexing, no custom framing — one doc.
- KB-1's custom sync plugin and origin-tagging contract come over intact:
  user edits use the user origin and are undo-tracked; remote/system updates
  are not undoable. Y.RelativePosition semantics must survive the port.
- Ported at full fidelity: markdown live-preview decorations (headings,
  bold/italic/strike, inline code, code fences with syntax highlighting and
  language labels, tables, task checkboxes, depth-aware lists with bullet and
  number widgets, blockquotes, image display, wikilink/link styling, syntax
  hide/reveal on cursor), list tab/shift-tab keymap, link paste wrapping,
  link click + hover affordances, mention chip rendering, atomic mention
  deletion, editor theme CSS, and history/keymaps.
- Prose font via the @fontsource npm package KB-1 uses (bundled locally — no
  CDN fonts, consistent with the tokens decision from chunk 004).
- Dark mode: the editor theme must respect KB-2's `[data-rd-mode='dark']`
  token scope. KB-1's dark mode was a placeholder; do not regress light-mode
  fidelity to chase dark-mode polish — correct token wiring is enough.
- Excluded — presence (invariant: content, not people): the awareness
  producer/consumer and remote cursor rendering are not ported. The daemon
  already ignores awareness messages.
- Excluded — features whose backing arrives in later chunks: mention
  autocomplete (needs a people directory — a cloud concept; chip RENDERING of
  existing mention syntax stays), image upload (needs an asset write API —
  chunk 006 territory; the upload extension is omitted and image paste is a
  no-op), wikilink navigation (needs the file tree — chunk 006; clicks are a
  no-op, `livePaths` is seeded with just the demo path).
- Routing: `/` becomes the editor page for the demo document, with a slim
  daemon-status chip composed from `@kb-2/ui`; the full status shell moves to
  `/status`. KB-2's canonical content is Markdown and this is THE editor for
  it (KB-1's `.txt`-vs-`.md` routing split does not carry over yet).
- The editor gets fixture-backed Storybook stories (static Y.Doc, no daemon),
  included in the existing Storybook instance by extending its stories glob
  to `packages/editor`. Per-component stories for widget showcases per the
  Storybook invariant.

## Acceptance Criteria

1. `packages/editor` (`@kb-2/editor`) exists with the ported editor and
   extensions; `apps/web` composes it.
2. Opening `/` on the daemon port shows the editor loaded with the demo
   document's content via the Yjs session (not via the REST read).
3. Typing in the editor persists to `hello-world.md` (visible with `cat`) and
   survives a daemon restart.
4. Two browser tabs editing concurrently converge without clobbering.
5. Live-preview fidelity, verified in a real browser against the same content
   rendered in KB-1: headings (sizes/spacing), bold/italic/strike, inline
   code, code fences (chrome, syntax colors, language label, delimiter
   collapse), tables (borders, header tint, zebra), task checkboxes that
   toggle by click and write through to the file, lists (bullets, numbers,
   depth padding, tab/shift-tab), blockquotes, image display for resolvable
   URLs, syntax hide/reveal on cursor entry/exit.
6. Mention chips render for existing `[Name](mention:...)` syntax; no
   autocomplete UI exists.
7. Undo/redo tracks only local typing (a remote edit does not enter local
   undo history — testable with the smoke script plus a browser).
8. No awareness, cursor, selection, or presence code is ported or wired.
9. The editor theme renders correctly in light mode and switches with
   `[data-rd-mode='dark']`.
10. Editor stories render in Storybook from fixtures with no daemon running.
11. `pnpm check` passes; tests include ported extension tests plus an
    integration test where the editor's provider and a raw y-protocols client
    converge through the daemon endpoint.
12. Non-goals respected.

## Testing Expectations

Required coverage:

- ported transport-free extension tests (decorations, list keymap, link
  paste, mention helpers) running under KB-2's vitest setup
- provider <-> daemon integration test with a temp `KB2_HOME` (editor-side
  provider syncs against the real WebSocket endpoint)
- persistence assertion: a programmatic edit through the provider lands in
  the Markdown file
- all filesystem-touching tests use temp homes per the testing invariant

Browser-level behavior (typing, decorations, checkbox clicks) is covered by
manual verification below — do not build browser automation in this chunk.

## Manual Verification

```bash
pnpm install
pnpm check
pnpm dev
# open http://127.0.0.1:7382/
```

The expected world:

- `/` shows the KB-1-look editor with the demo document content
- typing renders live markdown decorations as in KB-1
- `cat ~/.kb2/demo-vault/hello-world.md` (or the temp-home equivalent)
  reflects edits within ~a second
- a second tab on `/` converges with the first while both type
- clicking a task checkbox toggles it in the file
- restarting the daemon preserves content
- `pnpm storybook` renders the editor stories without the daemon

## Verification

After implementation is reported complete:

- the implementer runs `pnpm check` and the manual verification flow above
  and reports actual output, not expected output
- UI-facing criteria are verified in a REAL BROWSER with the report stating
  what was visibly rendered (decoration fidelity, checkbox toggle, two-tab
  convergence); a green build or curl does not count
- a fresh reviewer who did not implement the chunk audits the diff against
  the acceptance criteria and the invariants in
  `docs/architecture/invariants/`, with particular attention to: presence
  code that slipped in, fetch/API calls inside `packages/editor`, and
  divergence from KB-1's extension behavior
- any deviation from this plan is listed explicitly in the review summary

## Non-Goals

- No file tree, no multi-file editing, no vault root config (chunk 006).
- No MCP tools (chunk 007).
- No direct-write warning UI (chunk 008; the daemon-side guard from 003 is
  unchanged).
- No presence, cursors, selections, or follow mode (cloud, later).
- No mention autocomplete or people directory.
- No image upload path.
- No wikilink navigation.
- No KB-1 ProseMirror/markdown-editor surfaces — only the CM6 editor.
- No editor performance work beyond what the port brings.
