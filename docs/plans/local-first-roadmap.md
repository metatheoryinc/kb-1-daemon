# Local-First Roadmap

KB-2 should now optimize for a useful open-source local product before cloud
relay work begins.

The core idea is:

```text
Local UI + Local MCP/API -> Local daemon/server -> Filesystem vault
```

Cloud relay remains part of the long-term architecture, but the first sequence
of chunks should prove the local filesystem substrate and local user experience.

## Why This Shift

The local product gives KB-2 value earlier:

- users can run a filesystem-backed knowledge base without trusting a hosted
  content store
- the local UI exercises the same APIs that agents and future relay requests use
- local MCP tools become useful before cloud auth and tunnel routing exist
- Yjs and filesystem semantics can be proven before remote collaboration is
  introduced
- the open-source surface is a product, not just infrastructure

## Updated Execution Order

Chunk 001 established the daemon scaffold.

Recommended next chunks:

| Chunk | Goal |
|---|---|
| 002 | One daemon port serves both the Hono API and a SvelteKit local UI shell |
| 003 | One-file Markdown Yjs service over local API/WebSocket |
| 004 | Component library and Storybook seeded from KB-1 UI patterns/components |
| 005 | Minimal local editor UI wired to the one-file Yjs service |
| 006 | Direct filesystem write detection and loud save/conflict surfacing |
| 007 | Vault root configuration plus file tree/list/read APIs |
| 008 | Local MCP tools for read/search/edit against the same vault service |
| Later | Cloud relay, auth, orgs, paid collaboration gates, and cloud presence |

The exact chunk boundaries can change, but the ordering principle should hold:
prove local content authority and local UX before remote relay.

Chunks 003 and 004 are independent (daemon substrate vs frontend library) and
can be implemented in parallel once chunk 002 lands.

## KB-1 As Reference

KB-1 is mature and in daily production use, and most KB-2 concerns have a
KB-1 counterpart. Every chunk should ask "what does KB-1 already do here?"
before inventing: borrow algorithms, protocols, test patterns, and UI
patterns where they fit, and adapt deliberately where the custody model
differs (filesystem-canonical instead of hosted substrate). Chunk plans
should name the relevant KB-1 areas, and implementers should read them before
building. KB-1 is available as a sibling checkout of this repo; notable
areas: the vault-channel Durable Object and its frame protocol (Yjs document
sessions), `packages/@kb-1/collab-merge`, the MCP tools, the web app's
component/Storybook system, and the e2e co-editing specs.

## Invariants

- The local daemon/server remains the only legitimate runtime writer.
- The local UI must use local APIs, not direct filesystem reads or writes.
- Local MCP/API and local UI should share service boundaries.
- The filesystem remains canonical.
- Yjs is a runtime editing artifact, not durable storage.
- Direct filesystem writes are allowed but second-class and should produce
  warning events.
- Local-first KB-2 does not model users, cursors, selections, follow mode, or
  presence.
- Presence and awareness remain cloud collaboration features.

## Deferred Cloud Work

The following should remain deferred until local value is proven:

- cloud relay tunnel
- user auth
- organization management
- billing
- remote sharing policy
- cloud MCP/API routing
- cloud presence and cursors

Deferring these does not remove them from the architecture. It keeps the first
implementation path focused on the filesystem-backed product.

## Open Questions

- Should chunk 006 include only list/read APIs, or also initial vault creation?
- Should local MCP tools precede the UI if agent workflows are the fastest proof
  of value?
- Should the local UI use a full app framework from the beginning or a smaller
  static/client app hosted by the daemon?
