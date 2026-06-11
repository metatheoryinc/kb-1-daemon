# Chunk 006.5: Library Diff Reconcile And Quiet Merge

## Purpose

Two improvements to chunk 006's external-change handling, both driven by
review:

1. Delete the hand-rolled differ. `applyMinimalTextSplice`
   (packages/doc-session/src/session.ts:388-426) is fresh algorithmic code
   where a battle-tested library exists — the founding violation of
   `docs/architecture/invariants/engineering/battle-tested-over-hand-rolled.md`
   (read it first). Replace with `fast-diff` + Yjs's built-in
   `Y.Text.applyDelta`.
2. Stop being loud when nothing was lost. When an external edit lands while
   the session has no unmaterialized changes, the merge is structurally
   lossless — clients should get a quiet "merged external edit" notice, not
   the warning banner. The loud banner remains exactly where loss is
   possible: external saves that raced active typing, and
   truncation/deletion.

## Starting Context

main contains chunks 001-006. The session tracks `lastWrittenHash`;
reconciliation currently converges the session to disk via the hand-rolled
splice and always emits the loud `external-change` event. The
edits-save-or-fail-loudly invariant mandates loudness only where the user
could otherwise lose changes unawares.

## Decisions

- Dependency: `fast-diff` (exact-pinned per repo convention). It is the
  extracted diff core of Google's diff-match-patch — surrogate-pair-safe and
  production-hardened. No other diff code is permitted: the implementation
  maps fast-diff tuples (`EQUAL`/`INSERT`/`DELETE`) to a Yjs delta
  (`retain`/`insert`/`delete`) and calls `ytext.applyDelta(delta)` inside one
  transaction with the existing external-change origin. Thin glue only.
- `applyMinimalTextSplice` and its tests are DELETED. Net algorithmic code in
  this chunk is negative. The auditor will grep for residual hand-rolled
  comparison/scan loops.
- Reconciliation always computes `fast-diff(currentSessionContent,
  diskContent)` and applies it — the session converges to disk (disk wins,
  unchanged semantics). No baseline-coordinate replay, no shadow documents,
  no three-way merge machinery: client updates still in network flight merge
  afterward via normal CRDT convergence and then persist, so they survive
  without any custom logic.
- The session additionally tracks `lastWrittenContent` (the string it last
  materialized, alongside the existing hash). Event selection:
  - `currentSessionContent === lastWrittenContent` at reconcile time (no
    unmaterialized local changes — nothing can be lost) → emit new event
    kind `external-merge` (quiet).
  - Otherwise (external save raced local edits; the raced edits are
    clobbered in file semantics) → emit `external-change` (loud), as today.
  - Disk read of empty/missing file when the session had content → always
    `external-change` (loud), regardless of baseline match.
- Protocol: add `external-merge` to the event kinds in
  `@kb-2/doc-session/protocol`. The provider and page pass it through like
  the others.
- UI: `external-merge` renders a new quiet variant of `DocumentSaveBanner`
  (info-toned, auto-dismisses after ~4s): "Merged an edit made outside
  KB-2." The loud `external-change` banner is unchanged. New variant gets a
  fixture story.
- Memory note: holding `lastWrittenContent` doubles the document's resident
  string cost — acceptable for the one-file scope; flag in code comment for
  the multi-file chunk to revisit.

## Acceptance Criteria

1. `applyMinimalTextSplice` no longer exists; no hand-rolled
   comparison/scan/edit-script code remains in the diff (auditor-verified by
   grep and read).
2. Reconciliation uses `fast-diff` + `applyDelta`; the glue is small enough
   to read in one screen.
3. Property test: for randomized document pairs (including emoji/surrogate
   pairs, repeated blocks, empty strings), applying the computed delta to
   the source string reproduces the target exactly.
4. With the session idle (no unmaterialized changes), an external file edit
   produces: converged content in all clients plus the QUIET
   `external-merge` notice — browser-verified in two tabs (auto-dismissal
   observed).
5. With rapid typing racing the external write, the LOUD `external-change`
   banner still appears (existing behavior preserved) — browser-verified.
6. Truncation/deletion of the file still produces the loud path.
7. A client update in network flight during reconciliation survives: test
   with two simulated clients where one sends an update concurrent with the
   external merge; both the external edit and the client edit are present
   afterward and persist to disk.
8. Persist-failure/recovered behavior from chunk 006 is unchanged (no
   regressions in those tests).
9. `pnpm check` passes; all tests use temp homes.
10. No reconnect/offline work, no multi-file, no shadow documents.

## Testing Expectations

- the property/fuzz test from criterion 3 (this is the heart of the chunk)
- surrogate-pair boundary test (edit adjacent to and inside emoji)
- event-kind selection tests: idle→merge, raced→change, truncation→change
- in-flight client update survival test (criterion 7)
- existing chunk 006 suites stay green

## Manual Verification

```bash
pnpm install && pnpm check && pnpm dev
# two tabs on http://127.0.0.1:7382/, leave them idle
echo "quiet external edit" >> ~/.kb2/demo-vault/hello-world.md
# both tabs: content appears with the QUIET notice, which auto-dismisses
# then type rapidly in one tab while echoing again: the LOUD banner appears
```

## Verification

After implementation is reported complete:

- the implementer runs `pnpm check` and the manual flow and reports actual
  output; quiet-vs-loud behavior verified in a REAL BROWSER (two tabs),
  stating what was visibly rendered including the auto-dismissal
- a fresh reviewer audits the diff against the acceptance criteria and all
  invariants, with specific instructions to grep for residual hand-rolled
  algorithmic code and to run the property test
- deviations listed explicitly

## Non-Goals

- No shadow Y.Docs, no baseline-coordinate delta replay, no three-way merge
  machinery.
- No reconnect/offline/read-only work.
- No multi-file or watcher generalization.
- No changes to persist-failure semantics.
- No other diff libraries or custom diff fallbacks.
