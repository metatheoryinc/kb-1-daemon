/**
 * Opaque expansion-key minting for the file tree.
 *
 * The tree rows are keyed by strings so the prop-driven components and
 * the shell's store agree on identity without the components ever
 * reaching for state or transport:
 *
 *   - `vault:<vaultId>`         — a vault group row
 *   - `folder:<vaultId>:<path>` — a folder row inside that vault
 *
 * These are pure string functions — no fetch, no storage. The shell
 * owns the expanded/collapsed sets and persistence; components only
 * mint and compare keys.
 */

/** Mint the opaque expansion key for a vault group row. */
export function vaultKey(vaultId: string): string {
  return `vault:${vaultId}`;
}

/** Mint the opaque expansion key for a folder row. */
export function folderKey(vaultId: string, path: string): string {
  return `folder:${vaultId}:${path}`;
}
