# Tests Are Gated And Real

## Invariant

Test suites for service and session code run against real resources, assert
through two independent paths, and enforce coverage through build-failing
gates. A test suite is a first-class deliverable, not an accompaniment.

## This Means

- **Real resources.** Filesystem-touching tests run against real temp
  directories (`mkdtemp`); no in-memory fs shims, no mocking the resource
  under test. Processes under test bind real (ephemeral/temp) ports and are
  killed by the test.
- **Dual assertion.** Every mutation is verified BOTH through the
  service/API read path AND by direct inspection of the underlying resource
  (file content/stat, trash contents, audit JSONL rows). One without the
  other is half a test.
- **Gated coverage.** Vitest coverage thresholds are wired into `pnpm
  check` so the build FAILS below them: pure-logic packages at 100%
  statements/functions/lines (≥95% branches); route/session/service glue at
  ≥90% lines. Every new production file lands inside a gate's include — a
  file outside all gates is a violation, not an oversight.
- **Truthful suppressions.** Every coverage-ignore comment carries a reason
  that is accurate for ITS line (copy-paste drift is a violation), and
  auditors review every ignore.
- **Truthful names.** A test's name describes what it actually exercises;
  a name claiming a library or behavior the test does not touch is a
  violation (this happened: a test titled "using gray-matter detection"
  tested a hand-rolled scanner).
- **Property tests** defend algorithmic glue (validation, splice/diff
  application) with randomized inputs including unicode/surrogate cases
  near the operation site.

## Good Examples

- `KB2_HOME=$(mktemp -d)` per suite; chmod-based persist-failure repros.
- The splice property test: randomized docs/edits reproduce expected
  content exactly.
- Negative-testing a gate (raise threshold → build fails → revert) to prove
  it enforces.

## Violations

- A new production file outside every coverage include.
- A mutation test that asserts only the API response.
- memfs/mock-fs for vault behavior; tests sharing a developer's real state.
- An ignore comment whose reason describes a different line.

## Exceptions

None currently accepted.

## Review Checklist

- Is every new file inside a gate? Run the negative test on one gate.
- Spot-check three mutations for dual assertion.
- Read every new coverage-ignore reason against its line.
- Do test names match what the bodies do?
