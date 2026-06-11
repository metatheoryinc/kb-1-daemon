import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

export interface VaultActor {
  kind: 'user' | 'mcp_client' | 'integration' | 'system';
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

export interface AuditInput {
  root: string;
  actor?: VaultActor;
  operation: AuditOperation;
  entityKind: AuditEntityKind;
  path: string;
  fromPath?: string;
  toPath?: string;
  summary: string;
}

export async function emitVaultAudit(input: AuditInput): Promise<AuditEntry> {
  return writeAuditEntry(input);
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
