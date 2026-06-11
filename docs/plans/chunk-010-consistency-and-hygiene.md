# Chunk 010: Consistency And Hygiene

## Purpose

Pay the debts the first full code-health analysis found (fallow 88/A;
readability and whole-codebase invariant sweeps, 2026-06-11) while the
codebase is small enough for one person to hold. Behavior-preserving
throughout: no new features, no product-semantics changes. This chunk also
brings the codebase into compliance with the two new invariants it ships
alongside: `one-failure-dialect` and `tests-are-gated-and-real` (read both
first — they are the rubric for half this work).

## Starting Context

main has 001-009. Known findings, with exact locations, from the analysis
(treat these as the work list — every item below was independently
verified):

## Decisions

- **One failure dialect (the heart).** Unify vault-core's
  `{ok:false, error, message}` and splice/session's `{ok:false, rejected,
  ...}` into ONE typed result taxonomy per the new invariant: one
  discriminant field, closed union of codes, structured detail fields
  typed. Kill: the `as string` merge at `apps/daemon/src/app.ts:319`, the
  `(input: any)` at `packages/local-mcp/src/server.ts:203`, the
  `withoutOk` laundering at `apps/daemon/src/vault-service.ts:108`, and the
  `Record<string, unknown>` widenings (`session.ts:44`,
  `local-mcp/types.ts:31`). HTTP and MCP mappers become exhaustive
  switches. Live and cold paths for the same endpoint return the same
  shape (the live delete/move responses gain the audit metadata the cold
  path already returns). Wire-visible code VALUES do not change (agents
  depend on `stale_doc` etc.); this unifies shape and typing, not codes.
- **Extract `packages/vault-service`.** The app-level facade
  (`apps/daemon/src/vault-service.ts`, 349 lines + tests) has accreted
  reusable orchestration (live-vs-disk routing, baseline-edit
  orchestration, audit emission, failure mapping) and implements a
  packages/local-mcp type — it is package-shaped, and the relay will reuse
  it. Move it (and its tests) to `packages/vault-service`; the daemon app
  becomes wiring again. Resolves the package-composed finding without an
  exception entry.
- **Audit emission gets one chokepoint.** A single emit helper (in
  vault-service or vault-core — implementer picks the layer and documents
  why) through which BOTH the fs-op paths (`vault-core/index.ts:274, 301,
  346, 394, 456`) and live-session paths (`vault-service.ts:66, 110, 140,
  168`) flow, eliminating the near-duplicate 'write' rows and making
  skipped-audit drift structurally impossible.
- **Session.ts gets its concurrency contract written down** (comments, not
  refactors): one constraint block each for (1) what `pendingWriteHash`
  excludes (own-write vs external-edit discrimination), (2) why
  `materialize()` re-checks the disk hash before writing, (3) the
  persistLoop boolean-coalescing rule, (4) the path-transition promise
  protocol, (5) `moveSessionSubtree`'s shared-diskMove fan-out
  (`manager.ts:128-136`). Delete the unreachable `missingFromDisk`
  disjunct at `session.ts:585` and its impossible caller branch.
- **gray-matter resolution**: remove the never-imported dependency
  (`packages/vault-core/package.json:28`); keep the hand-rolled
  `frontmatterInsertionPoint` (offset-finding is the wrong job for a YAML
  parser — reconstructing offsets through gray-matter is worse glue) and
  write that justification as the invariant-required comment; add the same
  one-line justifications to `truncateUtf8` (`session.ts:699` — also hoist
  the per-char `TextEncoder`) and `normalizeWithRawOffsets`
  (`splice.ts:125`); rename the lying test at
  `vault-core/src/index.test.ts:435` to describe the scanner.
- **vault-core de-noising**: extract `statOrNull()` to replace the six
  cloned `stat().catch()` blocks (`index.ts:208, 235, 328, 371, 424`); fix
  or delete the drifted v8-ignore reasons (`index.ts:253, 312, 357` and
  sweep the rest — every reason must match its line per the new testing
  invariant); type the stringly `Error('entry_cap_exceeded')`
  (`index.ts:159`) into the failure union; move the CRUD implementation
  out of the barrel into `vault-ops.ts` (index.ts becomes re-exports,
  matching path.ts/search.ts/splice.ts).
- **app.ts split + honest 400s**: extract the static-file server + dev
  proxy + MIME table (`app.ts:346-467`) into `ui-static.ts`; replace
  silent body-coercion defaults (`readSpliceRequest:257-260`, `content`
  at `:141`, `to` at `:166`) with 400 `invalid_request` responses for
  missing/mistyped fields (closed-union code, exhaustively mapped).
- **Demo scaffolding sweep**: `DEMO_DOCUMENT_YJS_PATH` route constant moves
  from `packages/doc-session/src/websocket.ts:8` to the daemon app;
  `DEFAULT_DEMO_DOCUMENT_CONTENT` stops being a session-class default
  (`session.ts:11-16, 99` — seeding becomes the daemon's job); dead
  `demoDocumentFile` config (`config.ts:16,72,82`) deleted; hard-coded
  `'hello-world.md'` in `main.ts:23,121` becomes one named constant in the
  app.
- **Dead code sweep** (fallow's list, with judgment): delete
  `packages/ui/.../color-utils.ts` (100% dead) and `accent.ts:1
  userAccents`; delete dead exports `markdown-core.ts:8,10` (accent
  re-exports, `MENTION_URL_SCHEME`), `plaintext-link-affordance.ts:91`,
  `plaintext-mention-keymap.ts:39`, `config.ts:56 resolveHost`,
  `demo-document-provider.ts:121`, the dead `button/index.ts` re-exports,
  and `packages/editor/svelte.config.js`. KEEP (not dead): CM6
  `WidgetType` overrides (framework-invoked), doc-session manager/session
  public API (production-called via workspace imports — fallow resolution
  artifact), test-only exports that the gates rely on.
- **Consolidate triplicated helpers**: one `utf8ByteLength`, one
  `isNodeError`, ONE `DOCUMENT_BYTES_LIMIT` (the `splice.ts:2` /
  `session.ts:23` pair is a silent-drift bug waiting), one path-containment
  guard inside vault-core (`index.ts:133` vs `search.ts:121`).
- **Test hygiene**: `routing.test.ts:12` imports the splice contract table
  via a workspace export instead of `../../../packages/...` relative path;
  `documentSessions?` optionality on the service is removed (it exists
  only for tests — tests construct a real manager; the three
  `session_unavailable` branches and the 503 mapping go away).
- **NOT in scope**: the editor port (`plaintext-decorations.ts`,
  `PlaintextEditor.svelte`) is quarantined complexity — untouched; the
  fixture-backed editor-page composition story (deferred, tracked);
  routing.test.ts splitting (defer unless trivial while touching it).

## Acceptance Criteria

1. ONE failure shape end to end: no `as string`/`as any`/unvalidated
   widening at any failure seam (auditor greps); HTTP and MCP mappers are
   exhaustive switches; live and cold delete/move return identical shapes
   including audit metadata. Wire code VALUES unchanged (regression-tested
   against 008/009 expectations).
2. `packages/vault-service` exists with the facade + its tests; the daemon
   app contains wiring only; local-mcp consumes the package type; coverage
   gate moves with it (≥90% lines) and every package gate still passes.
3. Audit rows flow through one chokepoint; no duplicate write rows; audit
   content unchanged (tests).
4. The five session.ts/manager.ts danger zones carry constraint comments;
   the dead disjunct is gone; no behavior change (007/008 suites green
   unmodified except where decisions above require expectation edits).
5. gray-matter is gone from package.json; the three justification comments
   exist; the test name is truthful.
6. vault-core: `statOrNull` helper in place (six clones gone), v8-ignore
   reasons accurate (auditor reads each), `entry_cap_exceeded` typed,
   CRUD in `vault-ops.ts` with index.ts as barrel.
7. app.ts ≤ ~250 lines with static serving in `ui-static.ts`; malformed
   bodies get 400 `invalid_request` (tested for splice/append/prepend/
   move/PUT).
8. Demo scaffolding out of packages per the decision (doc-session contains
   no route paths and no demo content); `/` demo flow still works
   browser-verified.
9. Dead-code list deleted; `pnpm check` green; fallow re-run shows: zero
   production dead exports from the listed set, production duplication
   reduced (the vault-core/vault-service clone groups gone), health score
   ≥ 88.
10. Full regression: all 007/008/009 suites green; the two-tab, rekey,
    doc-deleted, persist-failure, and MCP edit-loop behaviors unchanged
    (spot browser-verification of rekey + doc-deleted + one MCP edit).
11. Coverage gates all green; no new files outside gates
    (tests-are-gated-and-real).
12. Non-goals untouched.

## Testing Expectations

This chunk is behavior-preserving: the existing suites ARE the safety net —
they must pass with only the expectation edits the decisions explicitly
require (response-shape unification, 400s for malformed bodies). New tests:
the 400 table, the unified-shape assertions (live vs cold equality), audit
chokepoint uniqueness, and gate coverage for `packages/vault-service`.

## Manual Verification

```bash
pnpm install && pnpm check -- --skip-nx-cache && fallow health --score
KB2_HOME=$(mktemp -d) KB2_PORT=<free> pnpm dev:daemon
# browser: / demo flow, a rename-follow, a delete banner — unchanged
# curl a malformed splice body → 400 invalid_request
# MCP edit loop still works (inspector or SDK script)
```

## Verification

- Implementer reports the fallow before/after scores and the browser spot
  checks with what was visibly observed.
- A fresh audit subagent in an isolated worktree re-runs everything and
  verdicts against all ELEVEN invariants (the two new ones lead), with
  specific instructions to: grep failure seams for widenings, read every
  v8-ignore reason against its line, import-grep every dependency claim,
  verify the dead-code deletions didn't remove framework-invoked or
  workspace-imported members, and negative-test one coverage gate.
- Deviations listed explicitly.

## Non-Goals

- No editor-port refactoring (plaintext-decorations.ts, PlaintextEditor).
- No new product features, endpoints, tools, or UI.
- No changes to wire-visible failure CODES or product semantics.
- No tier-2 vault ops, no link index, no storybook composition story
  (deferred, tracked in horizons).
