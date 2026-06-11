# KB-2 Horizons

## Near horizon

- **Cloud-002 SHIPPED — relay thesis PROVEN** (2026-06-11; cloud-001 also
  shipped same day). Findings + GO verdict:
  `kb-1-cloud/docs/spikes/cloud-002-relay-findings.md`. Next decisions are
  the user's: graduate `cloud-002-spike` (tunnel-protocol → daemon main PR,
  mixin `onAccept` hook → KB-1 upstream candidate, restore submodule pin to
  main), and green-light the real relay prototype (lifecycle, backpressure,
  initial-sync fix, auth).
- **Cloud invariants convention: DONE** (2026-06-11) — kb-1-cloud has
  `docs/architecture/invariants/` with cloud-never-stores-vault-content and
  durable-objects-compose-mixins; daemon engineering invariants inherited
  verbatim; AGENTS.md points at them.
- **Chunk 007 SHIPPED** (2026-06-11): vault-core service layer, multi-file
  sessions with rekey-on-move and loud doc-deleted (external deletion now
  maps there too — deferred decision resolved), vault REST API, audit
  JSONL, UI path routing. One audit fix round (keepFocus keystroke drop,
  lying 404 on non-live folder ops, fast-diff PUT).
- **Chunk 008 SHIPPED** (2026-06-11): anchored splice (KB-1 contract),
  append/prepend, scan search, idle-session GC. Audit fix round closed a
  real data-loss path: persist failures now surface as persist_failed (no
  false audit rows) and GC refuses to drop undurable sessions.
- **Chunk 009 — local MCP server** (next to author) over the same service
  boundary: tools map 1:1 onto the API surface, actor attribution
  mcp_client in the audit log.

## Mid horizon

- Search over local content — completes the "useful local product" promise.
- Dependabot hygiene pass — 6 open advisories on frontend dep trees.
- Provider reconnect + offline/read-only mode — retires the temporary
  exception on the loud-saving invariant.
- Packaging polish: npm `kb2d` publishing, Docker image hardening.
- The kb-2 → KB-1 naming migration, when the user calls it.

## Far horizon

- Cloud relay (outbound tunnel, vault authority, takeover flows).
- Auth, orgs, billing, collaboration gates.
- Presence/awareness plane (cloud-side), agent attribution UI.
- KB-1 content import/migration.
