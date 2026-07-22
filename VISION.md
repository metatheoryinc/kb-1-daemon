# KB-1 Vision

KB-1 is a local-first, agent-ready knowledge base where the durable vault home
is explicit. The open-source local runtime is useful on its own, with Cloud
identity, relay, collaboration, and hosting available as additive layers.

It keeps the best parts of KB-1: a rich web experience, MCP/API access for
agents, service-mediated writes, conflict-free collaborative editing, visible
human/agent participation, and a premium knowledge workspace feel. It changes
the trust boundary. KB-1 stored customer knowledge in the remote service
substrate.
KB-1 makes the user's local filesystem the durable source of truth.

## Product Thesis

The user's vault should be plain files they can inspect, back up, commit, move,
and keep. KB-1 should provide the coordination layer around those files:
structured reads and edits, search, moves and renames, local agent tools, a
minimal local web UI, remote access, presence, collaboration policy, and
auditability.

In the self-hosted relay path, remote services are not the place where customer
knowledge lives at rest. They provide authentication, relay, session
coordination, presence, and collaboration policy, while content reads and writes
route to an authoritative KB-1 server owned by the user or organization. In the
Hosted path, the same service contract runs in a KB-1 operated environment that
is intentionally the durable vault home.

## Core Shift

The original KB-1 architecture was cloud Obsidian for humans and agents: a
remote Markdown vault backed by Cloudflare Workers, Durable Objects, D1, R2, and
Yjs.

KB-1 daemon is a user-owned vault node that can stand alone locally or connect
to Cloud: Markdown, images, and attachments live on the user's filesystem; an
open-source local server exposes a structured vault API, local MCP/API access,
and a local web UI; Cloud relay can route authenticated web, API, and MCP
requests to that server.

## Principles

- The filesystem is the durable truth.
- Markdown and assets are canonical user data.
- The local KB-1 server is the only legitimate runtime writer.
- The local web UI must use the local server APIs; it must not read or write the
  filesystem directly.
- Yjs/Y.Text state is a runtime artifact for active collaborative editing, not
  the durable source of truth.
- Rebuildable indexes, caches, parsed metadata, and hot document sessions can be
  regenerated from the filesystem and local metadata.
- In self-hosted mode, remote services relay and coordinate without becoming the
  durable vault store. In Hosted mode, the managed environment is the selected
  vault home.
- Permission checks happen at every edge.
- One vault has one active authoritative local server connection.
- One local server may host many vaults.
- Direct filesystem edits are valid but second-class: they bypass conflict-free
  collaboration and must be detected, reconciled, and surfaced to clients.
- The local open-source product does not model users, cursors, selections, or
  presence. It models files, edits, and file-change events.
- Presence, cursors, selections, and follow-mode are cloud collaboration
  features, not local-first requirements.
- The open-source local server should earn trust by making the custody boundary
  inspectable.

## Product Shape

The local open-source product lets a user run the daemon/server, open a local
web UI, browse a file tree, read and edit Markdown, manage vaults and
attachments, inspect best-effort Git-backed note history, and let local agents
use MCP/API tools against the same filesystem-backed service.

Remote relay is an optional path, not the first path to value. KB-1 does not
require remote services before it becomes a useful local knowledge base.
Multi-user capabilities live in the Cloud layer: other users reading or writing
a vault, collaboration policy, organization permissions, and shared presence.

## What KB-1 Owns

KB-1 owns the coordination surface:

- local vault API
- local MCP/API access
- local web UI access through the daemon/server
- remote relay API
- web UI access through the relay
- content operations such as read, search, splice edit, move, rename, and delete
- Yjs-backed active edit sessions
- folder presentation metadata
- audit/event history
- permission checks
- direct-file-change detection and client warnings

For local and self-hosted vaults, KB-1 does not try to own the user's backup
medium. Git, filesystem backups, and cloud drives can all be user-controlled
strategies around the plain vault files. Hosted vaults instead use the managed
storage and durability contract of KB-1 Cloud.

## Remaining Questions

- Which packaging targets matter first: CLI, Docker image, desktop app, or all
  three?
- How much of the web UI can operate when the local server is offline?
- Should vaults begin path-keyed only, or should a hidden stable ID layer be
  reserved for future migrations?
