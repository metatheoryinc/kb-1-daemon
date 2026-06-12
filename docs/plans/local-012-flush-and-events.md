# Chunk 012: Persist Barrier + Change Events

## Purpose

Two small, generally-useful daemon primitives that complete the
local-first story around durability and observation:

1. **A persist barrier** — a way for any caller (backup script, sync
   tool, agent) to say "make everything durable NOW and tell me when it
   is". Today the only option is waiting out the debounce and hoping.
2. **A change event stream** — a way for tooling to observe vault
   changes as they happen (persisted edits, file/folder ops, external
   changes, persist failures) without polling the tree.

Both are notification/control surfaces over machinery the daemon
already has. Neither adds a second write path or a second event
pipeline.

## Repo references (search before adding)

- Debounced materialization: `packages/doc-session` owns the dirty →
  persisted lifecycle; the flush barrier forces this existing path, it
  does not write files itself (`single-writer-service-boundary`).
- The daemon already emits internal events that drive the save/warning
  banners and audit JSONL rows (`packages/vault-core`, doc-session).
  Find that existing emission spine and extend it — the SSE endpoint is
  a subscriber, not a parallel pipeline (one canonical event source).
- Route conventions, failure mapping, and coverage-gate wiring: follow
  `apps/daemon/src/app.ts` and the chunk 011A routes as the template.

## Decisions (decided; do not reopen)

- **`POST /api/ops/flush`**: forces immediate materialization of every
  dirty live session. Returns `{flushed: <count>, durableAsOf: <iso>}`
  only after all writes have settled (fsync'd). If any persist fails,
  the endpoint fails through the canonical failure union AND the
  existing loud persist-failure path still fires — the barrier never
  masks a failure (`edits-save-or-fail-loudly`). A flush with no dirty
  sessions succeeds with `flushed: 0`.
- **`GET /api/events`**: Server-Sent Events. Emits the events the
  system already produces internally: content persisted (with
  vault-relative path), file/folder created, deleted, moved, folder
  metadata changed, external change detected, persist failure and
  recovery. Payloads carry path(s), event kind, and audit actor —
  NEVER file content. Events are notifications, not transport;
  consumers fetch content through the existing APIs.
- **README documentation in the daemon's own terms**: flush is the
  backup primitive ("call before snapshotting the vault"); events is
  the tooling primitive (watchers, backup triggers, future live tree
  refresh in the local UI).
- Failures flow through the one canonical union with exhaustive
  compiler-checked mappers (`one-failure-dialect`). New codes extend
  the union, never fork the shape.

## Acceptance Criteria

1. Flush endpoint per decisions; a test makes a session dirty, calls
   flush, and dual-asserts disk content AND response shape; a
   persist-failure case (chmod) proves flush reports failure loudly
   and the existing failure banner path still fires.
2. Events endpoint with a real-connection test: connect, perform
   mutations via the API, assert event order and shape, assert clean
   disconnect handling; a test greps event payloads to prove no
   content bytes ride the stream.
3. Both endpoints inside coverage gates; repo gates (`pnpm check`)
   fully green; README describes both primitives.
4. No second write path, no second event pipeline — the diff shows
   flush driving the existing materialization path and SSE subscribing
   to the existing emission spine.

## Testing Expectations

Real-fs vitest (mkdtemp temp homes); real HTTP/SSE connections against
a daemon on an ephemeral port, killed by the test; dual assertion on
every durability claim (API response AND raw file/audit row). Unicode
paths in at least one event test. Implementer on ports 9890+ with temp
KB2_HOME; kill what you start.

## Non-Goals

- No UI consumption of `/api/events` (future chunk; the primitive just
  exists).
- No MCP tools for these ops endpoints this chunk.
- No webhooks, no event persistence/replay, no filtering query params
  — a connection sees events from connect time onward, period.
- No changes to debounce timing or the materialization algorithm.

## Verification

Fresh audit subagent in its own worktree: re-runs gates + a coverage
negative test; runs its own daemon and verifies flush durability with
a kill-after-flush drill (flush returns → kill -9 the daemon → file
content present on disk); connects its own SSE client and replays the
mutation matrix; greps the stream for content bytes; verdicts every
criterion + all eleven invariants.
