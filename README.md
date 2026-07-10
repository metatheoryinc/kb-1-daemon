# KB-1 Local

The open-source local half of KB-1: a local-first, agent-ready knowledge base
where the user's filesystem is the durable source of truth.

See `VISION.md` and `docs/architecture/` for the current product and
architecture docs.

## Prerequisites

- Node.js 24. The CI workflow uses Node 24, and this is the supported
  development/runtime version for source checkouts.
- Corepack, included with current Node.js releases.
- Git.

Enable the repo-declared package manager before installing dependencies:

```bash
corepack enable
corepack install
pnpm install
```

The workspace uses the pnpm version declared in `package.json`; do not install
dependencies with npm or Yarn.

Command examples below use a POSIX shell. On Windows PowerShell, set
environment variables with `$env:NAME="value"` before the command, for example
`$env:KB1_PORT="17382"; pnpm dev`.

## Quick Start From Source

Run the local daemon and web UI from a checkout:

```bash
pnpm dev
```

The default run stores daemon state in `~/.kb1`. For a disposable first run,
use an isolated home:

```bash
KB1_HOME=$(mktemp -d) pnpm dev
```

| Surface | URL | Notes |
|---|---|---|
| App (UI + API) | http://127.0.0.1:7382 | The daemon front door serves both; API under `/api/*` |
| MCP | http://127.0.0.1:7382/mcp | Streamable HTTP MCP endpoint for local agents |
| Storybook | http://localhost:6006 | `pnpm storybook`; pass `-p <port>` if 6006 is taken |

After startup, verify the daemon is healthy:

```bash
curl http://127.0.0.1:7382/api/health
```

Then open http://127.0.0.1:7382 in a browser. A fresh daemon home creates a
starter `demo-vault` so the UI has content immediately.

Port/env overrides: `KB1_PORT` (daemon), `KB1_HOST` (bind host),
`KB1_WEB_PORT` (Vite dev server, default `5173`), `KB1_WEB_PROXY_TARGET`
(optional dev Vite proxy target), and `KB1_HOME` (daemon state directory,
defaults to `~/.kb1`). Relay/tunnel runs from `KB1_RELAY_URL` plus
`KB1_RELAY_TOKEN`; optional daemon identity fields are `KB1_DAEMON_VERSION` and
`KB1_DAEMON_BUILD`. `KB1_ACTOR_DEFAULT` controls default local actor
attribution (`user` or `unknown`), and `KB1_HISTORY_COALESCE_WINDOW_MS`
controls note-history commit coalescing. Legacy `~/.kb2` homes migrate to
`~/.kb1` on first boot; runtime config is KB1-only.

## Docker

Docker is available as a secondary local run path:

```bash
pnpm docker:up
```

The container serves KB-1 at http://127.0.0.1:17382 and persists data in
`./.kb1-docker` by default. Stop it with:

```bash
pnpm docker:down
```

Docker path overrides:

- `KB1_DOCKER_HOST_HOME` changes the host directory mounted into the container.
- `KB1_DOCKER_CONTAINER_HOME` changes the in-container `KB1_HOME` path.

Use `node scripts/docker-up.mjs --print-config` to inspect the compose
configuration before starting it.

## Common Setup Issues

- `pnpm: command not found`: run `corepack enable` and `corepack install` from
  this repository, then retry `pnpm install`.
- Unexpected install or build errors: confirm `node --version` reports Node 24.
- Port `7382` is already in use: run with another daemon port, for example
  `KB1_PORT=17382 pnpm dev`.
- Vite port `5173` is already in use: run with another web dev port, for
  example `KB1_WEB_PORT=5174 pnpm dev`.
- You want a clean trial state without touching existing data: run
  `KB1_HOME=$(mktemp -d) pnpm dev`.
- Docker starts but the browser cannot connect: open
  http://127.0.0.1:17382, not the container-internal port `7382`.

## Contributor Checks

Before opening a pull request, run the full workspace gate:

```bash
pnpm check
```

`pnpm check` runs the workspace typecheck, tests, and builds. It is useful for
contributors, but it is not required just to try the app locally.

## Relay / Tunnel

Relay is an optional daemon-side public feature. To point a daemon at a relay
endpoint, set both `KB1_RELAY_URL` and `KB1_RELAY_TOKEN`; supplying only one is
a startup configuration error. `KB1_DAEMON_VERSION` and `KB1_DAEMON_BUILD` are
optional identity metadata sent during relay registration.

When relay config is present, the daemon opens an outbound WebSocket connection
after the local HTTP server starts. The relay endpoint receives no inbound port
exposure from the user's machine. Internally the tunnel client appends stable
wire paths to the configured relay URL: `/__kb1_tunnel/control` for the control
socket and `/__kb1_tunnel/dialback` for WebSocket dial-back streams.

The local lifecycle API is:

- `GET /api/relay/status`
- `POST /api/relay/connect`
- `POST /api/relay/disconnect`

Status responses use `{ ok: true, relay }`, where `relay` has `configured`,
`started`, `controlConnected`, and `reconnectScheduled`. If relay is not
configured, status remains readable with `configured: false`, `connect` returns
`relay_not_configured`, and `disconnect` is a no-op.

Relayed content requests still use the normal vault-scoped API surface. There
is no default vault assumption: callers discover vaults first, then address a
specific vault id. Relayed writes can attribute the upstream actor with the
`x-kb1-actor` JSON header using `kind: "user"` or `kind: "integration"` plus
optional `id`, `name`, and `client` strings. Without that header, the daemon
uses `KB1_ACTOR_DEFAULT`.

## Local API Primitives

`GET /api/vaults` is the discovery primitive. It lists every served vault as
`{ id, displayName, metadata? }`; `id` is the vault slug used by every
content API. The daemon has no implicit default vault for content routes.

Vault management lives at `POST /api/vaults`, `PUT /api/vaults/:id` (rename
display name only), `PUT /api/vaults/:id/metadata`, and
`DELETE /api/vaults/:id`. Deleting every vault is valid: `GET /api/vaults`
then returns an empty list until a new vault is created.

Newly created vaults are seeded from the bundled starter kit when they have no
user content. The first boot of an empty home creates the `demo-vault` starter
vault this way. Existing or migrated vaults are not re-seeded or overwritten.

`POST /api/vaults/:id/ops/flush` is the backup primitive for one vault. It
forces every dirty live document session in that vault through the existing
doc-session materialization path and returns only after those writes have
settled:

```json
{ "ok": true, "flushed": 1, "durableAsOf": "2026-06-12T09:00:00.000Z" }
```

Call it before snapshotting or syncing the vault. A clean vault returns
`flushed: 0`. If any session cannot persist, the response uses the same
canonical failure dialect as the rest of the API, and the existing save-warning
event path still fires.

`GET /api/vaults/:id/events` is the tooling primitive for one vault. It is a
Server-Sent Events stream for watchers, backup triggers, and live tree refresh.
Events report change kind, vault-relative paths, actor attribution, and
timestamps for persisted content, file/folder create/delete/move, folder
metadata changes, external file changes, and persist failure/recovery. Event
payloads never carry file content; consumers fetch content through the normal
read APIs.

Content routes are also vault-scoped: examples include
`GET /api/vaults/:id/tree`, `GET /api/vaults/:id/search?q=...`,
`GET|PUT|DELETE /api/vaults/:id/files/{path}`,
`POST /api/vaults/:id/files/{path}/splice`, `append`, `prepend`, and `move`,
`GET|PUT /api/vaults/:id/raw/{path}` for attachments, folder routes under
`/api/vaults/:id/folders`, and the Yjs socket at
`/api/vaults/:id/files/{path}/yjs`.

Note history is Git-backed and best-effort. REST exposes it at
`GET /api/vaults/:id/files/{path}/history`; `KB1_HISTORY_COALESCE_WINDOW_MS`
sets the coalescing window for daemon-authored history commits. History follows
KB-1 move commits across renames when Git can supply that history. MCP history
parity remains an open decision.

## MCP

The daemon hosts a streamable-HTTP MCP server at `/mcp` on the same loopback
port as the app and API. Start the daemon, then add it to Claude Code:

```bash
KB1_HOME=$(mktemp -d) KB1_PORT=17992 pnpm dev:daemon
claude mcp add kb-1 --transport http http://127.0.0.1:17992/mcp
```

Available tools: `list_vaults`, `vault_info`, `list_files`,
`list_attachments`, `read_attachment`, `upload_attachment`, `read_note`,
`create_note`, `edit_note`, `append_note`, `prepend_note`, `delete_note`,
`move_note`, `create_folder`, `delete_folder`, `move_folder`,
`get_folder_metadata`, `set_folder_metadata`, `search`.

Workflow: call `list_vaults` first, then pass one returned `id` as the required
`vaultId` on every other tool. There is no MCP default vault for data tools.

`read_note` returns a `baseline` for edit loops. `edit_note` uses the same
anchored splice contract as the REST API: stale baselines return
`stale_doc` with current content and a fresh baseline, ambiguous matches return
`match_count`, and persist failures are surfaced without writing a success
audit row. `list_files` includes inline folder metadata. `set_folder_metadata`
persists durable folder color/icon metadata and is audited as `mcp_client`.
`move_note` and `move_folder` do not rewrite links. Attachment tools operate on
binary vault-relative paths: `list_attachments` discovers them,
`read_attachment` returns image blocks or base64 metadata, and
`upload_attachment` writes small inline base64 attachments.

Parity target: UI-reachable service-backed operations either have MCP tools over
the same vault service boundary or are listed as explicit gaps in
`docs/architecture/mcp-parity.md`. Current open parity decisions include vault
lifecycle CRUD and note history.

## Other Commands

```bash
pnpm smoke:yjs     # two-client Yjs editing smoke against a running daemon
pnpm docker:up     # daemon in Docker (host port 17382); pnpm docker:down to stop
```

## Layout

- `apps/daemon` — the local server (`kb1d`), the only runtime writer
- `apps/web` — the local web UI, served by the daemon
- `packages/doc-session` — Yjs document sessions backed by Markdown files
- `packages/editor` — plaintext editing and mention/decorator support
- `packages/local-mcp` — streamable HTTP MCP tools over the vault service
- `packages/tunnel-client` — daemon-side relay/tunnel client
- `packages/tunnel-protocol` — shared relay/tunnel protocol types
- `packages/ui` — component library + Storybook
- `packages/vault-core` — filesystem-backed vault operations and history
- `packages/vault-service` — service boundary composed by the daemon routes and MCP
- `docs/architecture/` — architecture notes and invariants for the local
  product
