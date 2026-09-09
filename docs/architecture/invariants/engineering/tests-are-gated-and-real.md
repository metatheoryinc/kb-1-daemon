# Tests Protect Consequential Behavior

## Invariant

Tests protect customer-visible behavior, data durability, access boundaries, and
known regressions. Verification is proportional to the consequence of a failure.
Coverage reports help locate gaps; percentages and assertion counts are not the
acceptance criteria.

## This Means

- **Real resources where they matter.** Filesystem and persistence tests use
  disposable real directories, and process tests own their ports and cleanup.
  Never use a developer's real vault or shared state. Mock external boundaries
  when appropriate, but do not mock away the resource whose behavior is under test.
- **Independent durability evidence.** Save, collaboration, restart, recovery,
  and other persistence-sensitive tests verify both the public read path and
  persisted bytes when either alone could hide a real failure. Routine mutations
  need the assertions that establish their contract, not a mandatory second path.
- **Meaningful regressions.** Add a test when it catches a plausible bug, protects
  an important contract, or reproduces a known failure. Reversible, low-impact
  edits and implementation details do not automatically require new tests.
- **Coverage as diagnosis.** Keep coverage reporting for review, without blanket
  percentage gates or a requirement that every production file have a gate.
  Investigate consequential untested behavior; do not add assertions or ignore
  comments just to change a number. Existing ignores must describe their actual line.
- **Truthful names.** Test names describe the behavior actually exercised.
- **Focused property tests.** Retain randomized validation, Unicode, and
  splice/diff checks where they expose input combinations that examples miss.

## Verification And Review

Run the repository's required checks for the change. Reuse valid results from the
same revision and environment; rerun affected checks after changes or failures.
Do not repeat unchanged suites for reassurance or negative-test coverage tooling
merely to prove it enforces a quota.

Keep high-value persistence, restart, reconnection, revocation, isolation,
provisioning, and deletion coverage. Remove or consolidate a test only after
identifying the obsolete behavior, duplication, or implementation-only assertion;
a high test count is not itself a reason to delete tests.

Reviewers should ask which failure each added test catches, whether the resources
and assertions expose that failure, and what material gaps remain. A green suite
is evidence for its tested behavior, not proof of production readiness.
