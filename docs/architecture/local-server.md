# Local Server

The local KB-2 server is the authoritative runtime for one or more vaults. It is
open source and runs on a user's device, a home server, or a user-controlled
cloud instance such as a Docker container on a provider they choose.

The server is also the host for the first local KB-2 product experience. It
should serve a minimal local web UI that uses the same service APIs as local MCP,
local API clients, and later cloud relay requests.

## Responsibilities

The local server owns:

- serving multiple local vaults
- reading Markdown and asset files
- service-mediated writes
- splice edits
- move, rename, delete, and create operations
- search and indexing
- hot Yjs/Y.Text document sessions
- filesystem materialization
- direct file write detection
- local audit/event logs
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
images, attachments, and `.kb2` metadata. It may eagerly rebuild indexes and
document runtime state, or it may do so lazily as files are requested.

Yjs state is runtime state. It exists so active edits can be conflict-free and
multi-author. It is not the durable source of truth. If only the Markdown files
and durable `.kb2` metadata are restored, the server should be able to serve the
vault again.

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
KB-2; reloaded from disk" is preferable to introducing local user/cursor models.

## Document Identity

KB-2 can begin path-keyed:

```text
document identity = canonical vault-relative path
```

This differs from KB-1. In KB-1, path became metadata and stable note IDs became
the real identity. In KB-2, the filesystem path is part of the source of truth.

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

The local server should maintain an append-only product audit log. Daily JSONL
files are a good default:

```text
.kb2/audit/
  2026-06-10.jsonl
  2026-06-11.jsonl
```

Events should capture product semantics rather than every low-level filesystem
detail:

```json
{"ts":"2026-06-10T06:00:00Z","actor":"user:123","source":"cloud-relay","op":"splice","vaultId":"vault_123","path":"notes/example.md","requestId":"req_123"}
```

The audit log complements Git. It should not depend on Git commit cadence.

## Local Agent Access

Local agents should be able to talk directly to the local server over localhost
MCP/API:

```text
Agent -> localhost MCP/API -> Local Server -> Filesystem
```

This supports fast private local workflows without sending requests through the
cloud. Remote/web agents still use the cloud MCP/API and relay.

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

The purpose of the local UI is to make KB-2 useful before the cloud relay exists
and to exercise the same filesystem-backed APIs that local MCP tools and later
cloud relay requests will use.

## Open Questions

- What language/runtime should the local server use?
- What file watcher behavior is reliable enough across macOS, Linux, Windows,
  Docker bind mounts, and network filesystems?
- How much of the Yjs update stream should be cached locally for active sessions?
- What is the exact audit event schema and retention model?
- Should local API auth be required on localhost, and how should local agent
  credentials be issued?
- Should the local UI be served by the daemon app directly or built as a separate
  workspace app whose static output is mounted by the daemon?
