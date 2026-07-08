# Local Server

The local KB-1 server is the authoritative runtime for one or more vaults. It is
open source and runs on a user's device, a home server, or a user-controlled
cloud instance such as a Docker container on a provider they choose.

The server is also the host for the first local KB-1 product experience. It
should serve a minimal local web UI that uses the same service APIs as local MCP,
local API clients, and later cloud relay requests.

## Responsibilities

The local server owns:

- serving multiple local vaults
- vault discovery, creation, display-name rename, metadata update, and soft
  deletion
- reading Markdown and asset files
- service-mediated writes
- splice edits
- move, rename, delete, and create operations
- search and indexing
- hot Yjs/Y.Text document sessions
- filesystem materialization
- direct file write detection
- local audit/event logs and Git-backed best-effort note history
- folder and vault metadata
- local web UI delivery
- local MCP/API access
- outbound cloud tunnel connection

It does not own remote account administration, organization membership, or
multi-user access policy. Those are enforced by the cloud layer before requests
are relayed.

It also does not own local multi-user presence. In the local-first product, the
server should model files, edits, file-change events, and audit history. Users,
cursors, selections, follow mode, and presence remain cloud collaboration
concepts unless a future local collaboration mode explicitly adds them.

## Filesystem Canonical Model

The filesystem is canonical. On startup, the server can bootstrap from Markdown,
images, attachments, and `.kb1` metadata. It may eagerly rebuild indexes and
document runtime state, or it may do so lazily as files are requested.

Yjs state is runtime state. It exists so active edits can be conflict-free and
multi-author. It is not the durable source of truth. If only the Markdown files
and durable `.kb1` metadata are restored, the server should be able to serve the
vault again.

The multi-vault registry lives under `KB1_HOME/vaults/<slug>/`. A vault slug is
the stable `id` used by REST and MCP. The identity file inside each vault is
`.kb1/vault.json`:

```json
{ "id": "demo-vault", "displayName": "demo-vault" }
```

`metadata` may be present when vault presentation metadata exists. The daemon
serves no implicit content vault: clients first list vaults, then address a
specific slug. Deleting every vault is a valid runtime state and leaves
`GET /api/vaults` returning an empty array until a new vault is created.

First boot of an empty `KB1_HOME` creates a `demo-vault` starter vault seeded
from the bundled starter-kit template. Creating another vault through
`POST /api/vaults` also seeds that vault when it has no user content. Existing
or migrated vaults are not re-seeded.

## Service-Mediated Writes

The clean write path is always through the server:

```text
caller -> read/search/splice/move/rename API -> local server -> filesystem
```

This applies to the local web UI as well. The UI must not bypass the server and
read or write the filesystem directly.

Direct file writes are allowed because users own their vault files, but they are
outside the conflict-free editing path. The server should detect them with file
watching or periodic scans, invalidate relevant hot state, re-read/reindex the
file, and emit a warning event through connected local and cloud clients.

For the local UI, a direct filesystem edit should be represented as a content
state change, not as a presence event. A simple warning such as "changed outside
KB-1; reloaded from disk" is preferable to introducing local user/cursor models.

## REST API Surface

Vault discovery and management:

- `GET /api/vaults`
- `POST /api/vaults`
- `PUT /api/vaults/:id`
- `PUT /api/vaults/:id/metadata`
- `DELETE /api/vaults/:id`

Vault content routes are scoped with `/api/vaults/:id/...`:

- `GET /api/vaults/:id/vault`
- `GET /api/vaults/:id/tree`
- `GET /api/vaults/:id/search?q=...`
- `GET|PUT|DELETE /api/vaults/:id/files/{path}`
- `POST /api/vaults/:id/files/{path}/splice`
- `POST /api/vaults/:id/files/{path}/append`
- `POST /api/vaults/:id/files/{path}/prepend`
- `POST /api/vaults/:id/files/{path}/move`
- `GET|PUT /api/vaults/:id/raw/{path}`
- folder routes under `/api/vaults/:id/folders`
- `POST /api/vaults/:id/ops/flush`
- `GET /api/vaults/:id/events`
- `GET /api/vaults/:id/files/{path}/history`

The Yjs socket is also vault-scoped at
`/api/vaults/:id/files/{path}/yjs`. Unknown vault ids return a normal not-found
failure.

## Document Identity

KB-1 can begin path-keyed:

```text
document identity = canonical vault-relative path
```

This differs from KB-1. In KB-1, path became metadata and stable note IDs became
the real identity. In KB-1, the filesystem path is part of the source of truth.

Rename and move operations must be explicit:

- `move(oldPath, newPath)` is a first-class operation.
- clients subscribed to `oldPath` receive a moved/renamed event.
- clients rebind to `newPath`.
- caches keyed by `oldPath` are invalidated.
- stale writes should fail using an expected revision or content hash.

External renames detected by the file watcher can be inferred best-effort, but
may degrade to delete/create plus a warning flare.

## Revision Tokens

Write operations should include an expected revision token:

```text
splice(path, expectedRevision, edits)
```

The token may begin as a content hash or local revision counter. It protects
against stale writes after external edits, moves, or reloads.

## Audit Log

The local server maintains product audit rows for service-mediated operations
and best-effort Git-backed note history. The audit record is product history;
Git history is the queryable note timeline exposed by the current `/history`
route.

```text
.kb1/audit/
  2026-06-10.jsonl
  2026-06-11.jsonl
```

Events should capture product semantics rather than every low-level filesystem
detail:

```json
{"ts":"2026-06-10T06:00:00Z","actor":"user:123","source":"cloud-relay","op":"splice","vaultId":"vault_123","path":"notes/example.md","requestId":"req_123"}
```

The audit log complements Git. It should not depend on Git commit cadence.

Note history is exposed at `GET /api/vaults/:id/files/{path}/history`. The
daemon creates coalesced KB-1 history commits when Git is available and treats
Git failures as unavailable history rather than failed content writes.
`KB1_HISTORY_COALESCE_WINDOW_MS` configures the coalescing window. Move commits
are structural history barriers, so history can follow files across KB-1 move
operations when Git can provide the log.

## Local Agent Access

Local agents should be able to talk directly to the local server over localhost
MCP/API:

```text
Agent -> localhost MCP/API -> Local Server -> Filesystem
```

This supports fast private local workflows without sending requests through the
cloud. Remote/web agents still use the cloud MCP/API and relay.

The shipped MCP endpoint is streamable HTTP at `/mcp`. `list_vaults` is the
discovery tool; every data tool requires `vaultId`. MCP currently covers note,
folder, search, folder metadata, and attachment operations over the same vault
service boundary. Whether MCP parity requires a note-history tool is open.

## Runtime Configuration

The daemon reads `KB1_*` environment variables only:

- `KB1_HOME`: daemon-managed state directory, default `~/.kb1`
- `KB1_HOST`: HTTP bind host, default `127.0.0.1`
- `KB1_PORT`: HTTP port, default `7382`
- `KB1_WEB_PROXY_TARGET`: optional Vite dev target for non-API UI requests
- `KB1_RELAY_URL` and `KB1_RELAY_TOKEN`: relay/tunnel connection, supplied together
- `KB1_DAEMON_VERSION` and `KB1_DAEMON_BUILD`: optional relay identity metadata
- `KB1_ACTOR_DEFAULT`: default local actor attribution, `user` or `unknown`
- `KB1_HISTORY_COALESCE_WINDOW_MS`: non-negative note-history coalescing window

Legacy `KB2_*` env vars are ignored. Legacy `~/.kb2` homes and the old
single-vault layout are migration inputs only.

## Local Web UI

The local web UI is a first-class open-source surface. It should start with the
local product capabilities:

- file tree browsing
- Markdown read/edit
- local service-mediated writes
- file-change warnings
- search when the local search subsystem exists

It should not include:

- cloud auth
- users
- organization management
- remote account administration
- remote sharing policy
- cursors, selections, follow mode, or presence

The purpose of the local UI is to make KB-1 useful before the cloud relay exists
and to exercise the same filesystem-backed APIs that local MCP tools and later
cloud relay requests will use.

## Open Questions

- What file watcher behavior is reliable enough across macOS, Linux, Windows,
  Docker bind mounts, and network filesystems?
- Should local API auth be required on localhost, and how should local agent
  credentials be issued?
- Whether MCP parity requires a history tool.
- Whether public daemon relay/tunnel contract docs should split from cloud
  policy docs beyond factual env and endpoint mention.
- Whether `docs/daemon/**` should become a canonical public docs namespace.
