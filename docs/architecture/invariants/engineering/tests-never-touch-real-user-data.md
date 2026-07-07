# Tests Never Touch Real User Data

## Invariant

Automated tests, manual smoke flows, and agent-driven verification always use
temp or explicitly configured throwaway homes and vault paths. No flow may
default to, write to, or delete a real user vault, the real `~/.kb1`, or the
legacy real `~/.kb2`.

## This Means

- Filesystem-touching tests create temp directories and clean them up.
- Documented smoke flows set `KB1_HOME` explicitly to a temp path; examples
  in docs use temp paths, never a real `~/.kb1` or `~/.kb2`.
- Reset/re-seed operations for verification only ever target temp state.
- Agents (implementers and auditors) run their own daemon instances on their
  own ports with their own temp homes, and kill what they start.
- Destructive cleanup guards that it is deleting state it created.

## Good Examples

- `KB1_HOME=$(mktemp -d)` in test setup and smoke instructions.
- An auditor noting it verified against its own instance, not a developer's
  running daemon.

## Violations

- A test or script with `~/.kb1`, `~/.kb2`, or any real vault path as a default or
  fallback.
- Smoke documentation that omits `KB1_HOME`, silently using the real home.
- Cleanup code that removes a configurable path without verifying it created
  that path.

## Exceptions

None currently accepted.

## Review Checklist

- Could this test or flow ever resolve to a real user path?
- Does every started process get cleaned up, and only its own state removed?
- Do docs and examples model the temp-path habit?
