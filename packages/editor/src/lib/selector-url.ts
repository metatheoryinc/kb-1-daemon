type VaultTarget =
  | { kind: 'vault'; vaultSlug: string }
  | { kind: 'folder'; vaultSlug: string; path: string }
  | { kind: 'note'; vaultSlug: string; path: string };

export function parseInVaultSelector(
  vaultSlug: string,
  selector: string,
): VaultTarget {
  const trimmed = selector.replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) return { kind: 'vault', vaultSlug };

  const segments = trimmed.split('/').map((s) => decodeURIComponent(s));
  const path = segments.join('/');
  const last = segments[segments.length - 1] ?? '';
  return last.includes('.')
    ? { kind: 'note', vaultSlug, path }
    : { kind: 'folder', vaultSlug, path };
}

