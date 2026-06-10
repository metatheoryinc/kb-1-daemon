# Single Writer, One Service Boundary

## Invariant

The daemon is the only legitimate runtime writer of vault content, and every
client reaches it through the same service boundary.

Local UI, local MCP tools, smoke scripts, tests, and the future cloud relay
all perform vault reads and writes through the daemon's service APIs. No
client gets a private side door, and no second write path exists.

## This Means

- Vault content writes happen in daemon-owned service code, nowhere else.
- The web UI calls daemon APIs; it never obtains vault content from any
  source other than the daemon.
- MCP tools call the same vault services the UI uses, not their own
  filesystem logic.
- New surfaces (CLI commands, relay, scripts) compose the existing service
  boundary instead of opening a parallel one.
- Direct filesystem edits by users are allowed but are outside the system:
  they are detected and surfaced as warning events, never treated as a
  supported write path.

## Good Examples

- `packages/doc-session` owning the document edit path, consumed by daemon
  routes.
- A future MCP `edit` tool calling the same splice service as the UI editor.
- A verification script driving edits through the daemon's WebSocket/API
  rather than writing the Markdown file.

## Violations

- An MCP tool, script, or second process writing vault files directly as part
  of a product flow.
- Two different code paths that can both materialize edits to the same file.
- UI or tooling that "fixes up" vault files behind the daemon's back.

## Exceptions

None currently accepted.

## Review Checklist

- Does any new code write vault content outside daemon-owned service code?
- Do new client surfaces reuse the existing service APIs?
- Could two write paths now race on the same file?
