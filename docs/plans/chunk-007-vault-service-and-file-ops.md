# Chunk 007: Vault Service Layer And File Operations

## Purpose

One file becomes a vault. This chunk builds the service layer that owns
every vault operation (`packages/vault-core`), generalizes the Yjs doc
session from one hardcoded file to any vault path, gives move/rename/delete
correct live-session semantics, and exposes it all over the Hono API. The
web UI gains path routing so any vault file opens in the editor. This is
the foundation the agent surface (008) and MCP tools (009) build on —
see `docs/plans/local-ops-arc.md` for the arc and the operation tiering.

## Starting Context

main has chunks 001-006.5 + tunnel-protocol: a daemon serving KB-1's CM6
editor over a one-file Yjs session (route layer hardcodes the demo file;
session internals already parameterized by path), direct-write detection
with fast-diff reconcile (quiet merge when lossless, loud when racing),
serial coalesced persistence with `lastWrittenHash`/`lastWrittenContent`.

## KB-1 Reference (read before building)

All under `~/Development/Metatheory/kb-1` (READ-ONLY):

- `apps/@kb-1/api/src/lib/note/note-service.ts` and
  `lib/folder/folder-service.ts` — the service-function shape (create,
  delete, move, rename, list), result unions, idempotency contracts.
- `apps/@kb-1/api/src/lib/*/path-validation.ts` — path rules to borrow:
  vault-relative, forward-slash, no `.`/`..`/empty segments, length caps,
  notes require `name.ext`.
- `apps/@kb-1/api/src/api/routes/note-routes.ts` — route→service dispatch
  style and error mapping.
- Write-result taxonomy (`write-types.ts`): `already_exists`,
  `version_conflict`, `not_found`, `invalid_path`, `path_collision`.
- KB-1's key architectural trick — stable noteIds make rename/move pure
  metadata so live sessions never notice — does NOT transfer: KB-2's path
  IS the identity (filesystem-durable-truth). Read it to understand what we
  must solve differently, not to copy.

## Decisions

- **`packages/vault-core`**: pure filesystem vault operations — path
  validation, vault info, list/tree (recursive walk with depth limit and
  entry cap), create/write, mkdir, delete-to-trash, move/rename for files
  and folders. No transport, no Yjs, single clear responsibility,
  thoroughly unit-tested against temp dirs. Plain `fs/promises` recursion
  is acceptable glue; no new algorithmic code.
- **Path is identity.** Validation rules borrowed from KB-1 (above).
  Vault-relative paths everywhere; the configured vault root stays the
  existing single-vault convention under `KB2_HOME` (multi-vault deferred).
- **Sessions go multi-file.** The session manager keys live sessions by
  vault-relative path; the watcher generalizes to vault scope and routes
  events to the right session (006/006.5 reconcile machinery reused per
  session, unchanged). Sessions hydrate on demand and tear down when the
  last client leaves (existing lifecycle, now per path).
- **Move/rename REKEYS the live session** — the chunk's heart. The Y.Doc
  survives: the session moves to the new path key, persistence targets the
  new file, the watcher mapping updates, and clients receive a new
  protocol event `doc-moved {fromPath, toPath}`; the web client updates its
  URL and keeps editing. In-flight edits MUST NOT be lost (acceptance-
  tested by typing during the rename). Rename is a thin wrapper over move.
- **Delete tears the session down loudly.** File goes to
  `<vault>/.kb2/trash/<ISO-stamp>/<original-path>` (permanent delete only
  via explicit flag). Live clients receive `doc-deleted {path}`: the editor
  becomes read-only with a prominent notice (new banner variant + fixture
  story). EXTERNAL deletion (watcher sees the file vanish) now maps to the
  same `doc-deleted` handling — replacing chunk 006's reconcile-to-empty —
  which resolves that deferred decision: a vanished file is a dead session,
  not an empty document.
- **Folder ops**: mkdir (idempotent), folder delete (refuses non-empty
  without `recursive`; recursive trashes contained files and tears down
  their sessions), folder move/rename (rekeys every live session under the
  subtree).
- **Writes through the service, sessions respected.** API whole-file write
  to a path WITH a live session applies content through the session
  (fast-diff → `applyDelta`, existing code path) so concurrent typing
  CRDT-merges instead of racing; no warning banner (in-band write). Without
  a session: direct service write. Daemon-own writes must not trigger the
  external-change banner (existing `lastWrittenHash` mechanism).
- **API surface** (Hono, matching existing route style):
  - `GET /api/vault` — vault info (root name, file/folder counts).
  - `GET /api/tree?under=<path>&depth=<n>` — files+folders listing.
  - `GET /api/files/<path>` — content + stat.
  - `PUT /api/files/<path>` — create/write; no-clobber default, 409
    `already_exists`; `?overwrite=true` to replace.
  - `DELETE /api/files/<path>` — to trash; `?permanent=true`.
  - `POST /api/files/<path>/move` `{to}` — move/rename.
  - `POST /api/folders` `{path}` / `DELETE /api/folders/<path>?recursive=` /
    `POST /api/folders/<path>/move` `{to}`.
  - Errors use a small taxonomy mirroring KB-1: `invalid_path` (400),
    `not_found` (404), `already_exists`/`path_collision` (409).
  - Route descriptions state plainly that move/rename does NOT rewrite
    wikilinks yet (link index is a later chunk).
- **Audit log**: every mutation appends one JSON line to
  `<vault>/.kb2/audit/changes.jsonl` — `{id, ts, actor: {kind, client?},
  operation, entityKind, path, fromPath?, toPath?, summary}`. HTTP callers
  log as `{kind: "user"}` (unknown local caller is acceptable). This is the
  attribution storage language the content-not-people exception requires;
  MCP (009) and the relay will write richer actors into the same log.
- **UI**: route `/<path>` opens the editor on that vault file (nested paths
  included); `/` redirects to the demo file's path URL. `doc-moved`
  navigates in place; `doc-deleted` shows the read-only notice. No file
  tree UI in this chunk — navigation is by URL.
- **Protocol**: `doc-moved` and `doc-deleted` join the event kinds in
  `@kb-2/doc-session/protocol`; provider and page pass them through like
  the others.

## Acceptance Criteria

1. `packages/vault-core` exists with the operations above, no transport
   or Yjs imports, and unit tests covering every operation and the full
   path-validation rule set (including `..`, absolute paths, empty
   segments, length caps, extension requirement) — all against temp dirs.
2. Two different files open in two tabs sync independently through their
   own sessions — browser-verified.
3. Rename/move with a live session: client follows to the new path and a
   marker typed DURING the rename survives on disk at the new path —
   browser-verified, file verified moved on disk (old path absent).
4. Folder move with live sessions beneath it rekeys all of them (tested;
   browser-verified for at least one nested file).
5. Delete with a live session: `doc-deleted` renders the read-only notice
   (fixture story exists), the file lands in `.kb2/trash/` with its
   original relative path, and trash is excluded from list/tree.
6. External deletion of an open file produces the same `doc-deleted`
   handling (replaces reconcile-to-empty; updated tests).
7. API surface behaves as decided: no-clobber PUT 409s without
   `overwrite`; writes to a live-session path merge through the session
   (concurrent-typing test); error taxonomy correct.
8. Direct-write detection (quiet merge + loud race) still works, now on
   any vault file; daemon-own writes never trigger the banner —
   regression-tested.
9. Every mutation appends a well-formed audit JSONL row with actor fields
   (tested).
10. `/` demo flow unchanged after redirect; `/<nested/path.md>` routes
    work — browser-verified.
11. `pnpm check` green; every test and flow uses temp homes; processes
    cleaned up.
12. Nothing from later chunks: no search, no splice/append endpoints, no
    MCP, no link rewriting, no file-tree UI.

## Testing Expectations

- vault-core unit suite (the path-validation table is the workhorse).
- Session rekey under concurrent edits (criterion 3) — the heart of the
  chunk; include the folder-move variant.
- External-delete → `doc-deleted` migration tests (replacing the 006
  reconcile-to-empty expectations).
- API integration tests for the full route surface and error taxonomy.
- Audit-row shape tests.
- Existing 006/006.5 suites stay green (adjusted only where the external-
  delete decision changes them).

## Manual Verification

```bash
pnpm install && pnpm check && KB2_HOME=$(mktemp -d) pnpm dev   # own temp home, port 7382 free? use the dev default only if free
# tab A: /demo-vault-file path; tab B: create a second file via API, open it
# rename the open file via API while typing in tab A → tab follows, marker survives
# delete it via API → loud read-only notice; file present under .kb2/trash/
# cat the audit log: one row per mutation with actor fields
```

## Verification

- Implementer browser-verifies criteria 2-5 and 10 in a REAL browser and
  reports what was visibly observed (curl is not UI verification).
- A fresh audit subagent in an isolated worktree re-runs everything
  (pnpm check with --skip-nx-cache, live daemon on its own port + temp
  KB2_HOME, headless-Chrome DOM assertions including the
  type-during-rename test), then verdicts against all acceptance criteria
  and every invariant in `docs/architecture/invariants/`.
- Deviations listed explicitly.

## Non-Goals

- Search, anchored splice, append/prepend (chunk 008).
- MCP server/tools (chunk 009).
- Wikilink rewriting on move/rename, link index, backlinks (later; the
  API documents the gap).
- File tree UI, multi-vault, attachments, frontmatter/tag operations.
- No changes to persistence/reconcile semantics beyond the external-delete
  decision.
