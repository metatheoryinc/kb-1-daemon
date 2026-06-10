# Chunk 003: One-File Yjs Session

## Purpose

Prove the core editing substrate with the smallest possible filesystem surface:
one Markdown file served through the daemon.

This chunk introduces an active Yjs/Y.Text document session for a single
`hello-world.md` file. Yjs is the active-session source of truth while the file
is open; the filesystem remains the durable truth across restarts.

## Starting Context

Chunk 002 should provide one daemon port for the local UI and API. This chunk
adds the first real content API and WebSocket editing surface, but keeps scope to
one file so the team can focus on the Yjs and filesystem semantics.

## Desired End State

The daemon can create, read, edit, and persist one managed Markdown file:

```text
$KB2_HOME/
  demo-vault/
    hello-world.md
```

The daemon exposes local API and WebSocket behavior for that file. Multiple
clients can connect to the document session and make conflict-free edits through
Yjs. The materialized Markdown file reflects the accepted document state.

## Invariants

- The filesystem is durable truth.
- Yjs/Y.Text is active-session truth only while the document session is open.
- On cold start, the daemon can recreate the Yjs document from
  `hello-world.md`.
- All edits go through the daemon service boundary.
- The UI and any future MCP tools must use the same service/API boundary.
- This chunk handles one Markdown file only.
- This chunk does not introduce file trees, rename/move APIs, search, cloud
  relay, auth, users, orgs, or presence.

## Acceptance Criteria

The chunk is complete when all of the following are true:

1. The daemon ensures a demo Markdown file exists if missing.
2. The demo file path is configurable enough for tests to use temp directories.
3. An API endpoint can read the current Markdown content.
4. An API endpoint or documented operation can reset/seed the demo content for
   tests and manual verification.
5. A WebSocket endpoint exposes the active Yjs document session for the demo
   file.
6. Two clients connected to the WebSocket session can apply edits without
   clobbering each other.
7. Accepted edits are persisted back to `hello-world.md`.
8. Restarting the daemon rebuilds document state from the Markdown file.
9. Stale direct filesystem state does not silently overwrite an active Yjs
   session.
10. Tests cover cold boot from file, Yjs edit application, persistence to file,
    and restart/reload from file.
11. `pnpm check` passes.
12. No file tree, rename/move, search, MCP, relay, auth, or presence behavior is
    implemented.

## Testing Expectations

Required coverage:

- unit tests for the one-file document service
- integration tests using a temp `KB2_HOME`
- WebSocket/Yjs integration test with at least two simulated clients
- persistence test that verifies filesystem content after edits
- restart-style test that rebuilds from the materialized Markdown file

The tests should avoid real user paths and should not depend on timing-sensitive
sleep unless there is no practical alternative.

## Manual Verification

A reviewer should be able to run an equivalent flow:

```bash
pnpm install
pnpm check
KB2_HOME=/tmp/kb2-yjs-smoke KB2_PORT=8787 pnpm --filter @kb-2/daemon dev
curl http://localhost:8787/api/demo-document
cat /tmp/kb2-yjs-smoke/demo-vault/hello-world.md
```

The expected world:

- the daemon creates `hello-world.md` when missing
- API reads return the file content
- the checked-in smoke script connects two clients and applies concurrent edits
- the edits appear in `hello-world.md`
- restarting the daemon preserves the edited content

## Non-Goals

- No general vault model.
- No arbitrary path reads.
- No file tree.
- No move or rename API.
- No search.
- No local MCP tools.
- No cloud relay.
- No auth, users, orgs, billing, cursors, selections, or presence.
- No KB-1 UI import.

## Decisions

- The document session service lives in `packages/doc-session` (package name
  `@kb-2/doc-session`). The service takes a target file path as a parameter;
  the daemon routes hardcode the single demo path. The one-file constraint
  lives at the API surface, not inside the service, so the future vault
  service can host many sessions without a rewrite.
- The WebSocket endpoint speaks the standard y-websocket sync protocol from
  `y-protocols`. No custom or tunnel-ready framing; a future relay can wrap
  standard frames.
- Persistence is serial and immediate, with no timers: after each Yjs update
  is applied, the service materializes the document to disk with an atomic
  write (temp file + rename). Writes are serialized — at most one write in
  flight, and updates arriving during a write coalesce into a single trailing
  write. Pending writes flush on last-client-disconnect and graceful
  shutdown. Debounced flushing is a deliberate later optimization, deferred
  until multi-writer performance demands it.
- Before materializing, the service compares the file's current content hash
  to the hash it last wrote. On mismatch (an external edit happened), it must
  not silently clobber: it logs/emits a warning and explicitly prefers the
  active session state (criterion 9). Full direct-write detection and UI
  warning events are chunk 008.
- The demo file lives at `$KB2_HOME/demo-vault/hello-world.md`. Separate vault
  root configuration is chunk 006.
- No UI debug surface in this chunk. Manual verification uses a small
  checked-in smoke script that connects two Yjs clients over WebSocket and
  applies concurrent edits.

## Verification

After implementation is reported complete:

- the implementer runs `pnpm check` and the manual verification flow above and
  reports actual output, not expected output
- a fresh reviewer who did not implement the chunk audits the diff against the
  acceptance criteria and the invariants in `docs/architecture/invariants/`
- any deviation from this plan is listed explicitly in the review summary
