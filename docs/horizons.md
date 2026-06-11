# KB-2 Horizons

## Near horizon

- **Cloud-002 — relay de-risk spike IS RUNNING** (cloud-001 shipped and
  merged 2026-06-11 same day: super-workspace + submodule topology proven —
  one graph typechecks both repos; mixins byte-identical; audited with one
  fix round). Plan: `kb-1-cloud/docs/plans/cloud-002-relay-spike.md`.
- **Cloud invariants convention** (commander, during cloud-002): kb-1-cloud
  gets its own `docs/architecture/invariants/` in the daemon's style —
  shared engineering invariants apply verbatim (frontend/Storybook
  especially), plus Cloudflare-specific ones: DOs compose the battle-tested
  mixins (storage/hibernation/alarms never hand-rolled), DO concurrency
  stays simple and unpoked, state survives eviction via the storage mixin.
  Commander-authored; AGENTS.md points at them.
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

- Cloud relay (outbound tunnel, vault authority, takeover flows).
- Auth, orgs, billing, collaboration gates.
- Presence/awareness plane (cloud-side), agent attribution UI.
- KB-1 content import/migration.
