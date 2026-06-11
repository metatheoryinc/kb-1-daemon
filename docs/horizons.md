# KB-2 Horizons

## Near horizon

- **Relay de-risk spike** (likely next): bootstrap private `kb-1-cloud`
  (submodule topology per narrative) and prove the CF Worker/DO tunnel —
  HTTP through outbound WS, and the Yjs WebSocket relayed end-to-end with
  two browsers on the cloud URL. Deliverable: latency numbers + the list of
  CF limits hit. Needs the user's Cloudflare/wrangler auth.
- **Repo rename step 1**: kb-2 → kb-1-daemon (awaiting user go; zero-risk
  via redirects).
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
