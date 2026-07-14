# KB-1 Local

KB-1 Local is an open-source, local-first knowledge base built for people and
agents to work in the same vault. Your Markdown files stay on your machine and
remain the durable source of truth.

See `VISION.md` and `docs/architecture/` for the current product and
architecture docs.

> [!NOTE]
> KB-1 Local is under active development. Until a stable release is tagged,
> commands and interfaces may change between revisions.

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

## Security Model

KB-1 Local is a trusted local service, not a multi-user server. It does not add
authentication or per-user authorization to its local HTTP, WebSocket, or MCP
surfaces. Keep it bound to the default loopback address (`127.0.0.1`) unless
you intentionally place it behind a private, access-controlled network path.
Do not expose the daemon port directly to the public internet.

Vaults live under `~/.kb1/vaults/` by default. Back up `~/.kb1/` before
migrations or major upgrades. See [Security](SECURITY.md) for reporting and
deployment guidance.

## Prerequisites

- Node.js 20.19.x, 22.12+, or 24+. CI uses Node 24.
- Corepack, included with current Node.js releases.
- Git.

Enable the repo-declared package manager before installing dependencies:

```bash
git clone https://github.com/metatheoryinc/kb-1-daemon.git
cd kb-1-daemon
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

## Connect an Agent

Give an MCP-compatible agent the local endpoint:

```text
http://127.0.0.1:7382/mcp
```

For Claude Code:

```bash
claude mcp add kb-1 --transport http http://127.0.0.1:7382/mcp
```

Ask the agent to call `list_vaults` first, then pass one returned `id` as the
required `vaultId` for its other KB-1 tools.

Port/env overrides: `KB1_PORT` (daemon), `KB1_HOST` (bind host),
`KB1_WEB_PORT` (Vite dev server, default `5173`), `KB1_WEB_PROXY_TARGET`
(optional dev Vite proxy target), and `KB1_HOME` (daemon state directory,
defaults to `~/.kb1`). Relay/tunnel runs from `KB1_RELAY_URL` plus
`KB1_RELAY_TOKEN`; optional daemon identity fields are `KB1_DAEMON_VERSION` and
`KB1_DAEMON_BUILD`. `KB1_ACTOR_DEFAULT` controls default local actor
attribution (`user` or `unknown`), and `KB1_HISTORY_COALESCE_WINDOW_MS`
controls note-history commit coalescing.

On first boot, legacy `~/.kb2` homes are copied into `~/.kb1`. Before activating
the copy, the daemon verifies the directory structure and compares a SHA-256
digest for every regular source file. A missing path, content mismatch, symlink,
hard link, unsupported filesystem entry, or verification error aborts the
migration and preserves the source path. After a successful migration, the
complete legacy tree remains untouched at `~/.kb2` for rollback; the daemon
never renames or deletes it. Stable full-tree manifests prove that both source
and target remain unchanged through completion-marker publication. An atomic
`.kb1-migration-complete-v1.json` marker in the verified
target binds completion to the canonical source/target path pair and stable
vault id when present. It records the migration-time source digest as evidence,
but later boots do not require retained source content to stay frozen; both the
retained source and active `.kb1` tree may evolve independently. If a complete
home is restored at a new path, the supported daemon-home endpoint names and a
matching portable migration-time source digest allow the marker alone to rebind
atomically; the active target is never reconciled or overwritten. Missing proof
fails closed with manual-recovery guidance. A pre-existing target, including an
empty Docker volume mount, is reconciled by
copying only missing entries through migration-owned staging; existing entries
are never overwritten, must match byte-for-byte, and cannot grant broader POSIX
permissions than the source; newly copied entries preserve restrictive modes.
Privileged setuid, setgid, and sticky bits are stripped from daemon-owned copies.
It may contain additional regular files and directories. Migration marker,
temporary-marker, copy, lock, and staging names are reserved throughout the
source tree and rejected before any target entry is published. A canonical
source/target-pair lock serializes each migration. Locks are never auto-stolen
after a crash: an existing lock, unverified temporary control entry, or non-empty
interrupted stage is preserved and fails closed with manual-recovery guidance,
while only an empty pre-manifest stage is removed.
Portable aliases are checked across source and target before any missing entry
is published. POSIX files use hard-link no-replace publication when available;
filesystems without hard-link support fall back to exclusive creation, streamed
copy, `fsync`, and byte verification without overwriting an existing path. On
Windows, an ephemeral HMAC authenticates each staged move
before files, directories, and the marker are published with write-through
semantics; authentication or write-through failure aborts with the legacy
source intact.
On macOS, Node.js provides the standard `fsync` barrier but not Apple's
`F_FULLFSYNC`; sudden whole-device power loss can therefore reorder drive-cache
writes. The daemon keeps the complete `.kb2` source as the recovery authority
and never deletes it, so verify that retained source (and your backup) before
removing it manually.
Migration requires exclusive filesystem control: stop legacy and target-side
writers, sync tools, and backup restore jobs until the completion marker exists.
Directory-inode checks reject detected path changes, and POSIX completion
markers must have the effective user's ownership with no group/other write
access. Windows relies on the user's private filesystem ACL and the same
exclusive-writer boundary. Processes running as the same OS identity remain
inside the user's trusted filesystem boundary. After completion, retained
source and active target may evolve as described above.
Keep the legacy writer stopped during this handoff; the daemon compares complete
source manifests before and after final verification. Runtime config is KB1-only.

## Docker

Docker is a secondary run path. Because KB-1 Local does not provide local
authentication, publish its container port to loopback only:

```bash
docker build -f apps/daemon/Dockerfile -t kb-1-daemon .
docker run --rm \
  -p 127.0.0.1:7382:7382 \
  -v kb1-home:/data/kb1 \
  kb-1-daemon
```

The app is then available at http://127.0.0.1:7382. Do not replace the
loopback host with `0.0.0.0` unless you have added an access-controlled private
network boundary. More container and migration details are in
[Packaging Paths](docs/packaging/daemon.md).

## Common Setup Issues

- `pnpm: command not found`: run `corepack enable` and `corepack install` from
  this repository, then retry `pnpm install`.
- Unexpected install or build errors: confirm `node --version` reports
  20.19.x, 22.12+, or 24+.
- Port `7382` is already in use: run with another daemon port, for example
  `KB1_PORT=17382 pnpm dev`.
- Vite port `5173` is already in use: run with another web dev port, for
  example `KB1_WEB_PORT=5174 pnpm dev`.
- You want a clean trial state without touching existing data: run
  `KB1_HOME=$(mktemp -d) pnpm dev`.
- Docker starts but the browser cannot connect: confirm the mapping includes
  `127.0.0.1:7382:7382`, then open http://127.0.0.1:7382.

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
pnpm storybook     # component development on port 6006
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

## Project Policies

- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Security](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Release process](docs/releasing.md)
- [Apache 2.0 license](LICENSE)
