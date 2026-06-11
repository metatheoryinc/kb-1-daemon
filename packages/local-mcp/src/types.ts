export interface VaultActor {
  kind: 'user' | 'mcp_client' | 'integration' | 'system';
  client?: string;
}

export interface AuditEntry {
  id: string;
  ts: string;
  actor: VaultActor;
  operation: string;
  entityKind: 'file' | 'folder';
  path: string;
  fromPath?: string;
  toPath?: string;
  summary: string;
}

export interface VaultEntry {
  path: string;
  kind: 'file' | 'folder';
  size: number;
  mtimeMs: number;
}

export type LocalMcpActor = { kind: 'mcp_client'; client: string };

export type ServiceResult<T extends object = object> = { ok: true } & T | ServiceFailure;

export type ServiceFailure =
  | { ok: false; error: string; message: string }
  | ({ ok: false; rejected: string } & Record<string, unknown>);

export interface ReadNoteValue {
  path: string;
  content: string;
  baseline: string;
  size: number;
  mtimeMs: number;
}

export interface EditNoteInput {
  path: string;
  baseline: string;
  oldText: string;
  newText: string;
  before?: string;
  after?: string;
  occurrence?: number;
}

export interface LocalMcpVaultService {
  vaultInfo(): Promise<ServiceResult>;
  listFiles(input: { under?: string; depth?: number }): Promise<ServiceResult>;
  readNote(input: { path: string }): Promise<ServiceResult>;
  createNote(input: { path: string; content: string; overwrite?: boolean; actor: VaultActor }): Promise<ServiceResult>;
  editNote(input: EditNoteInput & { actor: VaultActor }): Promise<ServiceResult>;
  appendNote(input: { path: string; content: string; actor: VaultActor }): Promise<ServiceResult>;
  prependNote(input: { path: string; content: string; actor: VaultActor }): Promise<ServiceResult>;
  deleteNote(input: { path: string; permanent?: boolean; actor: VaultActor }): Promise<ServiceResult>;
  moveNote(input: { fromPath: string; toPath: string; actor: VaultActor }): Promise<ServiceResult>;
  createFolder(input: { path: string; actor: VaultActor }): Promise<ServiceResult>;
  deleteFolder(input: { path: string; recursive?: boolean; permanent?: boolean; actor: VaultActor }): Promise<ServiceResult>;
  moveFolder(input: { fromPath: string; toPath: string; actor: VaultActor }): Promise<ServiceResult>;
  search(input: { query: string; under?: string; context?: number; limit?: number; offset?: number }): Promise<ServiceResult>;
}
