# Vault Format

KB-1 vaults are filesystem directories. Markdown, images, attachments, and
selected `.kb1` metadata are portable user-owned data. Runtime caches, local
locks, and secrets are local implementation details.

## Example Layout

```text
KB1_HOME/
  daemon/
    status.json
  vaults/
    demo-vault/
      README.md
      notes/
        example.md
      assets/
        image.png
      .kb1/
        vault.json
        folders.yml
        audit/
          2026-06-10.jsonl
        cache/
        runtime/
        secrets/
      .gitignore
      .git/
  .trash/
```

Each vault is rooted at `KB1_HOME/vaults/<slug>/`. The slug is the stable vault
`id` used by REST (`/api/vaults/:id/...`) and MCP (`vaultId`). A zero-vault
home is valid after deletion: `KB1_HOME/vaults/` may be empty while the daemon
continues to serve `GET /api/vaults`.

Inside one vault:

```text
demo-vault/
  README.md
  notes/
    example.md
  assets/
    image.png
  .kb1/
    vault.json
    folders.yml
    audit/
      2026-06-10.jsonl
    cache/
    runtime/
    secrets/
  .gitignore
  .git/
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

## `.kb1` Directory

`.kb1` separates durable product metadata from rebuildable implementation state.

Current structure:

```text
.kb1/
  vault.json      # portable vault identity/config
  folders.yml     # folder colors and presentation metadata
  audit/          # durable product event/audit rows
  cache/          # ignored, rebuildable
  runtime/        # ignored, locks/session state
  secrets/        # ignored, local tokens if needed
```

`vault.json` is JSON, not YAML. Its current portable shape is:

```json
{
  "id": "demo-vault",
  "displayName": "Demo Vault",
  "metadata": {
    "color": "#ff6bb5"
  }
}
```

Only `id` and `displayName` are required. `metadata` is optional and omitted
when empty. Renaming a vault changes `displayName`; the slug/id and on-disk
folder name do not move.

## Folder Metadata

KB-1 folder colors and similar presentation state should be preserved as durable
metadata. A path-keyed YAML file is a simple starting point:

```yaml
folders:
  "Projects":
    color: blue
  "Projects/KB-1":
    color: pink
    icon: brain
```

This allows the visible filesystem tree to remain plain while preserving KB-1 UI
affordances.

## Ignored Local State

Caches, locks, runtime sessions, and secrets should not be committed.

The daemon writes a vault-root `.gitignore` when initializing Git-backed
history. It starts with:

```gitignore
.kb1/cache/
.kb1/runtime/
.kb1/tmp/
```

If the user commits the vault to Git, portable metadata can be included while
machine-specific state stays local.

## Git Integration

Git is used today for best-effort note history. The daemon creates
KB-1-authored history commits for content changes when Git is available and
exposes them through:

```text
GET /api/vaults/:id/files/{path}/history
```

`KB1_HISTORY_COALESCE_WINDOW_MS` controls how nearby daemon-authored history
events are coalesced. Move operations are recorded as structural history
barriers, so note history can follow a file across KB-1 moves when Git can
provide the log. Git failures make history unavailable or partial; they do not
make accepted filesystem writes fail.

The audit log remains product event history and complements Git.

## Starter Kit

The daemon seeds a new vault from the bundled starter-kit template when the
vault has no user content. `.kb1` identity files do not count as user content.
First boot of an empty `KB1_HOME` creates and seeds `demo-vault`; later
`POST /api/vaults` calls seed each newly created empty vault. Existing or
migrated vaults are not re-seeded.

## Legacy Migration

Legacy `.kb2` home directories and the old single-vault layout are migration
inputs only. On boot, the daemon migrates them into the KB-1 home and
`KB1_HOME/vaults/<slug>/` layout, then serves from `.kb1` paths. Runtime
configuration is `KB1_*`; `KB2_*` env vars are ignored.

## Open Questions

- Which `.kb1` files are part of the portable vault contract for v1?
- Should folder metadata be path-keyed only, or should it tolerate moves with
  explicit move events?
- Should audit logs include content snippets, hashes only, or operation metadata
  only?
- Should `.kb1` support migrations from the beginning?
- Whether MCP parity requires a note-history tool.
