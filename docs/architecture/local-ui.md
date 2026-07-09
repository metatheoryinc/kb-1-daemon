# Local UI

The local UI is the first open-source user experience for KB-1. It is served by
the local daemon/server in production-like runs and proxied through the daemon
during Vite development. It talks to the local server APIs and does not read or
write the filesystem directly.

## Purpose

The local UI lets KB-1 become useful before remote relay, auth, org management,
or collaboration services exist.

The shipped local product lets a single local user:

- discover, create, rename, and delete filesystem-backed vaults
- browse vault-scoped file trees
- open Markdown files
- edit Markdown through service-mediated writes
- see when files change outside the current editor path
- search local content
- work from a zero-vault state after deleting every vault
- view Git-backed best-effort note history for a selected note

This same local API surface should be exercised by local MCP tools and later by
cloud relay requests.

## Non-Goals

The local UI should not include:

- authentication
- users
- organizations
- remote account administration
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
- a direct filesystem write bypassed KB-1 and caused a reload
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

Every content route is explicitly vault-scoped. The UI discovers vaults with
`GET /api/vaults` and then addresses content with routes such as
`/api/vaults/:id/tree`, `/api/vaults/:id/files/{path}`,
`/api/vaults/:id/raw/{path}`, and `/api/vaults/:id/events`. A missing or
unknown vault id is a normal not-found state, not a fallback to a default vault.

## Current Scope

- multi-vault file tree grouped by vault id/display name
- main Markdown editor or reader
- visible current path
- save/edit state
- direct-write warning state
- health/status surface for the daemon
- vault CRUD controls
- search
- note history panel
- attachment-aware tree/read routes through the daemon API

## Open Questions

- How should the UI represent an MCP/API edit when no user identity exists?
- Should local UI access require localhost-only binding at first?
- Should `docs/daemon/**` become a canonical public docs namespace, or should
  public docs stay under `docs/architecture/**` plus packaging docs?
