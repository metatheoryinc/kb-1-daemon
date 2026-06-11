# Chunk 009: Local MCP Server

## Purpose

Agents become first-class vault clients: the daemon hosts an MCP server
whose tools map 1:1 onto the chunk-007/008 service surface — same service
boundary as the UI and REST API (single-writer), with `mcp_client` actor
attribution in the audit log. This completes the local-ops arc
(`docs/plans/local-ops-arc.md`).

## Starting Context

main has 001-008: vault-core (CRUD/move/trash/search/splice primitives),
path-keyed sessions with rekey/doc-deleted/idle-GC and persist-failure
surfacing, REST routes with the full error taxonomy, audit JSONL with
actor fields.

## KB-1 Reference (read before building)

- `apps/@kb-1/mcp/src/tools/` — tool naming, input schemas, description
  style, and error-message mapping (especially `edit-note.tool.ts`'s
  stale_doc/ambiguous handling — agents must receive the structured detail
  verbatim).
- `apps/@kb-1/mcp/src/mcp-server.ts` — server/tool registration shape.
  KB-1's OAuth/worker transport does NOT transfer (we are a local daemon).

## Decisions

- **Transport: streamable HTTP at `/mcp` on the daemon's single port.** The
  daemon is a long-running localhost server; HTTP MCP is its natural shape
  and modern clients (Claude Code et al.) speak it. No separate process,
  no stdio adapter in this chunk (non-goal; revisit on demand). The
  endpoint inherits the daemon's loopback-only exposure — the plan asserts
  (and a test verifies) the daemon binds 127.0.0.1.
- **SDK: official `@modelcontextprotocol/sdk`** (exact-pinned). No
  hand-rolled JSON-RPC/SSE (battle-tested-over-hand-rolled).
- **Tools (tier 1, thin glue over the same service functions the routes
  call — NOT HTTP self-calls):**
  - `vault_info` — root name, counts.
  - `list_files` — tree/list under a path (depth, caps mirrored from API).
  - `read_note` — content + stat + `baseline` (the edit-loop token).
  - `create_note` — no-clobber; `overwrite` flag.
  - `edit_note` — the 008 splice contract verbatim: baseline, old_text,
    new_text, before/after/occurrence; stale_doc echoes current content +
    fresh baseline; ambiguous includes match_count; size caps;
    persist_failed surfaces loudly.
  - `append_note` (creates-if-missing), `prepend_note` (after
    frontmatter).
  - `delete_note` — trash by default, `permanent` flag.
  - `move_note` — move/rename; description states links are NOT rewritten.
  - `create_folder`, `delete_folder` (recursive flag), `move_folder`.
  - `search` — query, under, context lines, pagination; truncation
    signaled.
  Tool descriptions carry the contract semantics so agents self-serve
  (the stale_doc retry loop especially).
- **Attribution**: every mutation's audit row gets
  `actor: {kind: "mcp_client", client: <clientInfo.name>}` from the MCP
  initialize handshake ("unknown local caller" fallback honored). Reads
  and search append nothing (consistent with 008).
- **Errors**: service taxonomy maps to MCP tool errors with the structured
  detail in the content (stale_doc with body+baseline, ambiguous with
  count, persist_failed loud) — KB-1's pattern of letting agents route on
  codes, not prose.
- **Package shape**: `packages/local-mcp` owning tool definitions +
  registration (single responsibility, unit-testable with an injected
  service facade); the daemon app mounts it. Mirrors the
  package-composed-monorepo invariant's own example list.
- **Session interaction**: MCP edits flow through the same sessions —
  browser tabs see MCP splices live (and vice versa), idle GC and
  persist-failure semantics apply unchanged.

## Acceptance Criteria

1. `packages/local-mcp` exists (no transport beyond the SDK server object;
   daemon mounts it at `/mcp`); daemon still binds loopback only (tested).
2. A real MCP client (SDK client in tests; `@modelcontextprotocol/
   inspector` or an SDK script for manual verification) completes the full
   edit loop end-to-end against a live daemon: initialize → read_note
   (baseline) → edit_note → stale retry path → re-read shows the edit;
   disk dual-asserted.
3. Every tool exercised end-to-end at least once in integration tests
   (create/list/read/edit/append/prepend/delete/move/folders/search/
   vault_info) with dual assertion on mutations.
4. Audit rows for MCP mutations carry `kind: "mcp_client"` and the client
   name from the handshake; REST mutations still log `user`; reads/search
   log nothing (tested).
5. Live co-editing: a real browser tab typing while an MCP edit_note lands
   on the same doc — both survive, CRDT-merged (the 008 criterion-4 drill,
   now through MCP) — browser-verified with typing straddling the edit.
6. Error fidelity: stale_doc returns current content + fresh baseline
   through MCP; ambiguous returns match_count; persist_failed (read-only
   dir repro) surfaces as a loud tool error with NO success audit row —
   all tested.
7. move_note/move_folder rekey live sessions (MCP-triggered move while a
   tab is open follows correctly — verified).
8. 007/008 behaviors regress clean; REST surface unchanged.
9. Arc testing bar: real temp fs, dual assertion, coverage gates wired
   (`packages/local-mcp` ≥95% lines — it is thin glue; vault-core stays
   100%); property tests not required for pure mapping code but the splice
   contract suite must run against the MCP path too (shared test table).
10. `pnpm check -- --skip-nx-cache` green; temp homes; processes killed;
    docs: README gains an "MCP" section with client config (Claude Code
    `claude mcp add --transport http`) and the tool list.
11. Non-goals respected.

## Testing Expectations

Per the arc bar. The hearts: the SDK-client integration suite (criterion
2/3), attribution rows (criterion 4), error fidelity incl. the read-only
persist_failed repro through MCP (criterion 6), and the browser straddle
drill (criterion 5).

## Manual Verification

```bash
pnpm install && pnpm check -- --skip-nx-cache
KB2_HOME=$(mktemp -d) KB2_PORT=<free> pnpm dev:daemon
npx @modelcontextprotocol/inspector   # connect to http://127.0.0.1:<port>/mcp
# read_note → edit_note with its baseline → re-read; cat the file
# open the doc in a browser tab; run edit_note while typing → both land
# delete_note → file in .kb2/trash; audit log shows mcp_client rows
```

## Verification

- Implementer runs the manual flow including the browser straddle drill
  and reports what was visibly observed (in the editor AND in the
  inspector/client output).
- A fresh audit subagent in an isolated worktree re-runs everything: full
  check, gate negative-test, its own SDK-client drills against its own
  daemon (edit loop, error fidelity, attribution, persist_failed repro),
  the browser straddle drill, and verdicts against all criteria and all
  nine invariants (single-writer scrutiny: no tool may touch the
  filesystem except through the shared services).
- Deviations listed explicitly.

## Non-Goals

- No stdio transport, no MCP resources/prompts/sampling — tools only.
- No auth on the MCP endpoint (localhost trust, same as REST; cloud relay
  exposure of MCP is a future, gated decision).
- No new vault operations — 009 maps the existing surface; tier-2 ops
  (frontmatter keys, tags, outline) remain future chunks.
- No link rewriting, no backlinks.
- No UI changes.
