# Local UI

The local UI is the first open-source user experience for KB-2. It is served by,
or alongside, the local daemon/server and talks to the local server APIs. It
does not read or write the filesystem directly.

## Purpose

The local UI lets KB-2 become useful before cloud relay, auth, org management,
or hosted collaboration exist.

The first local product should let a single local user:

- choose or configure a filesystem-backed vault
- browse the file tree
- open Markdown files
- edit Markdown through service-mediated writes
- see when files change outside the current editor path
- eventually search local content

This same local API surface should be exercised by local MCP tools and later by
cloud relay requests.

## Non-Goals

The local UI should not include:

- authentication
- users
- organizations
- billing
- remote sharing policy
- remote relay setup as a prerequisite for local use
- cursors
- selections
- follow mode
- presence

These belong to the later cloud-connected collaboration layer.

## Content Events Instead Of Presence

In the local-first product, it is acceptable that a file may change without the
UI showing another user's cursor or presence. The local system does not know
about users in the same way the cloud does.

Instead, the local UI should surface content state changes:

- a service-mediated edit changed the file
- an MCP/API caller changed the file
- a direct filesystem write bypassed KB-2 and caused a reload
- the file was moved, renamed, deleted, or recreated

For direct filesystem writes, the UI should use stronger language because the
change bypassed the conflict-free editing path. The intended behavior is a clear
warning, not a local presence model.

## API Boundary

The local UI must use the same local server boundary as other clients:

```text
Local UI -> Local HTTP/API -> Vault service -> Filesystem/Yjs runtime
```

This keeps the server as the only legitimate runtime writer and prevents the
local UI from becoming a parallel filesystem implementation.

## First Useful Scope

A useful first local UI can be intentionally small:

- left-side file tree
- main Markdown editor or reader
- visible current path
- save/edit state
- direct-write warning state
- health/status surface for the daemon

Search, Yjs-backed concurrent editing, MCP-driven change attribution, and richer
metadata can arrive in later chunks.

## Open Questions

- Should the UI be a separate workspace app or part of the daemon package?
- Should the daemon serve a built static UI in production and proxy a dev server
  in development?
- What is the smallest editor integration that still exercises the service write
  path correctly?
- How should the UI represent an MCP/API edit when no user identity exists?
- Should local UI access require localhost-only binding at first?
