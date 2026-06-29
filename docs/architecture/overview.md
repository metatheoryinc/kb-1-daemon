# KB-1 Local Architecture Overview

KB-1 Local separates durable customer data from hosted coordination. Some
implementation names still say KB-2 (`KB2_*`, `kb2d`, and `@kb-2/*`) while the
product rename finishes; this document uses KB-1 Local for the product.

The local server owns content operations, filesystem materialization, local
agent access, and the local web UI. KB-1 Cloud owns authentication, relay
routing, billing, collaboration policy, Hosted operation, and ephemeral presence
for the full team experience. The Cloud-connected web app and Cloud APIs can
look similar to local KB-1 from a user and agent perspective, but self-hosted
content requests are proxied to the user's active local server instead of
resolved from a hosted D1/R2 storage substrate.

## High-Level Shape

```text
Local Web UI / Local MCP / Local API
        |
Open-source local KB-1 server (`kb2d`)
Vault API, Yjs runtime, search, audit, file watcher, materializer
        |
Local filesystem
Markdown, images, attachments, .kb2 metadata

Self-hosted full experience:

Cloud Web UI / Cloud MCP / Cloud API
        |
KB-1 Cloud layer
Auth, billing, relay registry, active sessions, permissions, presence
        |
Outbound WebSocket tunnel from local server
        |
Open-source local KB-1 server (`kb2d`)
Vault API, Yjs runtime, search, audit, file watcher, materializer
        |
Local filesystem
Markdown, images, attachments, .kb2 metadata
```

## Planes

KB-1 Local has two main runtime planes.

The content plane handles durable vault operations:

```text
Web/API/MCP -> Cloud Relay -> Local Server -> Filesystem
Local Web UI -> Local API -> Local Server -> Filesystem
Local agents -> Local API/MCP -> Local Server -> Filesystem
```

The awareness plane handles ephemeral collaboration state:

```text
Web clients -> Cloud realtime service -> Web clients
```

Presence, cursors, selections, and follow-mode state do not need to pass through
the local server unless they become durable product history. This keeps the local
server focused on content authority.

The local-only UI does not model Cloud users, cursors, selections, or presence.
It should show file and edit state clearly, including warnings when a file
changes outside the service-mediated editing path.

## Authority

The core authority rules are:

- A local server may host many vaults.
- A vault may have only one active authoritative local server connection.
- The cloud rejects or explicitly manages takeover when a second local server
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

For a later remote read or edit:

1. A web client, cloud MCP client, or cloud API client calls the cloud.
2. The cloud authenticates the caller.
3. The cloud checks org/user, vault, operation, and feature permissions.
4. The cloud routes the request through the active tunnel for the target vault.
5. The local server validates the request envelope and local vault state.
6. The local server performs the read, search, edit, move, or rename.
7. The local server updates files, runtime state, indexes, and audit logs.
8. The local server returns a response through the tunnel.
9. The cloud relays the response and broadcasts any relevant client events.

## Data Custody

Customer knowledge content is not stored in the hosted cloud substrate at rest.
The cloud necessarily sees enough metadata to route, authenticate, authorize,
bill, and maintain sessions. The design should minimize logged request payloads
and avoid storing content bodies in cloud databases or logs.

## Relationship To KB-1

The older hosted KB-1 app used hosted D1/R2/Durable Object state as the
knowledge substrate. KB-1 Local uses the filesystem and local server as the
substrate. Cloud remains central to the full team experience, but Cloud does not
automatically become the durable content store. In self-hosted full experience,
the user's machine remains the vault home. In Hosted full experience, KB-1
operates the vault engine and stores the hosted vault because managed hosting is
the point.

## Open Questions

- What metadata is acceptable for the cloud to store for routing, billing,
  debugging, and analytics?
- Should cloud request envelopes be opaque end-to-end to the relay when possible,
  or does the cloud need structured operation visibility for policy?
- How should explicit tunnel takeover work when a user restarts a server or moves
  a vault to another machine?
- What offline or degraded web states should exist when a vault's local server
  is disconnected?
- Which local UI capabilities should keep improving after the simultaneous
  Local/Cloud launch?
