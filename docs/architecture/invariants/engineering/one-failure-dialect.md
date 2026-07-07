# One Failure Dialect

## Invariant

Failures flow through ONE typed result taxonomy from the service layer to
every consumer (REST, MCP, UI events). Codes stay closed unions end to end;
the same operation returns the same shape regardless of internal state; and
no seam widens a typed failure into a loose string or `any`.

## Why

KB-1 grew two dialects (`{ok:false, error}` in vault-core vs `{ok:false,
rejected}` in splice/session) that were laundered through `as string` casts
and `Record<string, unknown>` widenings at every boundary, and the same
endpoint returned different shapes depending on whether a live session
happened to exist. Each individual widening was reasonable; the sum was
stringly-typed errors at the wire and contracts that depend on hidden
state. Agents route on codes — codes must be types, not prose.

## This Means

- One canonical failure shape (one discriminant field name, closed union of
  codes) defined once and imported everywhere; layer-specific codes extend
  the union, never fork the shape.
- HTTP/MCP mappers exhaustively switch on the union (compiler-checked), and
  structured detail (current content, baselines, match counts, limits)
  rides typed fields.
- A given endpoint/tool returns the same response shape for the same
  outcome whether the path was live-session or cold-disk (including audit
  metadata fields).
- No `as string`, `as any`, or unvalidated `Record<string, unknown>` at a
  failure seam; cross-package boundaries that deliberately re-declare types
  document the decoupling and keep the unions closed (no `string` where the
  source has a union).

## Good Examples

- A route handler whose error mapping is an exhaustive `switch` the
  compiler verifies when a new code is added.
- MCP tools surfacing the identical structured rejection the service
  produced.

## Violations

- A second result shape for the same concern; `('error' in r ? r.error :
  r.rejected) as string`.
- A failure field typed `string` downstream of a closed union.
- Response shape varying with internal state invisible to the caller.

## Exceptions

- Success-shape live indicators (accepted 2026-06-11): live-session and
  cold-disk paths return identical FAILURE shapes and identical audit
  metadata, but success responses still differ by live-indicator keys
  (`live: true`, `liveDeleted`/`liveMoved` present only on live paths) —
  a pre-existing wire contract. Expires at the next deliberate
  wire-breaking change, which should normalize (e.g. always-present
  `live` boolean).

## Review Checklist

- Grep the diff for `as string`/`as any` near failure handling.
- New failure codes: added to the union, mapped exhaustively?
- Same operation, live vs cold: byte-compatible response shapes?
- Any cross-package type re-declaration drifting from its source union?
