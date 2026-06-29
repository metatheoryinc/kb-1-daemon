export const queryKeys = {
  vaults: () => ['vaults'] as const,
  vault: (vaultId: string) => ['vault', vaultId] as const,
  tree: (vaultId: string) => ['vault', vaultId, 'tree'] as const,
} as const;
