# Vault Format

KB-2 vaults are filesystem directories. Markdown, images, attachments, and
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
    vault.yml
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
- durable KB-2 metadata needed to preserve product semantics

The server should be able to bootstrap from this data after a fresh checkout or
restore.

## `.kb2` Directory

`.kb2` separates durable product metadata from rebuildable implementation state.

Recommended structure:

```text
.kb2/
  vault.yml       # portable vault identity/config
  folders.yml     # folder colors and presentation metadata
  audit/          # durable product event history
  git/            # optional git integration config/state
  cache/          # ignored, rebuildable
  runtime/        # ignored, locks/session state
  secrets/        # ignored, local tokens if needed
```

## Folder Metadata

KB-1 folder colors and similar presentation state should be preserved as durable
metadata. A path-keyed YAML file is a simple starting point:

```yaml
folders:
  "Projects":
    color: blue
  "Projects/KB-2":
    color: pink
    icon: brain
```

This allows the visible filesystem tree to remain plain while preserving KB-2 UI
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
- Should `vault.yml` contain a stable vault ID, display name, schema version, or
  cloud registration metadata?
- Should folder metadata be path-keyed only, or should it tolerate moves with
  explicit move events?
- Should audit logs include content snippets, hashes only, or operation metadata
  only?
- Should `.kb2` support migrations from the beginning?
