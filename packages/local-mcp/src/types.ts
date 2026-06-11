import type { LocalMcpVaultService, ServiceFailure, ServiceResult, VaultActor } from '@kb-2/vault-service';

export type { LocalMcpVaultService, ServiceFailure, ServiceResult, VaultActor };

export type LocalMcpActor = { kind: 'mcp_client'; client: string };
