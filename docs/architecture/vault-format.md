# Vault Format

KB-1 Local vaults are filesystem directories. Markdown, images, attachments, and
selected `.kb2` metadata are portable user-owned data. Runtime caches, local
locks, and secrets are local implementation details.

## Example Layout

```text
vault/
  notes/
    example.md
  assets/
    image.png
  .kb2/
    vault.json
    folders.yml
    audit/
      2026-06-10.jsonl
    git/
      config.yml
    cache/
    runtime/
    secrets/
    .gitignore
```

## Canonical Data

Canonical durable content includes:

- Markdown files
- images
- attachments
- user-managed folder/file structure
- durable KB-1 metadata needed to preserve product semantics

The server should be able to bootstrap from this data after a fresh checkout or
restore.

## `.kb2` Directory

`.kb2` separates durable product metadata from rebuildable implementation state.

Recommended structure:

```text
.kb2/
  vault.json      # portable vault identity/config and root presentation metadata
  folders.yml     # folder color metadata
  audit/          # durable product event history
  git/            # optional git integration config/state
  cache/          # ignored, rebuildable
  runtime/        # ignored, locks/session state
  secrets/        # ignored, local tokens if needed
```

## Vault Metadata

Vault root presentation metadata lives in `.kb2/vault.json` alongside the
stable vault id and display name:

```json
{
  "id": "demo-vault",
  "displayName": "Demo Vault",
  "metadata": {
    "color": "#a7f3d0"
  }
}
```

## Folder Metadata

KB-1 folder colors are preserved as durable metadata. The current shipped
metadata surface is color-only: values are hex colors, and `"inherit"` clears a
folder back to its inherited ancestor or vault color. Folder metadata is keyed by
vault-relative path and follows service-mediated folder moves.

```yaml
folders:
  "Projects":
    color: "#bae6fd"
  "Projects/KB-1":
    color: "inherit"
```

This allows the visible filesystem tree to remain plain while preserving KB-1 UI
affordances.

## Ignored Local State

Caches, locks, runtime sessions, and secrets should not be committed.

`.kb2/.gitignore` can start with:

```gitignore
cache/
runtime/
secrets/
```

If the user commits the vault to Git, portable metadata can be included while
machine-specific state stays local.

## Git Integration

Git should be treated as a backup, snapshot, diff, and remote-sync mechanism. It
should not be the only product audit log.

The local server may later support:

- initializing a vault Git repo
- periodic commits
- user-triggered commits
- commit summaries based on audit events
- remote configuration
- rollback helpers

The audit log remains useful even when Git is disabled or commits are batched.

## Open Questions

- Which `.kb2` files are part of the portable vault contract for v1?
- Should `.kb2/vault.json` gain an explicit schema version or cloud registration
  metadata?
- Which presentation metadata fields beyond color belong in the portable vault
  contract?
- Should audit logs include content snippets, hashes only, or operation metadata
  only?
- Should `.kb2` support migrations from the beginning?
