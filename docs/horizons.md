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
- **Chunk 007 — vault root + file tree/read APIs.** One file becomes a
  browsable vault; wikilinks get somewhere to go. Carries two deferred
  decisions: external file-deletion semantics, persist-failure state in
  late-joining clients beyond the bind replay.
- **Chunk 008 — local MCP tools** over the same vault service boundary.

## Mid horizon

- Search over local content — completes the "useful local product" promise.
- Dependabot hygiene pass — 6 open advisories on frontend dep trees.
- Provider reconnect + offline/read-only mode — retires the temporary
  exception on the loud-saving invariant.
- Packaging polish: npm `kb2d` publishing, Docker image hardening.
- The kb-2 → KB-1 naming migration, when the user calls it.

## Far horizon

- Hosted vaults (decided direction 2026-06-11, timing open): run the REAL
  daemon per tenant in scale-to-zero containers (Fly Machines / CF
  Containers / Fargate — pick via spike) behind the same relay; one
  implementation, per-tenant filesystem custody, kb-1-cloud as control
  plane (identity/billing/fleet). Rejected: reimplementing the daemon
  interface on shared D1/R2 (parallel implementation + custody break).
  Spike question when timely: durable volume story + idle economics.

- Cloud relay (outbound tunnel, vault authority, takeover flows).
- Auth, orgs, billing, collaboration gates.
- Presence/awareness plane (cloud-side), agent attribution UI.
- KB-1 content import/migration.
