/**
 * Vault-tree expansion keys and ancestor-walk helpers.
 *
 * The tree is keyed by opaque strings so the store, the components, and
 * the auto-expand path all speak one vocabulary:
 *
 *   - `vault:<vaultId>`            — a vault group row
 *   - `folder:<vaultId>:<path>`    — a folder row inside that vault
 *
 * Folders default closed (an allow-list of expanded keys). Vaults
 * default open, so the persisted shape for vaults is the inverse — a
 * deny-list of collapsed vault ids.
 */

/** Mint the opaque expansion key for a vault group or a folder row. */
export function expansionKey(
  kind: 'vault' | 'folder',
  vaultId: string,
  path?: string,
): string {
  return kind === 'vault'
    ? `vault:${vaultId}`
    : `folder:${vaultId}:${path ?? ''}`;
}

/**
 * Walk the proper ancestors of `path` inside `vaultId`, calling `expand`
 * with each ancestor's folder key. The leaf itself is never expanded —
 * it has no further descendants worth revealing.
 *
 * Empty paths, single-segment leaves, and trailing slashes resolve to no
 * ancestors. So a deep file `a/b/c.md` yields `folder:<id>:a` and
 * `folder:<id>:a/b`; a top-level file `note.md` yields nothing.
 */
function expandToPath(
  path: string,
  vaultId: string,
  expand: (key: string) => void,
): void {
  if (!path) return;
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return;
  const segments = trimmed.split('/').filter((s) => s.length > 0);
  if (segments.length <= 1) return;
  let acc = '';
  for (let i = 0; i < segments.length - 1; i += 1) {
    acc = acc ? `${acc}/${segments[i]}` : segments[i];
    expand(expansionKey('folder', vaultId, acc));
  }
}

/**
 * Compute the folder ancestor keys to unfurl so the row containing
 * `path` is visible. Used by the active-file auto-expand on load.
 */
export function ancestorKeysForPath(path: string, vaultId: string): string[] {
  const keys: string[] = [];
  expandToPath(path, vaultId, (key) => keys.push(key));
  return keys;
}
