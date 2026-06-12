# Chunk 014: REST Actor Attribution

The daemon's audit layer already threads `VaultActor` through every vault
operation, and the local MCP server already derives a real actor from its
client info. The REST routes do not: every write is hardcoded
`actor: { kind: 'user' }` (`apps/daemon/src/app.ts`). Any external caller —
including the cloud front door proxying on behalf of signed-in users — has no
way to say who is acting. This chunk gives REST callers exactly one way to
supply it, and nothing more.

The daemon performs no authentication and no authorization. It trusts what
the caller supplies. Identity control is the front door's job
(cloud invariant: front-door-owns-identity); all enforcement complexity
stays cloud-side. The daemon's share of this feature is deliberately tiny:
one header, one parser, one fallback rule.

## Decisions

1. **One header.** REST callers may supply `x-kb2-actor` with a JSON value:
   `{ "kind": "user" | "integration", "id"?: string, "name"?: string,
   "client"?: string }`. It is honored whenever present — local external
   callers (scripts, tools) are expected to supply it too.
2. **`VaultActor` grows optional identity fields** `id?: string` and
   `name?: string`, and the kind union gains `'unknown'`. Audit JSONL rows
   carry whatever identity was supplied, automatically.
3. **Header kinds are restricted** to `user` and `integration`. `system` and
   `mcp_client` are reserved for internal derivation — a header claiming
   them is malformed (see 5). This keeps internal actor meanings honest.
4. **Absent header → mode-dependent default.** New env knob
   `KB2_ACTOR_DEFAULT` with values `user` (default; today's behavior — a
   bare local call is the local user) and `unknown` (hosted/relayed
   deployments set this; an anonymous call there is a contract breach by
   the front door and is recorded as `{ kind: 'unknown' }` rather than
   mislabeled as a user). One knob, two values, no other behavior change.
5. **Malformed header → loud 400** (`invalid_actor` through the existing
   one-failure-dialect shape). Missing is tolerated (decision 4); broken is
   not — a caller sending unparseable JSON, a disallowed kind, or an
   oversized payload (> 1 KiB) is a broken caller and must hear about it.
   (Flagged for user review: the user specified missing→unknown; the
   malformed→400 rule is the commander's extension of the loud-failure
   house style.)
6. **One shared helper.** A single `actorFromRequest(...)` lives next to the
   route layer; every REST handler that passes an actor uses it. No
   per-route parsing, no second pattern.
7. **Spoofing control is cloud-side and out of this repo.** The cloud front
   door must strip any inbound `x-kb2-actor` and inject its own (recorded
   as a cloud-004 requirement in the kb-1-cloud plan). The daemon does not
   attempt to distinguish forged headers — that is the trust model, stated
   plainly.

## KB-1 Reference

Before inventing parsing/validation shapes, check the KB-1 sibling checkout
for existing actor/attribution header conventions and mirror anything that
fits. In-repo references: `packages/local-mcp/src/server.ts` (actor
derivation), `packages/vault-core/src/audit.ts` (`VaultActor`, audit rows),
`apps/daemon/src/config.ts` (env knob pattern — see how `relay` config is
parsed and gated).

## Acceptance criteria

1. Every REST route that passes an actor to vault-service derives it via the
   shared helper; zero remaining `actor: { kind: 'user' }` literals in
   `apps/daemon/src/app.ts`.
2. Header present and valid → its actor (with `id`/`name`) appears in the
   API-visible result where applicable AND in the audit JSONL row on disk
   (dual assertion).
3. Header absent → `user` by default; `unknown` when
   `KB2_ACTOR_DEFAULT=unknown`. Both modes tested.
4. Malformed header (bad JSON / disallowed kind / oversized) → 400
   `invalid_actor` in the canonical failure shape; nothing written; no
   audit row.
5. MCP behavior unchanged (regression-asserted).
6. `pnpm check` green; coverage gates apply to the new helper (no
   exclusions).

## Testing expectations

Per tests-are-gated-and-real and the vault-ops convention: real filesystem,
dual assertion (API response + audit JSONL read from disk), negative tests
for each malformed class, and a spoof test (header claiming
`kind: "system"` → 400). No mocks of the vault layer.

## Manual verification

From a running daemon with a temp KB2_HOME: curl a write with a full actor
header, without a header in both modes, and with garbage — then read the
audit JSONL and report what is visibly recorded for each.

## Verification

Independent audit subagent re-runs everything from a fresh worktree: gates,
the curl matrix, audit-JSONL ground truth, a grep proving no literal actors
remain, and the quality dimension (helper is the single pattern; no
complexity added beyond the parser; file sizes sane).

## Non-goals

- No authentication, authorization, sessions, or tokens in the daemon.
- No per-edit attribution on the Yjs/WebSocket path (future chunk if the
  product needs it; collaborative-session attribution is a different shape).
- No cloud-side changes (the strip-and-inject rule is cloud-004 scope).
- No actor propagation to SSE change events or flush (they carry none today).
