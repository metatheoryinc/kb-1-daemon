# KB-1 Comparison

KB-2 preserves KB-1's ambition while changing the custody and authority model.

## KB-1 Summary

KB-1 is a hosted, agent-consumable Markdown vault. It preserves an
Obsidian-like information architecture while giving humans and agents shared
access through web, API, and MCP surfaces.

The KB-1 architecture uses a Cloudflare-hosted substrate:

- SvelteKit web app
- Hono API
- MCP server
- Tauri desktop wrapper
- Durable Object per vault for realtime collaboration
- Yjs/Y.Text active document state
- D1 metadata
- R2 version/content storage
- TanStack Query and client state in the web app

KB-1's core visible model is:

```text
Organization -> Vault -> Folder -> Markdown file
```

Its key product idea is cloud Obsidian for humans and agents, with reduced sync
friction and a first-class MCP/tooling surface.

## What KB-2 Preserves

KB-2 should preserve:

- Markdown-centered knowledge work
- a rich web UI
- MCP/API access for agents
- service-mediated reads and writes
- splice edits and structured content operations
- move and rename operations
- search
- Yjs-backed active collaboration
- visible humans and agents
- presence and follow-mode style affordances
- folder colors and presentation metadata
- one canonical write path for browsers and agents
- strong architecture docs and substrate invariants

## What KB-2 Changes

The central change is custody.

| Concern | KB-1 | KB-2 |
|---|---|---|
| Durable content | Hosted D1/R2/DO substrate | User filesystem |
| Cloud role | Source of truth and app backend | Auth, relay, web, policy, presence |
| Local role | Optional desktop wrapper | Authoritative vault server |
| Open source surface | Optional/unclear | Local server should be open source |
| Multi-tenancy | Shared hosted storage substrate | Tenant content outside hosted storage |
| Document identity | Migrated toward stable note IDs | Path-keyed initially because files are canonical |
| Awareness | Cloud/realtime substrate | Cloud presence plane can remain separate |
| Data loss posture | Hosted service owns more risk | User owns storage/backup; service owns write correctness |

## Why Path Identity Is Acceptable Again

KB-1 moved from path identity to stable note IDs because path became metadata.
KB-2 makes the filesystem canonical, so path is once again a meaningful durable
address.

This does not mean moves are casual. Move and rename must be explicit operations
with invalidation and client rebinding. External moves can be detected
best-effort and surfaced as warning events.

## Why Git Is Not The Product Audit Log

Git is valuable for backup, diffs, rollback, and user-owned remotes. It is not
ideal as the only source of product history because product events and Git
commits have different cadence and semantics.

KB-2 should maintain an append-only local audit log and optionally summarize that
history into Git commits.

## Better Multi-Tenant Posture

KB-1 placed all tenants into one hosted data substrate. Even with correct
authorization, that means the SaaS operator owns more data custody, backup,
isolation, migration, and breach surface.

KB-2 removes customer knowledge content from the hosted substrate. The cloud
still needs account and routing metadata, but the user's actual vault content
lives with the user.

## Open Questions

- Which KB-1 MCP tools should be carried over exactly, and which should change
  because the filesystem is canonical?
- Which KB-1 collaboration affordances are essential for the first KB-2 demo?
- Which KB-1 architectural docs should be treated as source inspiration versus
  migration cautionary tales?
- How much KB-1 import/migration support should KB-2 plan for?
