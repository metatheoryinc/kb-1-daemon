# KB-2 Vision

KB-2 is a local-first, agent-ready knowledge base where users own the durable
data and the cloud coordinates access to it.

It keeps the best parts of KB-1: a rich web experience, MCP/API access for
agents, service-mediated writes, conflict-free collaborative editing, visible
human/agent participation, and a premium knowledge workspace feel. It changes
the trust boundary. KB-1 stored customer knowledge in the hosted substrate.
KB-2 makes the user's local filesystem the durable source of truth.

## Product Thesis

The user's vault should be plain files they can inspect, back up, commit, move,
and keep. KB-2 should provide the coordination layer around those files:
structured reads and edits, search, moves and renames, local and remote agent
tools, web access, presence, collaboration policy, and auditability.

The cloud should not be the place where customer knowledge lives at rest. The
cloud should provide authentication, billing, relay, session coordination,
presence, and collaboration gates. Content reads and writes should route to an
authoritative local KB-2 server owned by the user or organization.

## Core Shift From KB-1

KB-1 was cloud Obsidian for humans and agents: a hosted Markdown vault backed by
Cloudflare Workers, Durable Objects, D1, R2, and Yjs.

KB-2 is a user-owned vault node with cloud reachability: Markdown, images, and
attachments live on the user's filesystem; an open-source local server exposes a
structured vault API; the closed-source cloud relays authenticated web, API, and
MCP requests to that server.

## Principles

- The filesystem is the durable truth.
- Markdown and assets are canonical user data.
- The local KB-2 server is the only legitimate runtime writer.
- Yjs/Y.Text state is a runtime artifact for active collaborative editing, not
  the durable source of truth.
- Rebuildable indexes, caches, parsed metadata, and hot document sessions can be
  regenerated from the filesystem and local metadata.
- Cloud services relay and coordinate; they do not store customer knowledge
  content at rest.
- Permission checks happen at every edge.
- One vault has one active authoritative local server connection.
- One local server may host many vaults.
- Direct filesystem edits are valid but second-class: they bypass conflict-free
  collaboration and must be detected, reconciled, and surfaced to clients.
- The open-source local server should earn trust by making the custody boundary
  inspectable.

## Product Shape

Free individual users should be able to run the local server and use the cloud
relay for their own web and agent access. The web experience depends on the
relay and should be part of the core product, not only a paid feature.

Paid or organization tiers can unlock multi-user capabilities: other users
reading or writing a vault, richer collaboration policy, organization
permissions, and shared presence/collaboration features.

## What KB-2 Owns

KB-2 owns the coordination surface:

- local vault API
- local MCP/API access
- cloud relay API
- web UI access through the relay
- content operations such as read, search, splice edit, move, rename, and delete
- Yjs-backed active edit sessions
- folder presentation metadata
- audit/event history
- permission checks and feature gates
- direct-file-change detection and client warnings

KB-2 does not try to own the user's backups or durable storage medium. Git,
filesystem backups, and cloud drives can all be user-controlled strategies
around the plain vault files.

## Open Questions

- Which packaging targets matter first: CLI, Docker image, desktop app, or all
  three?
- Should Git support be built in from the beginning or introduced after the core
  local server and relay work?
- What is the first paid collaboration boundary: multi-user reads, multi-user
  writes, organization permissions, or presence?
- How much of the web UI can operate when the local server is offline?
- Should vaults begin path-keyed only, or should a hidden stable ID layer be
  reserved for future migrations?
