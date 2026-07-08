# Package-Composed Monorepo

## Invariant

Apps are deployment surfaces. Packages own reusable product and runtime
concerns.

KB-1 is currently composed from two shipped local apps and eight reusable
workspace packages with meaningful test coverage. Apps such as the daemon and
local UI assemble package behavior into runtime surfaces.

## This Means

- `apps/*` start processes, serve UIs, bind ports, or deploy to a runtime.
- `packages/*` contain reusable logic with a single clear responsibility.
- Shared protocols live in packages before multiple apps depend on them.
- Core behavior is testable without booting a full app when practical.
- App code composes packages instead of becoming the only place logic lives.

## Good Examples

- `packages/tunnel-protocol`: HTTP tunnel frames, stream IDs, errors,
  cancellation, and versioning.
- `packages/vault-core`: filesystem-backed vault operations.
- `packages/vault-service`: service boundary over `vault-core` used by REST and
  MCP.
- `packages/local-mcp`: MCP tools over the same vault service boundary.
- `apps/daemon`: process shell that wires config, HTTP server, local UI, MCP,
  and vault packages together.

## Current Layout

Shipped local apps:

- `apps/daemon`: `kb1d`, HTTP route layer, MCP mounting, local UI serving, and
  runtime wiring
- `apps/web`: local web UI

Reusable packages:

- `packages/doc-session`: Yjs document sessions backed by Markdown files
- `packages/editor`: plaintext editor behavior
- `packages/local-mcp`: MCP tools over the vault service boundary
- `packages/tunnel-client`: daemon-side relay/tunnel client
- `packages/tunnel-protocol`: relay/tunnel frame protocol types
- `packages/ui`: shared UI components and Storybook
- `packages/vault-core`: filesystem-backed vault operations and history
- `packages/vault-service`: service boundary used by daemon routes and MCP

There is no `packages/vault-api`. HTTP routes currently live in `apps/daemon`
and compose `packages/vault-service`.

## Violations

- A large app directly owns protocol types, filesystem operations, API routes,
  and runtime wiring in one place.
- The daemon and cloud worker each define their own tunnel frame formats.
- UI code reads or writes vault files directly instead of using package/service
  boundaries.
- Reusable behavior has no package-level tests because it only exists inside an
  app entrypoint.

## Exceptions

None currently accepted.

If an exception is intentional, document it here with the reason and expected
duration.

## Review Checklist

- Does new reusable behavior belong in `packages/*` instead of `apps/*`?
- Is the package responsibility narrow enough to explain in one sentence?
- Are package exports consumed by apps instead of duplicated across apps?
- Are there package-level tests for non-trivial behavior?
- Has an intentional exception been documented?
