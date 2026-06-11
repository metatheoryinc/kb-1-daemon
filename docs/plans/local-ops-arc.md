# Local Ops Arc: Vault Service Layer, API, and MCP

The daemon grows from "one file with a great editor" into a full local vault
product: a single service layer owning every vault operation, consumed by the
Hono API, the web UI, and (later) MCP tools and the cloud relay. This doc
fixes the essential-operation set, its tiering, and the chunk boundaries.
Individual chunk plans carry the binding detail.

Inputs: KB-1's MCP tool inventory and service architecture (29 tools; service
functions shared by HTTP routes and MCP via RPC; metadata ops split from
content writes), and the Markdown-vault ecosystem survey (official Obsidian
CLI 1.12, NotesMD CLI, Local REST API plugin, mcp-obsidian +
obsidian-mcp-server). Both surveys converged on the same tier-1 core.

## Essential operations

| Tier | Operation | Notes |
|---|---|---|
| 1 | vault info | root, counts, config |
| 1 | list / tree | files+folders under path, recursive, depth/filter/cap |
| 1 | read | content + stat (+ session state when live) |
| 1 | create / write | no-clobber default, `overwrite` flag |
| 1 | append / prepend | prepend = after frontmatter (ecosystem norm) |
| 1 | edit (anchored splice) | KB-1's contract: baseline state vector + old_text/new_text + before/after/occurrence; applied THROUGH the live session |
| 1 | delete | to `.kb2/trash/` by default, `permanent` flag |
| 1 | move / rename | rename = thin wrapper over move; live sessions rekey |
| 1 | mkdir / folder delete / folder move+rename | folder delete refuses non-empty unless `recursive` |
| 1 | search (+context lines) | substring/word scan first; ranked/indexed later |
| 2 | frontmatter key get/set/remove | per-key, not YAML round-trips |
| 2 | tags list / per-note ops | frontmatter + inline forms |
| 2 | outline / document map | headings tree; pairs with anchored edits |
| 2 | attachments (list/read/upload) | needs asset story |
| 2 | audit log read (list/read changes) | write-side lands in tier 1 chunks |
| 3 | backlinks / links / orphans / unresolved | needs link index; move/rename link-REWRITING joins it |
| 3 | tasks, daily notes, templates | app-flavored; may stay out of the daemon |
| 3 | history/diff/restore | git's job in a local-first vault |

User ruling 2026-06-11: backlinks-class features are secondary. Tier 1 is
the committed surface; tier 2 by demand; tier 3 deferred.

## Decisions that shape everything

- **Path is identity.** No noteId registry: the filesystem is durable truth,
  and a registry would be derived state pretending to be load-bearing.
  Consequence: rename/move must handle live sessions explicitly (KB-1 dodges
  this with stable noteIds; we cannot).
- **Sessions rekey on move/rename, invalidate on delete.** Move/rename keeps
  the live Y.Doc (no content loss, no reconnect): the session moves to the
  new path key, persistence targets the new file, clients get a `doc-moved`
  event and follow. Delete tears the session down: clients get `doc-deleted`
  (loud, editor read-only). Both events are content-state events, not
  presence (content-not-people).
- **Edits flow through the session.** The splice contract hydrates a session
  if none is live and applies through Y.Text — never a bypass write to disk
  (single-writer; CRDT-merges with concurrent typing instead of racing it).
- **Move/rename does NOT rewrite links yet.** The ecosystem norm is
  move-updates-links; doing it without a link index is silent corruption
  risk done badly. Deferred to the link-index chunk (tier 3), documented
  loudly in API/tool descriptions.
- **Mutations write an audit row** to an append-only JSONL log under
  `.kb2/` with actor fields (`actor`, `source`; "unknown local caller" is
  acceptable) — the storage language the content-not-people exception
  requires, ready for MCP and relay attribution.

## Chunk boundaries

- **007 — vault service layer + file/folder ops + live-session semantics.**
  `packages/vault-core` (validation, CRUD, move/rename, trash), multi-file
  doc sessions with rekey/invalidate, Hono API routes, minimal UI path
  routing (`/<path>` opens that file — needed to browser-verify rename
  semantics), audit JSONL. Plan: `chunk-007-vault-service-and-file-ops.md`.
- **008 — agent write/read surface.** Anchored splice + append/prepend over
  the API, search with context lines, structured read (stat + frontmatter).
  Plan authored when 007 ships.
- **009 — local MCP server.** MCP endpoint hosted by the daemon, tools
  mapping 1:1 onto the service layer (same functions the routes call),
  actor attribution `mcp_client`. Plan authored when 008 ships.

UI file tree, tier-2 ops, and link index are separate later chunks.
