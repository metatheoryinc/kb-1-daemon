# Chunk 006: Direct-Write Detection And Loud Saving

## Purpose

Close the unhappy path around the one managed file. Today, an external edit
to `hello-world.md` under an active session is detected only at write time
(the content-hash guard prefers session state and logs a server-side
warning), and a persistence failure logs a warning nobody sees. Both are
silent divergence from the user's point of view.

After this chunk, the daemon detects external changes promptly, reconciles
the active session to reflect the file, converges every client, and tells
every client what happened — and persistence failures surface loudly in the
UI until saving recovers. This is the
`docs/architecture/invariants/product/edits-save-or-fail-loudly.md`
invariant made real (read it first; it is the soul of this chunk).

## Starting Context

main contains chunks 001-005: daemon front door, one-file Yjs session
(`packages/doc-session` with serial coalesced persistence and a
last-written-hash guard), `packages/ui` + Storybook, and the KB-1 CM6 editor
on `/` with the y-protocols provider in `apps/web/src/lib/yjs/`.

Conflict semantics already settled by VISION/architecture docs: direct
filesystem writes are valid but second-class — outside the conflict-free
path. They must be detected, reconciled, and surfaced. Losing a small
in-flight edit in that race is acceptable; the user being unaware is not.

## KB-1 Reference (required reading)

- `packages/@kb-1/collab-merge` in the KB-1 repo — KB-1's helpers for
  merging/diffing text into Y.Text. If a suitable diff-into-Y.Text helper
  exists, adapt it rather than writing one; minimal-diff application
  preserves other clients' cursor positions better than full replacement.
- `apps/@kb-1/api/src/durable-objects/vault-channel.ts` — how KB-1 frames
  non-sync messages alongside Yjs sync on one socket.

## Decisions

- Detection: `fs.watch` on the managed file's directory PLUS a content-hash
  check before acting (watch events are noisy and platform-uneven; the hash
  decides). The session already tracks the hash it last wrote — a change
  event whose content hash matches the last-written hash is the daemon's own
  write and is ignored. Debounce/coalesce rapid external writes (~100-250ms).
  A low-frequency fallback poll (~2s) covers platforms where watch is
  unreliable; both paths feed the same hash check, so duplicates are free.
- Reconciliation: on a confirmed external change with an active session, the
  daemon applies the disk content into the Y.Text in a single transaction
  with a dedicated external-change origin. Prefer a minimal diff splice
  (KB-1 collab-merge reference) over full replace; full replace is the
  acceptable fallback if the helper does not adapt cleanly. Clients converge
  through normal Yjs sync. The external-change origin must not enter any
  client's undo history (same mechanism as the agent/remote origins).
- After reconciliation the daemon does NOT immediately re-materialize (disk
  already holds the truth it just read); the next user edit resumes the
  normal persist path.
- Event channel: a third message type on the existing WebSocket, alongside
  y-protocols sync — constant defined in `@kb-2/doc-session`, payload JSON:
  `{ kind: 'external-change' | 'persist-failure' | 'persist-recovered',
  path, ts }`. One transport, no new endpoints. The app-side provider
  surfaces these to the page via a callback (transport stays in `apps/web`
  per the no-transport invariant).
- Persistence failures: when materialization fails, the session broadcasts
  `persist-failure` to all clients and keeps the session alive (chunk 003
  behavior); every subsequent failed attempt may re-broadcast (coalesced);
  the first successful persist after a failure broadcasts
  `persist-recovered`.
- UI: a banner component (presentational, in `packages/ui`, props-driven,
  with stories) rendered by the editor page:
  - external change → notice banner: "This file changed outside KB-2 and was
    reloaded from disk." Dismissible.
  - persist failure → persistent alarm banner: "Changes are NOT saving to
    disk." Not dismissible while the condition holds; clears on
    `persist-recovered` with a brief "Saving restored" confirmation.
- While no session is open, external edits need no event (cold boot already
  reads disk — chunk 003).
- WebSocket disconnect behavior is explicitly OUT of scope: the invariant's
  named temporary exception covers it. Do not build reconnect, offline
  detection, or read-only mode in this chunk.
- No per-vault generalization: this watches the one managed file only. The
  watcher lives in `packages/doc-session` (parameterized by path, like the
  session) so chunk 007 can reuse it per file.

## Acceptance Criteria

1. With `/` open in a browser and the session active, an external edit to
   the managed file (e.g. `echo >> hello-world.md`) results, within ~2
   seconds, in: the browser content updating to the disk content, and a
   visible external-change banner in every connected client.
2. After reconciliation there is no split brain: disk content, daemon Y.Text,
   and every client's rendered content agree (hash-verifiable).
3. The daemon's own materializations never trigger the external-change path
   (own-write hash suppression), including during rapid typing.
4. The external-change transaction does not pollute any client's local undo
   history.
5. A simulated persistence failure (e.g. vault directory made read-only in a
   temp home) while typing produces the loud not-saving banner in the
   browser; restoring writability and typing again produces the recovery
   signal and clears the banner.
6. Persist-failure warnings are broadcast to ALL connected clients, not just
   the one that triggered the failing write.
7. Concurrent typing during an external reload does not corrupt the document
   or wedge the session; any lost in-flight edit is bounded by the
   reconciliation transaction and the user has been informed by criterion 1.
8. The new banners are presentational components in `packages/ui` with
   fixture-backed stories (notice + alarm + recovery states), per the
   Storybook and no-transport invariants.
9. Tests cover: own-write suppression, external-change detection and
   reconciliation (two simulated clients converge on disk content and both
   receive the event), persist-failure and persist-recovered broadcasting,
   and debounce/coalescing of rapid external writes. All with temp homes.
10. `pnpm check` passes.
11. No reconnect/offline/read-only behavior is introduced; no file tree,
    MCP, or multi-file support.

## Testing Expectations

Required coverage (package level where possible, integration through the
daemon where the WebSocket framing matters):

- hash-based own-write suppression unit tests
- external-change reconciliation test: seed file, open two simulated
  clients, modify the file directly, assert both clients converge to disk
  content and receive the external-change event
- undo-isolation test: external-change transaction not undoable by a client
  with local edits
- persist-failure path test (inject a failing write), recovery test
- watcher debounce test for rapid sequential external writes

Timing-sensitive sleeps only where unavoidable; prefer event-driven waits.

## Manual Verification

```bash
pnpm install && pnpm check && pnpm dev
# open http://127.0.0.1:7382/ in two tabs
echo "external edit" >> ~/.kb2/demo-vault/hello-world.md
# both tabs: content updates + external-change banner within ~2s
# then, with a temp-home daemon: make demo-vault read-only, type in the
# editor → alarm banner; restore writability, type → recovery, banner clears
```

(For the failure simulation, use a temp `KB2_HOME` daemon instance — never
make the real vault read-only.)

## Verification

After implementation is reported complete:

- the implementer runs `pnpm check` and the manual flow above and reports
  actual output, not expected output
- UI-facing criteria are verified in a REAL BROWSER: the external-change
  banner appearing live in two tabs, the not-saving alarm appearing and
  clearing — report what was visibly rendered
- a fresh reviewer who did not implement the chunk audits the diff against
  the acceptance criteria and all invariants in
  `docs/architecture/invariants/`, with particular attention to
  edits-save-or-fail-loudly (no silent paths left), ui-packages-own-no-
  transport (banners are props-driven), and single-writer (the watcher
  reconciles through the session, never writes the file)
- any deviation from this plan is listed explicitly in the review summary

## Non-Goals

- No WebSocket reconnect, offline indicator, or read-only-on-disconnect
  (covered by the invariant's temporary exception).
- No file tree, multi-file, or vault root configuration (chunk 007).
- No MCP (chunk 008).
- No general directory watcher or rename/move inference — one file.
- No conflict-resolution UI (diff views, merge prompts) — reconcile + inform.
- No presence concepts.
