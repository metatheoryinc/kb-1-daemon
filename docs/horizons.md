# KB-2 Horizons

## Near horizon

- **Cloud-001 — kb-1-cloud scaffold** (next, plan authored 2026-06-11 at
  `kb-1-cloud/docs/plans/cloud-001-scaffold.md`): super-workspace with this
  repo as `local/` submodule, Cloudflare apps borrowed wholesale from KB-1
  (wrangler, Hono, DO mixins with storage/hibernation, better-auth,
  SvelteKit SPA), AGENTS.md submodule contract. Cloud chunks get their own
  numbering in the private repo.
- **Cloud invariants convention** (right after cloud-001 merges): kb-1-cloud
  gets its own `docs/architecture/invariants/` in the daemon's style —
  shared engineering invariants apply verbatim (frontend/Storybook
  especially), plus Cloudflare-specific ones: DOs compose the battle-tested
  mixins (storage/hibernation/alarms never hand-rolled), DO concurrency
  stays simple and unpoked, state survives eviction via the storage mixin.
  Commander-authored; AGENTS.md points at them.
- **Cloud-002 — relay de-risk spike**: prove the CF Worker/DO tunnel — HTTP
  through outbound WS, and the Yjs WebSocket relayed end-to-end with two
  browsers on the cloud URL. Deliverable: latency numbers + the list of CF
  limits hit. Needs the user's Cloudflare/wrangler auth; owns first deploy.
  Placement (decided 2026-06-11): daemon-side spike code
  (`packages/tunnel-protocol` + spike tunnel client) lives on a
  `cloud-002-spike` branch off daemon; the cloud submodule pointer pins to
  it for the spike; the cloud worker imports tunnel-protocol through
  `local/`. Branch graduates to a daemon PR if the spike proves out.
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
