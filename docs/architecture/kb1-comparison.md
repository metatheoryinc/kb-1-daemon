# KB-1 Local Comparison

KB-1 Local preserves the original hosted KB-1 ambition while changing the
custody and authority model. Some implementation/package names still say KB-2
while the product rename is in progress; public-facing language should say
KB-1 Local, KB-1 Cloud relay, and KB-1 Cloud Hosted.

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

## What KB-1 Local Preserves

KB-1 Local should preserve:

- Markdown-centered knowledge work
- a rich web UI
- a useful local web UI that works without Cloud login
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

## What KB-1 Local Changes

The central change is custody.

| Concern | Hosted KB-1 | KB-1 Local |
|---|---|---|
| Durable content | Hosted D1/R2/DO substrate | User filesystem |
| Cloud role | Source of truth and app backend | Paid relay, Hosted, auth, policy, presence |
| Local role | Optional desktop wrapper | Authoritative vault server and local app host |
| Open source surface | Optional/unclear | Local server and local UI are the public open-source foundation |
| Multi-tenancy | Shared hosted storage substrate | Tenant content outside hosted storage |
| Document identity | Migrated toward stable note IDs | Path-keyed initially because files are canonical |
| Awareness | Cloud/realtime substrate | Cloud presence plane can remain separate |
| Data loss posture | Hosted service owns more risk | User owns storage/backup; service owns write correctness |

## Why Path Identity Is Acceptable Again

KB-1 moved from path identity to stable note IDs because path became metadata.
KB-1 Local makes the filesystem canonical, so path is once again a meaningful
durable address.

This does not mean moves are casual. Move and rename must be explicit operations
with invalidation and client rebinding. External moves can be detected
best-effort and surfaced as warning events.

## Why Git Is Not The Product Audit Log

Git is valuable for backup, diffs, rollback, and user-owned remotes. It is not
ideal as the only source of product history because product events and Git
commits have different cadence and semantics.

KB-1 Local should maintain an append-only local audit log and optionally
summarize that history into Git commits.

## Better Multi-Tenant Posture

KB-1 placed all tenants into one hosted data substrate. Even with correct
authorization, that means the SaaS operator owns more data custody, backup,
isolation, migration, and breach surface.

KB-1 Local removes customer knowledge content from the hosted substrate. KB-1
Cloud still needs account and routing metadata for relay, and Hosted stores a
tenant's vault because managed hosting is the point. The default path keeps the
user's actual vault content with the user.

## Local Product With Optional Cloud Paths

KB-1's primary useful experience depended on the hosted app and hosted substrate.
KB-1 Local is useful without that hosted substrate: the open-source local server
hosts a local UI for file-tree browsing and Markdown editing, while local agents
use local MCP/API tools against the same service.

This changes the custody model, not the full team ambition. KB-1 Cloud relay,
auth, org management, billing, presence, and Hosted vaults launch as remote and
multi-user layers around the same service contract. Local-only users do not need
Cloud login; self-hosted full-experience users do.

## Open Questions

- Which KB-1 MCP tools should be carried over exactly, and which should change
  because the filesystem is canonical?
- Which KB-1 collaboration affordances are essential for the first KB-1 Local demo?
- Which local UI affordances should replace hosted collaboration affordances in
  the first local-only demo?
- Which KB-1 architectural docs should be treated as source inspiration versus
  migration cautionary tales?
- How much KB-1 import/migration support should KB-1 Local plan for?
