# FC-1518 RPC Library Fit Check

Status: Slice 1 fit check, authored 2026-06-25 PT.

## Question

Before hand-writing the typed relay transport package, should KB-1 use an
off-the-shelf RPC library for unary calls, stream framing, cancellation,
timeouts, and errors?

## Relay Requirements

The library must fit this shape without making the architecture fight it:

- Cloudflare Durable Object, browser, and daemon compatibility.
- Daemon dials out to the relay; cloud does not connect directly to a daemon
  listener.
- Unary request/response with correlation ids, deadlines, cancellation, typed
  errors, and bounded pending work.
- Bidirectional stream frames for document sync and future long-lived flows.
- Daemon-origin events through `OrgChannel`.
- Binary or opaque payload support for Yjs/document bytes.
- A clean capability boundary: the browser sends cloud intent, while
  `OrgChannel` alone injects actor context and daemon-bound authority.

## Candidates

### Connect / gRPC-Style RPC

Useful shapes to borrow:

- type-safe service contracts;
- unary calls;
- deadlines, cancellation, metadata, status/error vocabulary;
- per-RPC ordering semantics from the gRPC model.

Why not adopt wholesale for this slice:

- Connect is explicitly regular HTTP under the hood, with gRPC/gRPC-web/Connect
  protocols and code-generated service clients.
- gRPC's full model has bidirectional streams and deadlines, but browser
  gRPC-Web does not support client-side or bidirectional streaming.
- The relay is not a normal browser-to-server RPC endpoint. The daemon dials
  outward to `OrgChannel`, and `OrgChannel` must perform admission, actor
  injection, hosted lifecycle policy, and fanout.

Sources:

- https://github.com/connectrpc/connect-es
- https://grpc.io/docs/what-is-grpc/core-concepts/
- https://github.com/grpc/grpc-web

### tRPC WebSockets

Useful shapes to borrow:

- JSON-RPC-like ids and response envelopes;
- WebSocket subscriptions;
- explicit `subscription.stop` cancellation shape;
- reconnect/tracked-event ideas for subscriptions.

Why not adopt wholesale for this slice:

- tRPC is an application RPC framework. It wants to own routers, procedures,
  clients, input/output serialization, and subscription semantics.
- Our shared package should be a low-level relay frame protocol that both
  daemon and cloud can compose. It must not define product procedures or make
  browser procedure names equivalent to daemon authority.
- tRPC subscriptions are server-to-client event streams, not the full
  bidirectional stream/data/cancel/event relay we need for daemon-bound document
  sync and daemon-origin events.

Sources:

- https://trpc.io/docs/server/subscriptions
- https://trpc.io/docs/server/websockets

### JSON-RPC 2.0 Shape

Useful shapes to borrow:

- transport-agnostic request/response ids;
- notifications;
- `result` versus `error` response separation;
- standard error object shape;
- batch/concurrent processing precedent.

Why not adopt as the whole protocol:

- JSON-RPC does not define stream open/data/close frames.
- It does not define backpressure, binary payload handling, per-stream limits,
  or hosted lifecycle semantics.
- Notifications are not confirmable, which is a bad default for many
  daemon-bound operations.

Source:

- https://www.jsonrpc.org/specification

## Decision

Do not adopt a full RPC framework for Slice 1. Evolve
`@kb-2/tunnel-protocol` into a small shared relay frame package and borrow the
boring proven parts:

- JSON-RPC-like correlation ids and error separation for unary calls.
- gRPC-inspired deadlines, cancellation, and per-stream ordering semantics.
- Explicit `stream.open`, `stream.data`, and `stream.close` frames for
  bidirectional flows.
- Explicit event frames for daemon-origin fanout.
- Closed typed error codes and named limits.

This keeps the package small and testable while avoiding a square-peg framework
fit. Revisit this decision if a later slice finds a library that can provide
the transport core without taking over product capability routing.
