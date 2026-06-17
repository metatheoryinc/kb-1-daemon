# Vault Slugs Are Unique Within A Daemon

## Invariant

Every vault a daemon serves has a stable slug, and that slug is unique across
all vaults the daemon serves. The slug is the vault's identity for routing,
addressing, and registry lookup. Two vaults sharing a slug is a hard error, not
a recoverable condition.

## This Means

- A vault's identity lives on disk at `<vault>/.kb2/vault.json` (`{ id, displayName }`),
  where `id` is the slug. The filesystem is the source of truth.
- The registry is built by scanning the vaults directory; each directory's
  identity is read, or minted from the folder name on first sight.
- A slug collision during discovery aborts boot with a clear error rather than
  silently dropping or shadowing a vault.
- A slug, once minted and persisted, is stable: it is not recomputed from the
  folder name on later boots.

## Good Examples

- Discovery throwing `Duplicate vault slug "<id>"` and naming both conflicting
  roots when two vaults carry the same `id`.
- Minting `{ id, displayName }` from the folder name only when
  `.kb2/vault.json` is absent, then reusing it verbatim afterward.

## Violations

- Deriving a vault's slug from a mutable property (path, display name) on every
  boot so it can change underneath callers.
- Resolving a slug collision by appending a suffix or picking a winner instead
  of failing loudly.
- Holding the registry only in memory so identity is lost on restart.

## Exceptions

None currently accepted.

## Review Checklist

- Is each served vault addressable by a single stable slug?
- Does a slug collision fail boot loudly instead of silently shadowing a vault?
- Is identity persisted in `.kb2/vault.json` and read back rather than
  recomputed?
