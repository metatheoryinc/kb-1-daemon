# KB-1 Local

The open-source local half of KB-1: a local-first, agent-ready knowledge base
where the user's filesystem is the durable source of truth.

See `VISION.md` and `docs/architecture/` for the current product and
architecture docs.

## Quick Start

```bash
pnpm install
pnpm check   # typecheck + tests + builds
pnpm dev     # one command: web UI + API behind one daemon port
```

| Surface | URL | Notes |
|---|---|---|
| App (UI + API) | http://127.0.0.1:7382 | The daemon front door serves both; API under `/api/*` |
| MCP | http://127.0.0.1:7382/mcp | Streamable HTTP MCP endpoint for local agents |
| Storybook | http://localhost:6006 | `pnpm storybook`; pass `-p <port>` if 6006 is taken |

Port/env overrides: `KB1_PORT` (daemon), `KB1_WEB_PORT` (internal Vite dev
server), `KB1_HOME` (daemon state directory, defaults to `~/.kb1`). Existing
`KB2_*` overrides and `~/.kb2` homes are still accepted for in-place upgrades.

## Local API Primitives

`POST /api/ops/flush` is the backup primitive. It forces every dirty live
document session through the existing doc-session materialization path and
returns only after those writes have settled:

```json
{ "ok": true, "flushed": 1, "durableAsOf": "2026-06-12T09:00:00.000Z" }
```

Call it before snapshotting or syncing the vault. A clean vault returns
`flushed: 0`. If any session cannot persist, the response uses the same
canonical failure dialect as the rest of the API, and the existing save-warning
event path still fires.

`GET /api/events` is the tooling primitive. It is a Server-Sent Events stream
for watchers, backup triggers, and future live tree refresh. Events report
change kind, vault-relative paths, actor attribution, and timestamps for
persisted content, file/folder create/delete/move, folder metadata changes,
external file changes, and persist failure/recovery. Event payloads never carry
file content; consumers fetch content through the normal read APIs.

## MCP

The daemon hosts a streamable-HTTP MCP server at `/mcp` on the same loopback
port as the app and API. Start the daemon, then add it to Claude Code:

```bash
KB1_HOME=$(mktemp -d) KB1_PORT=17992 pnpm dev:daemon
claude mcp add kb-1 --transport http http://127.0.0.1:17992/mcp
```

Available tools: `vault_info`, `list_files`, `read_note`, `create_note`,
`edit_note`, `append_note`, `prepend_note`, `delete_note`, `move_note`,
`create_folder`, `delete_folder`, `move_folder`, `get_folder_metadata`,
`set_folder_metadata`, `search`.

`read_note` returns a `baseline` for edit loops. `edit_note` uses the same
anchored splice contract as the REST API: stale baselines return
`stale_doc` with current content and a fresh baseline, ambiguous matches return
`match_count`, and persist failures are surfaced without writing a success
audit row. `list_files` includes inline folder metadata. `set_folder_metadata`
persists durable folder color/icon metadata and is audited as `mcp_client`.
`move_note` and `move_folder` do not rewrite links.

Parity rule: every UI-reachable vault operation must have an MCP tool
equivalent over the same vault service boundary.

## Other Commands

```bash
pnpm smoke:yjs     # two-client Yjs editing smoke against a running daemon
pnpm docker:up     # daemon in Docker (host port 17382); pnpm docker:down to stop
```

## Layout

- `apps/daemon` — the local server (`kb1d`; `kb2d` remains a compatibility alias), the only runtime writer
- `apps/web` — the local web UI, served by the daemon
- `packages/doc-session` — Yjs document sessions backed by Markdown files
- `packages/ui` — component library + Storybook
- `docs/architecture/` — architecture notes and invariants for the local
  product
