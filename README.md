# KB-1 Local

The open-source local half of KB-1: a local-first, agent-ready knowledge base
where the user's filesystem is the durable source of truth.

See `VISION.md` and `docs/architecture/` for the current product and
architecture docs.

## Product Modes

- **Local-only:** run the open-source daemon and connect local agents without a
  KB-1 Cloud login. The daemon does not provide Cloud users, organizations,
  team presence, or per-user permissions; access is limited to the daemon host
  and any private network path the operator deliberately provides.
- **Cloud-connected self-hosted:** keep the daemon and durable vault files on a
  machine you control, then add KB-1 Cloud identity, organization membership,
  relay routing, and access for approved users and agents that are not
  colocated with the daemon.
- **Hosted:** use KB-1 Cloud while KB-1 operates the daemon that stores the
  hosted vault.

Cloud is additive for local users. A Cloud login is not required to run the
daemon, use its local web app, or connect an agent to its local MCP endpoint.

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

Port/env overrides: `KB1_PORT` (daemon), `KB1_HOST` (bind host),
`KB1_WEB_PROXY_TARGET` (optional dev Vite proxy target), and `KB1_HOME`
(daemon state directory, defaults to `~/.kb1`). Relay/tunnel runs from
`KB1_RELAY_URL` plus `KB1_RELAY_TOKEN`; optional daemon identity fields are
`KB1_DAEMON_VERSION` and `KB1_DAEMON_BUILD`. `KB1_ACTOR_DEFAULT` controls
default local actor attribution (`user` or `unknown`), and
`KB1_HISTORY_COALESCE_WINDOW_MS` controls note-history commit coalescing.
On first boot, legacy `~/.kb2` homes are copied into `~/.kb1`. Before removing
the source, the daemon checks that every regular source file exists at the same
relative path in the target with the same byte length. Symlinks and empty
directories are not checked, and a pre-existing target may contain additional
files. Make a separate backup first if you need content-level verification or a
rollback copy. Runtime config is KB1-only.

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
