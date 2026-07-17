# Remote Relay Boundary

Remote relay is an optional daemon-side feature for connecting KB-1 Local to a
relay endpoint. Durable vault content remains on the user's local server. The
open-source daemon, local web UI, REST API, and MCP endpoint remain useful over
localhost or a private network without any relay configured.

KB-1 Cloud relay and Hosted are not yet publicly available. The protocol and
configuration below document how the daemon integrates with those services
when they are enabled.

This document describes the public daemon contract. The server behind the relay
endpoint may be a private cloud service, but its hosting, product policy, and
commercial model are outside this repository.

In the KB-1 product, KB-1 Cloud supplies the identity, organization, routing,
and collaboration layer around this contract. The local daemon itself has no
Cloud user or organization model and is not a multi-user team product on its
own. Local-only use needs no Cloud login; connecting to KB-1 Cloud relay enables
approved users and agents to reach a self-hosted daemon from beyond its machine
or private network. Hosted mode uses the same Cloud layer with a KB-1-operated
daemon.

## Daemon Configuration

Relay is enabled by supplying `KB1_RELAY_URL` and `KB1_RELAY_TOKEN` together.
Supplying only one is a startup configuration error. `KB1_DAEMON_VERSION` and
`KB1_DAEMON_BUILD` are optional daemon identity metadata sent to the relay during
registration.

When relay config is present, the daemon starts its local HTTP server and then
opens an outbound WebSocket connection to the relay endpoint. Users do not need
to expose inbound ports. A relay URL may include a path prefix; the tunnel client
preserves that prefix and appends the internal tunnel paths.

```text
KB-1 daemon -> outbound WebSocket -> relay endpoint
```

## Internal Tunnel Paths

The daemon-side tunnel client uses stable KB1 wire paths:

- `/__kb1_tunnel/control`: long-lived control WebSocket
- `/__kb1_tunnel/dialback`: dial-back WebSocket path for relayed WebSocket
  streams

These are internal relay paths, not local daemon routes. The local daemon routes
for operator control live under `/api/relay/*`.

## Local Lifecycle Routes

The daemon exposes a small relay lifecycle API:

- `GET /api/relay/status`
- `POST /api/relay/connect`
- `POST /api/relay/disconnect`

`GET /api/relay/status` always returns `200` with:

```json
{
  "ok": true,
  "relay": {
    "configured": true,
    "started": true,
    "controlConnected": true,
    "reconnectScheduled": false
  }
}
```

The `relay` status fields are:

- `configured`: both relay env vars were supplied at daemon startup
- `started`: the tunnel client has been started and has not been stopped
- `controlConnected`: the control WebSocket is currently open
- `reconnectScheduled`: the control socket closed and the client has a retry
  timer scheduled

When relay is not configured, status remains readable with all fields `false`.
`POST /api/relay/connect` returns `409` with `relay_not_configured`; `POST
/api/relay/disconnect` returns a successful no-op status.

## Request Model

The relay forwards work to the daemon over the outbound tunnel. HTTP requests
use the same local REST surface as direct clients, and relayed WebSocket streams
are bridged to the matching daemon WebSocket path. Relay RPC currently includes
`vault.list` for vault discovery.

There is no default vault over the relay. Callers first discover vaults, then
address a specific vault id with the normal `/api/vaults/:id/...` routes.

Relayed writes can attribute the upstream actor with `x-kb1-actor`. The header
value is a JSON object with `kind: "user"` or `kind: "integration"` and optional
`id`, `name`, and `client` strings. If the header is absent, the daemon uses
`KB1_ACTOR_DEFAULT` for local attribution.
