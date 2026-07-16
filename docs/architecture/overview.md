# KB-1 Architecture Overview

KB-1 separates durable customer data from optional remote coordination.

The local server owns content operations, filesystem materialization, local
agent access, and the local web UI. The Cloud layer owns authentication, relay
routing, collaboration policy, and ephemeral presence for Cloud-connected use.
Remote web and API surfaces can look similar to KB-1 from a user and agent
perspective, but content requests are proxied to the user's active local server
instead of resolved from remote D1/R2 storage.

## High-Level Shape

```text
Local Web UI / Local MCP / Local API
        |
Open-source local KB-1 server
Vault API, Yjs runtime, search, audit, file watcher, materializer
        |
Local filesystem
Markdown, images, attachments, .kb1 metadata

Cloud-connected mode:

Remote Web UI / Remote MCP / Remote API
        |
Remote relay layer
Auth, relay registry, active sessions, permissions, presence
        |
Outbound WebSocket tunnel from local server
        |
Open-source local KB-1 server
Vault API, Yjs runtime, search, audit, file watcher, materializer
        |
Local filesystem
Markdown, images, attachments, .kb1 metadata
```

## Planes

KB-1 has two main runtime planes.

The content plane handles durable vault operations:

```text
Web/API/MCP -> Remote Relay -> Local Server -> Filesystem
Local Web UI -> Local API -> Local Server -> Filesystem
Local agents -> Local API/MCP -> Local Server -> Filesystem
```

The awareness plane handles ephemeral collaboration state:

```text
Web clients -> Remote realtime service -> Web clients
```

Presence, cursors, selections, and follow-mode state do not need to pass through
the local server unless they become durable product history. This keeps the local
server focused on content authority.

The local UI should not model users, cursors, selections, or presence in the
first local-first phase. It should show file and edit state clearly, including
warnings when a file changes outside the service-mediated editing path.

## Authority

The core authority rules are:

- A local server may host many vaults.
- A vault may have only one active authoritative local server connection.
- The relay rejects or explicitly manages takeover when a second local server
  tries to claim an already-connected vault.
- All local content operations route through the local server APIs.
- All remote content operations route through the active tunnel for that vault.
- Local agents can bypass the cloud by using localhost MCP/API tools.

## Request Flow

For a local read or edit:

1. The local web UI, local MCP client, or local API client calls the local server.
2. The local server validates the requested vault and path.
3. The local server performs the read, search, edit, move, or rename.
4. The local server updates files, runtime state, indexes, and audit logs.
5. The local server returns the response and emits any relevant local file-change
   events.

For a Cloud-connected remote read or edit:

1. A web client, remote MCP client, or remote API client calls the relay.
2. The relay authenticates the caller.
3. The relay checks org/user, vault, operation, and feature permissions.
4. The relay routes the request through the active tunnel for the target vault.
5. The local server validates the request envelope and local vault state.
6. The local server performs the read, search, edit, move, or rename.
7. The local server updates files, runtime state, indexes, and audit logs.
8. The local server returns a response through the tunnel.
9. The relay returns the response and broadcasts any relevant client events.

## Data Custody

Customer knowledge content is not stored in the remote relay substrate at rest.
The relay necessarily sees enough metadata to route, authenticate, authorize,
and maintain sessions. The design should minimize logged request payloads and
avoid storing content bodies in relay databases or logs.

## Relationship To KB-1

KB-1 used remote D1/R2/Durable Object state as the knowledge substrate. KB-1
now uses the filesystem and daemon as the substrate. Cloud services coordinate
multi-user access without making the relay the durable content store. The local
open-source product remains useful without Cloud or relay.

## Open Questions

- What metadata is acceptable for the relay to store for routing, debugging, and
  analytics?
- Should remote request envelopes be opaque end-to-end to the relay when
  possible, or does the relay need structured operation visibility for policy?
- How should explicit tunnel takeover work when a user restarts a server or moves
  a vault to another machine?
- What offline or degraded web states should exist when a vault's local server
  is disconnected?
- Which local UI capabilities should keep improving after Local ships and the
  Cloud paths open?
