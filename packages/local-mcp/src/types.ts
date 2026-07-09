import type { LocalMcpVaultService, ServiceFailure, ServiceResult, VaultActor } from '@kb-1/vault-service';

export type { LocalMcpVaultService, ServiceFailure, ServiceResult, VaultActor };

export type LocalMcpActor = VaultActor;

export interface LocalMcpVaultMetadata {
  color?: string;
}

/** A vault the MCP layer can address: stable slug, display name, and optional root metadata. */
export interface LocalMcpVaultSummary {
  id: string;
  displayName: string;
  metadata?: LocalMcpVaultMetadata;
}

/**
 * The MCP layer's view of the daemon's vaults. The daemon's `VaultRegistry` is
 * the concrete implementation — this is the single source of truth for resolving
 * an addressed vault and for enumerating vaults, so the MCP endpoint never holds
 * a second vault map.
 *
 * There is no default vault: every data tool requires a `vaultId`. `resolve`
 * returns the service for a given slug, or `undefined` when no vault carries
 * that slug (the tool then returns a clean error). `list` powers `list_vaults`,
 * the discovery entry point, and may be empty (zero vaults is a valid state).
 */
export interface LocalMcpVaultProvider {
  /** Resolve a vault's service by slug, or `undefined` when unknown. */
  resolve(id: string): LocalMcpVaultService | undefined;
  /** Every addressable vault as `{ id, displayName, metadata? }`; may be empty. */
  list(): LocalMcpVaultSummary[];
}
