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
 * `default` is the vault used when a tool call omits `vaultId`; it keeps the
 * single-vault MCP surface byte-for-byte backward compatible. `resolve` returns
 * the service for a given slug, or `undefined` when no vault carries that slug.
 */
export interface LocalMcpVaultProvider {
  /** The vault served when a tool call omits `vaultId`. */
  default(): LocalMcpVaultService;
  /** Resolve a vault's service by slug, or `undefined` when unknown. */
  resolve(id: string): LocalMcpVaultService | undefined;
  /** Every addressable vault as `{ id, displayName }`. */
  list(): LocalMcpVaultSummary[];
}
