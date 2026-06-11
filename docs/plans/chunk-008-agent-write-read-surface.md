# Chunk 008: Agent Write/Read Surface

## Purpose

The vault becomes operable by agents: baseline-anchored splice edits,
append/prepend, and search with context lines — over the same service
boundary the UI uses. Plus paying chunk 007's accepted debt: idle-session
garbage collection. This is the API layer that chunk 009's MCP tools will
map onto 1:1. Arc context: `docs/plans/local-ops-arc.md`.

## Starting Context

main has 001-007: vault-core service layer, multi-file path-keyed sessions
with rekey/doc-deleted semantics, vault REST routes, audit JSONL, fast-diff
`applyContent` on live PUT. Sessions currently stay resident until daemon
shutdown (007's disclosed debt — one fs watcher + 2s poller each).

## KB-1 Reference (read before building)

All under `~/Development/Metatheory/kb-1` (READ-ONLY):

- `apps/@kb-1/mcp/src/tools/edit-note.tool.ts` and the plaintext-splice
  types/service — the baseline-anchored splice contract this chunk adapts:
  inputs (base state vector, old_text, new_text, before/after/occurrence),
  rejection taxonomy (`stale_doc` echoing current body, `not_found`,
  `ambiguous`, `too_large_splice`, `too_large_document`, `transient`).
- `apps/@kb-1/api/src/lib/note/search-service.ts` — result shape (path,
  snippet, context lines) and folder-filter semantics; NOT the FTS5
  implementation (we have no D1; see Decisions).
- KB-1's read path returning head metadata + baseline for the edit loop.

## Decisions

- **Splice contract (the heart).** `POST /api/files/<path>/splice` with
  `{baseline, old_text, new_text, before?, after?, occurrence?}`.
  `baseline` is an opaque base64 Y.Doc state-vector token issued by reads.
  Semantics adapted from KB-1: if the session's current state vector
  differs from `baseline` → reject `stale_doc` WITH the current content and
  a fresh baseline (agent re-plans in one round trip). Otherwise locate
  `old_text` in current content (disambiguated by `before`/`after` context
  and 1-based `occurrence`; multiple matches without disambiguation →
  `ambiguous` listing match count). Apply through the live/hydrated session
  as a single transaction (retain/delete/insert delta — same machinery as
  `applyContent`, never a disk bypass). Caps mirror KB-1: 64 KiB splice,
  1 MiB document. Success returns `{content?, baseline}` (new baseline;
  content echo optional via query flag).
- **Reads issue baselines.** `GET /api/files/<path>` gains `baseline` in
  its response (hydrating a session if needed). This is what makes the
  edit loop read → splice → re-read coherent.
- **Append/prepend.** `POST /api/files/<path>/append` and `/prepend` with
  `{content}`; create-if-missing on append (mcp-obsidian's most-used write
  path); prepend inserts AFTER YAML frontmatter when present (ecosystem
  norm). Frontmatter detection uses `gray-matter` (exact-pinned,
  battle-tested — no hand-rolled frontmatter parsing). Both apply through
  the session; no baseline required (positional, not content-anchored).
- **Search.** `GET /api/search?q=&under=&context=&limit=&offset=`.
  Tier-1 semantics per the arc: case-insensitive substring match over
  note files, streaming file-by-file scan via vault-core's walk (mundane
  glue — no indexes, no ranking, no query syntax; those are tier 3).
  Results: `{path, line, lineText, context: {before[], after[]}}` capped
  per file and globally, paginated, `.kb2/` and trash excluded. Document
  the scan's O(vault) nature in the route description.
- **Idle-session GC (007 debt).** A session closes (watcher stopped,
  timers cleared, flushed) when its last WebSocket client disconnects and
  no operation is in flight, after a short grace period (~30s, named
  constant) to survive reloads. API operations on non-live files hydrate
  an ephemeral session that closes after the operation flushes unless a
  client attached meanwhile. Invariant: closing NEVER races a pending
  persist (flush-then-close, the existing `close()` discipline).
- **Audit rows** for splice/append/prepend (operation kinds added);
  search/reads append nothing.
- **Error taxonomy** extends 007's: `stale_doc`, `ambiguous`,
  `too_large_splice`, `too_large_document` → 409/400-family JSON bodies
  with the structured detail KB-1 returns (the MCP layer will surface them
  verbatim).
- **No UI work** beyond what regression requires; the editor is untouched.

## Acceptance Criteria

1. Splice round trip: read returns a baseline; a valid splice applies
   through the session, persists to disk (dual-asserted), returns a new
   baseline, and writes an audit row.
2. Staleness: read baseline, mutate the doc (second client or API), then
   splice with the old baseline → `stale_doc` with current content + fresh
   baseline; retry with it succeeds.
3. Anchoring: `ambiguous` on multiple matches without disambiguation;
   `before`/`after`/`occurrence` select correctly (table-tested);
   `not_found` when old_text absent; size caps enforced.
4. Splice against a LIVE session with concurrent typing: both the splice
   and the concurrent edits survive (CRDT-merged) — browser-verified with
   a real tab typing during an API splice.
5. Append creates-if-missing; prepend lands after frontmatter when present
   (gray-matter), at top otherwise — both dual-asserted.
6. Search: matches with correct context lines across nested folders;
   `under` filter works; `.kb2/`/trash excluded; pagination caps honored;
   no audit rows for search.
7. Idle GC: after the last tab closes, the session closes within the grace
   period (watcher/timers gone — asserted via the manager's introspection
   in tests); a reload within the grace period reattaches without
   rehydration; ephemeral API sessions close after their operation; a
   pending persist always completes before close (tested).
8. 007 behaviors regress clean: rekey-on-move (straddling keystrokes),
   doc-deleted (internal + external), quiet/loud external-change paths,
   route taxonomy.
9. Arc testing bar: real temp filesystems, dual assertion on every
   mutation, coverage gates wired and green (vault-core stays 100%;
   splice/search/session-GC code ≥95% lines — it is pure-logic-heavy),
   fast-check property tests: splice application reproduces expected
   content for randomized docs/edits (incl. emoji/surrogates); search
   results always reference real lines in real files.
10. `pnpm check -- --skip-nx-cache` green; temp homes; processes killed.
11. Non-goals respected.

## Testing Expectations

Per the arc-wide bar (007's section is the template). The hearts:
the splice property test (apply → exact expected content, surrogate-safe),
the staleness/anchoring table, the GC flush-then-close race test, and the
browser-verified concurrent splice (criterion 4).

## Manual Verification

```bash
pnpm install && pnpm check -- --skip-nx-cache
KB2_HOME=$(mktemp -d) KB2_PORT=<free port> pnpm dev:daemon
# read a file via API → note the baseline
# splice it while a browser tab types into the same doc → both edits land
# splice again with the OLD baseline → stale_doc with fresh content
# append to a nonexistent path → file created; prepend to a frontmatter doc
# search a term spanning nested folders → context lines correct
# close all tabs → session closes after grace (daemon logs/status)
```

## Verification

- Implementer browser-verifies criterion 4 (and the 007 regressions) in a
  REAL browser, reporting what was visibly observed.
- A fresh audit subagent in an isolated worktree re-runs everything:
  full check, coverage-gate negative test, splice property suite, its own
  browser drill for criterion 4 with CONTINUOUS typing straddling the
  splice instant, GC introspection checks, and verdicts against all
  acceptance criteria and all nine invariants.
- Deviations listed explicitly.

## Non-Goals

- MCP server/tools (chunk 009 — this chunk builds exactly the surface 009
  wraps).
- Frontmatter KEY operations, tags, outline/document-map (tier 2).
- Ranked/indexed/syntax search, link index, backlinks (tier 3).
- No heading/block-targeted patch operations (the anchored splice is the
  edit primitive; structural targeting can layer on later).
- No editor/UI changes.
