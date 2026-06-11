# KB-2 Horizons

## Near horizon

- **Chunk 006 — direct-write detection + loud saving** (next; plan:
  `docs/plans/chunk-006-direct-write-detection.md`). External edits to the
  managed file reload the session and warn every client; persistence
  failures surface loudly in the UI. Establishes the
  edits-save-or-fail-loudly invariant in product behavior.
- **Chunk 007 — vault root + file tree/read APIs.** One file becomes a
  browsable vault; wikilinks get somewhere to go.
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
