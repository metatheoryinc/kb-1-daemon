# Battle-Tested Over Hand-Rolled

## Invariant

For algorithmic concerns with mature off-the-shelf solutions — text diffing,
parsing, hashing, unicode handling, compression, date/time math, CRDT
operations — KB-1 uses a battle-tested library (or adapts a KB-1-proven
implementation) rather than writing a fresh algorithm. The ideal integration
is a one-line call plus thin glue.

Fresh algorithmic code is a last resort. It requires an explicit, documented
justification in the plan or PR ("no suitable library exists because ..."),
and that justification is a review item, not a formality.

## Why

Hand-rolled algorithms are where edge-case bugs live: surrogate pairs in
charCode loops, off-by-ones at boundaries, pathological inputs nobody fuzzed.
A library with a decade of production users has already paid that cost. Glue
code is reviewable at a glance; algorithm code is not.

## Founding Example

An early implementation shipped `applyMinimalTextSplice` — a 39-line
hand-rolled prefix/suffix differ — when `fast-diff` (the extracted core of
Google's diff-match-patch, surrogate-safe, a decade in Quill production) plus
Yjs's built-in `Y.Text.applyDelta` do the same job as ~6 lines of glue. Review
caught it, and the follow-up replaced it with the library-backed path.

## This Means

- Before implementing anything that scans, compares, transforms, or parses
  data: search npm and KB-1 for the established solution first.
- Prefer libraries that are themselves the extracted core of something with
  massive production exposure.
- Glue mapping a library's output to our types is fine; reimplementing the
  library's job is not.
- Property tests still apply to the glue (e.g. "applying the delta to the
  baseline reproduces the target exactly").

## Violations

- A fresh diff, parser, tokenizer, or merge implementation without a
  documented no-library justification.
- Copying an algorithm's logic into our code instead of depending on it.
- "It's only 40 lines" — that is the canonical size of this mistake.

## Exceptions

None currently accepted.

## Review Checklist

- Does the diff contain loops implementing comparison/scan/transform logic?
  Could a named library replace them?
- If fresh algorithmic code exists, where is the written justification?
- Is the library integration thin glue, or are we re-deriving its internals?
