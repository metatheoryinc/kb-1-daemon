# KB-2

A local-first, agent-ready knowledge base where the user's filesystem is the
durable source of truth. See `VISION.md` and `docs/architecture/` for the full
picture; execution sequence lives in `docs/plans/local-first-roadmap.md`.

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

Port/env overrides: `KB2_PORT` (daemon), `KB2_WEB_PORT` (internal Vite dev
server), `KB2_HOME` (daemon state directory, defaults to `~/.kb2`).

## MCP

The daemon hosts a streamable-HTTP MCP server at `/mcp` on the same loopback
port as the app and API. Start the daemon, then add it to Claude Code:

```bash
KB2_HOME=$(mktemp -d) KB2_PORT=17992 pnpm dev:daemon
claude mcp add kb-2 --transport http http://127.0.0.1:17992/mcp
```

Available tools: `vault_info`, `list_files`, `read_note`, `create_note`,
`edit_note`, `append_note`, `prepend_note`, `delete_note`, `move_note`,
`create_folder`, `delete_folder`, `move_folder`, `search`.

`read_note` returns a `baseline` for edit loops. `edit_note` uses the same
anchored splice contract as the REST API: stale baselines return
`stale_doc` with current content and a fresh baseline, ambiguous matches return
`match_count`, and persist failures are surfaced without writing a success
audit row. `move_note` and `move_folder` do not rewrite links.

## Other Commands

```bash
pnpm smoke:yjs     # two-client Yjs editing smoke against a running daemon
pnpm docker:up     # daemon in Docker (host port 17382); pnpm docker:down to stop
```

## Layout

- `apps/daemon` — the local server (`kb2d`), the only runtime writer
- `apps/web` — the local web UI, served by the daemon
- `packages/doc-session` — Yjs document sessions backed by Markdown files
- `packages/ui` — component library + Storybook
- `docs/plans/` — chunk plans; `docs/architecture/invariants/` — the rules
  every change is audited against
