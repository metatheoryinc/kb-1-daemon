import type { LocalMcpVaultService, ServiceFailure, ServiceResult, VaultActor } from '@kb-2/vault-service';

export type { LocalMcpVaultService, ServiceFailure, ServiceResult, VaultActor };

export type LocalMcpActor = { kind: 'mcp_client'; client: string };

/** A vault the MCP layer can address: its stable slug as `id` plus a display name. */
export interface LocalMcpVaultSummary {
  id: string;
  displayName: string;
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
  /** Every addressable vault as `{ id, displayName }`; may be empty. */
  list(): LocalMcpVaultSummary[];
}
