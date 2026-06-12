import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

export interface VaultActor {
  kind: 'user' | 'mcp_client' | 'integration' | 'system' | 'unknown';
  id?: string;
  name?: string;
  client?: string;
}

export type AuditOperation =
  | 'create'
  | 'write'
  | 'mkdir'
  | 'delete'
  | 'move'
  | 'splice'
  | 'append'
  | 'prepend';
export type AuditEntityKind = 'file' | 'folder';

export interface AuditEntry {
  id: string;
  ts: string;
  actor: VaultActor;
  operation: AuditOperation;
  entityKind: AuditEntityKind;
  path: string;
  fromPath?: string;
  toPath?: string;
  summary: string;
}

export interface AuditChangeEventOptions {
  skipContentPersisted?: boolean;
}

export interface AuditInput {
  root: string;
  actor?: VaultActor;
  operation: AuditOperation;
  entityKind: AuditEntityKind;
  path: string;
  fromPath?: string;
  toPath?: string;
  summary: string;
  changeEvent?: AuditChangeEventOptions;
}

export type VaultAuditHandler = (audit: AuditEntry, input: AuditInput) => void;

const vaultAuditHandlers = new Set<VaultAuditHandler>();

export function onVaultAudit(handler: VaultAuditHandler): () => void {
  vaultAuditHandlers.add(handler);
  return () => {
    vaultAuditHandlers.delete(handler);
  };
}

export async function emitVaultAudit(input: AuditInput): Promise<AuditEntry> {
  const entry = await writeAuditEntry(input);
  notifyVaultAuditHandlers(entry, input);
  return entry;
}

function notifyVaultAuditHandlers(entry: AuditEntry, input: AuditInput): void {
  for (const handler of vaultAuditHandlers) {
    try {
      handler(entry, input);
    } catch (error) {
      console.warn('KB-2 vault audit handler failed.', error);
    }
  }
}

async function writeAuditEntry(input: AuditInput): Promise<AuditEntry> {
  const entry: AuditEntry = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    actor: input.actor ?? { kind: 'user' },
    operation: input.operation,
    entityKind: input.entityKind,
    path: input.path,
    ...(input.fromPath !== undefined ? { fromPath: input.fromPath } : {}),
    ...(input.toPath !== undefined ? { toPath: input.toPath } : {}),
    summary: input.summary
  };
  const dir = path.join(input.root, '.kb2', 'audit');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, 'changes.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}
