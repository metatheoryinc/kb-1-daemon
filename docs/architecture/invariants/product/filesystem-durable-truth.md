# Filesystem Is Durable Truth

## Invariant

A vault is fully restorable from its Markdown, assets, and durable `.kb1`
metadata. Everything else the runtime holds — Yjs documents, caches, indexes,
session state — is a rebuildable artifact.

## This Means

- Cold boot from files alone must reproduce a servable vault.
- Accepted edits are materialized to the filesystem; a crash or restart must
  not lose them beyond the active in-flight write.
- Yjs/Y.Text state is active-session truth only; it is never the only place
  an accepted edit lives at rest.
- Deleting `.kb1/cache/` and `.kb1/runtime/` must never lose user content.
- New durable product semantics live in files (vault content or durable
  `.kb1` metadata such as `vault.json`, `folders.yml`, audit logs) — not in
  runtime-only state.
- A vault identity is durable JSON at `.kb1/vault.json`, with required `id` and
  `displayName` and optional `metadata`.
- Git-backed note history is best-effort and rebuildable from the vault's Git
  repository when available; it must not replace accepted filesystem writes as
  the durable content source.

## Good Examples

- The doc-session service rebuilding a Yjs document from the Markdown file on
  cold start.
- Search indexes regenerated from files after cache deletion.
- Folder colors stored in `.kb1/folders.yml`, not in a runtime database.
- Vault slugs/display names stored in `.kb1/vault.json`, not inferred only from
  memory.

## Violations

- Persisting Yjs updates as the canonical store with Markdown demoted to a
  cache or export.
- Any state that cannot be regenerated from files but is required to serve
  the vault.
- A restart path that depends on memory-only or `runtime/`-only state to
  avoid losing accepted edits.

## Exceptions

None currently accepted.

## Review Checklist

- After this change, does cold boot from files alone still fully restore the
  vault?
- Is every accepted edit materialized to disk promptly?
- Did anything rebuildable quietly become load-bearing?
