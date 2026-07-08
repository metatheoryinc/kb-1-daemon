# Content, Not People (Local Product)

## Invariant

The local product's behavior models files, edits, and file-change events —
not users, cursors, selections, follow mode, or presence. Awareness and
collaboration affordances belong to the cloud layer.

When something changes a file locally, the product surfaces a content event
("changed outside KB-1; reloaded from disk"), with warning framing for direct
writes — never a presence model.

## Named Exception: Durable Actor Attribution

The local store must be able to **record and retrieve** actor attribution
even though the local product does not act on it. The audit log and reserved
durable `.kb1` metadata may attribute operations to actors — users, agents,
API/MCP callers (e.g. `"actor":"user:123"`, `"source":"cloud-relay"`) —
because the user's vault is the only durable home for that history and the
cloud layer needs it.

The line: speaking the attribution language for storage and retrieval is in;
building local user models that drive product behavior is out. The local UI
may display attribution as historical/audit data when it exists.

## This Means

- No presence, cursor, selection, or follow-mode state in the daemon or local
  UI.
- No local user registry that gates or shapes editing behavior.
- Audit events carry actor/source fields when known; "unknown local caller"
  is an acceptable actor.
- External file changes surface as content-state events, not as people.

## Violations

- Cursor or selection broadcast between local clients.
- A local account/user model introduced to support a local-only feature.
- Refusing to record actor metadata on MCP or relayed operations because
  "local has no users" — the storage language must exist.

## Review Checklist

- Does any new state represent a person rather than content or an audit fact?
- Are external changes surfaced as file-change/warning events?
- Does attribution stay in audit/metadata (allowed) rather than driving
  product behavior (not allowed)?
