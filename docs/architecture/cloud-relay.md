# Remote Relay Boundary

Remote relay is an optional remote-access and collaboration layer for KB-1
Local. It keeps the KB-1-style web, API, and MCP experience while durable
content storage stays on the user's local server.

Cloud relay is not required for the first useful local KB-1 product. The
open-source local service can host a local web UI and local MCP/API tools before
remote relay is enabled. The local product should remain useful over localhost
and private networks without requiring any remote account.

## Responsibilities

The cloud layer owns:

- user and organization authentication
- API key and device registration
- active tunnel registry
- per-vault routing
- permissions and feature gates
- cloud MCP/API endpoints
- web app delivery
- ephemeral presence, cursors, selections, and follow-mode state
- relay observability that avoids storing content payloads

It does not own customer vault content at rest.

## Tunnel Model

The local server establishes an outbound WebSocket connection to the cloud. The
outbound connection avoids requiring users to expose inbound ports.

```text
Local Server -> Cloud Relay
```

The connection is authenticated by a key or credential generated for the owning
user or organization. The cloud binds the tunnel to one or more vaults served by
that server.

## Active Authority

For each vault, the cloud should accept only one active authoritative local
server connection. If another server attempts to connect for the same vault, the
cloud should reject it or require an explicit takeover flow.

The server-level connection can host many vaults, but routing and authorization
remain per vault.

## Permission Checks

Every edge should check permissions:

- requester authentication
- user or organization membership
- vault access
- operation permission: read, search, write, admin
- collaboration policy
- tunnel authority for the target vault
- request envelope validity at the local server

The open-source local app should remain useful without a remote account.
Collaboration policy can enable other users to read, write, or collaborate in
shared vaults.

## Content Plane

Content operations route to the local server:

```text
Cloud API/MCP/Web request
  -> auth and policy
  -> relay envelope
  -> active vault tunnel
  -> local server operation
  -> response
```

The cloud should avoid logging content payloads. It may need operation metadata
for routing, authorization, metrics, and debugging.

## Awareness Plane

Presence, cursors, selections, and follow-mode can live in the cloud layer:

```text
Web client -> Cloud realtime service -> Web clients
```

The local server does not need cursor state to perform content writes. The cloud
already knows authenticated users and connected browser sessions, making it the
natural place for ephemeral awareness.

The local-first UI intentionally does not implement presence. If a local user is
editing a document and some other local process or agent changes that file, the
local product should surface a file-change event or direct-write warning rather
than attempting to show remote cursors or user presence.

## Collaboration Policy

The cloud can enforce collaboration policy without changing the open-source
local server:

- individual owner access
- owner-owned agents
- read-only org members
- write-capable org members

The local server still validates that relayed requests are well-formed and belong
to a registered vault, but collaboration policy belongs in the relay layer.

## Open Questions

- Are cloud relay envelopes content-visible to the cloud service, or can some
  payloads be encrypted so the cloud only routes them?
- What metadata can be safely logged for debugging without weakening the data
  custody promise?
- What does tunnel takeover look like in the web UI?
- What guarantees do cloud APIs provide when a vault server is offline?
- What, if anything, should the cloud presence layer know about edits that
  originated in the local-only UI before a relay session exists?
