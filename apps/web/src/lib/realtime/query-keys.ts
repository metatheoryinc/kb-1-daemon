export const queryKeys = {
  vaults: () => ['vaults'] as const,
  vault: (vaultId: string) => ['vault', vaultId] as const,
  tree: (vaultId: string) => ['vault', vaultId, 'tree'] as const,
  note: (vaultId: string, path: string) => ['vault', vaultId, 'note', path] as const,
} as const;
