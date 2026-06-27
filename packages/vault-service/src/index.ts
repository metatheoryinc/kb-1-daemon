import {
  PersistFailedError,
  type DocumentSessionEvent,
  type DocumentSessionManager,
  type DocumentUpdateAttribution,
  type SessionSpliceReject
} from '@kb-2/doc-session';
import {
  InvalidPathError,
  appendContent,
  applyAnchoredSplice,
  deleteVaultFile,
  deleteVaultFolder,
  emitVaultAudit,
  getFolderMetadata as getVaultFolderMetadata,
  getVaultInfo,
  listFolderMetadata as listVaultFolderMetadata,
  listVaultTree,
  makeVaultFolder,
  moveVaultPath,
  onVaultAudit,
  prependContent,
  readVaultFile,
  searchVaultFiles,
  setFolderMetadata as setVaultFolderMetadata,
  validateVaultPath,
  writeVaultFile,
  type AnchoredSpliceRequest,
  type AuditChangeEventOptions,
  type AuditEntry,
  type FolderMetadataInput,
  type VaultActor,
  type VaultErrorCode,
  type VaultResult
} from '@kb-2/vault-core';

export type { AuditEntry, VaultActor };

export type ServiceErrorCode =
  | VaultErrorCode
  | 'stale_doc'
  | 'ambiguous'
  | 'too_large_splice'
  | 'too_large_document'
  | 'persist_failed'
  | 'invalid_request'
  | 'invalid_actor';

type SimpleServiceErrorCode = VaultErrorCode | 'persist_failed' | 'invalid_request' | 'invalid_actor';

export type ServiceFailure =
  | { ok: false; error: SimpleServiceErrorCode; message: string }
  | { ok: false; error: 'stale_doc'; message: string; current_content: string; baseline: string; truncated?: boolean }
  | { ok: false; error: 'ambiguous'; message: string; match_count: number }
  | { ok: false; error: 'too_large_splice'; message: string; limit_bytes: number }
  | { ok: false; error: 'too_large_document'; message: string; current_bytes: number; limit_bytes: number }
  | { ok: false; error: 'persist_failed'; message: string }
  | { ok: false; error: 'invalid_request'; message: string }
  | { ok: false; error: 'invalid_actor'; message: string };

export type ServiceResult<T extends object = object> = ({ ok: true } & T) | ServiceFailure;

export type VaultChangeEventKind =
  | 'content_persisted'
  | 'file_created'
  | 'folder_created'
  | 'file_deleted'
  | 'folder_deleted'
  | 'file_moved'
  | 'folder_moved'
  | 'folder_metadata_changed'
  | 'external_change_detected'
  | 'persist_failure'
  | 'persist_recovered';

export interface VaultChangeEvent {
  kind: VaultChangeEventKind;
  path: string;
  actor: VaultActor;
  ts: string;
  fromPath?: string;
  toPath?: string;
}

export type VaultChangeEventHandler = (event: VaultChangeEvent) => void;

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
  listFolderMetadata(): Promise<ServiceResult>;
  getFolderMetadata(input: { path: string }): Promise<ServiceResult>;
  setFolderMetadata(input: { path: string; metadata: FolderMetadataInput; actor: VaultActor }): Promise<ServiceResult>;
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

export interface VaultService extends LocalMcpVaultService {
  flushDirtySessions(): Promise<ServiceResult<{ flushed: number; durableAsOf: string }>>;
  onEvent(handler: VaultChangeEventHandler): () => void;
}

export interface VaultServiceOptions {
  vaultRoot: string;
  documentSessions: DocumentSessionManager;
}

export function createVaultService(options: VaultServiceOptions): VaultService {
  const ctx = (actor?: VaultActor) => ({ root: options.vaultRoot, ...(actor ? { actor } : {}) });
  const eventHandlers = new Set<VaultChangeEventHandler>();
  const emitChange = (event: VaultChangeEvent) => {
    for (const handler of eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.warn('KB-2 vault change event handler failed.', error);
      }
    }
  };
  let unsubscribeAudit: (() => void) | undefined;
  const ensureAuditSubscription = () => {
    if (unsubscribeAudit) return;
    unsubscribeAudit = onVaultAudit((audit, input) => {
      if (input.root !== options.vaultRoot) return;
      emitAuditChange(emitChange, audit, input.changeEvent);
    });
  };
  const releaseAuditSubscription = () => {
    if (eventHandlers.size > 0) return;
    unsubscribeAudit?.();
    unsubscribeAudit = undefined;
  };
  options.documentSessions.onEvent((event) => {
    const change = changeEventFromDocumentSessionEvent(event);
    if (change) emitChange(change);
  });

  return {
    onEvent(handler) {
      eventHandlers.add(handler);
      ensureAuditSubscription();
      return () => {
        eventHandlers.delete(handler);
        releaseAuditSubscription();
      };
    },

    async flushDirtySessions() {
      const result = await mapWriteFailure(() => options.documentSessions.flushDirtySessions());
      if (!result.ok) return result;
      return {
        ok: true,
        flushed: result.value.flushed,
        durableAsOf: new Date().toISOString()
      };
    },

    async vaultInfo() {
      return serviceResult(await getVaultInfo(ctx()));
    },

    async listFiles(input) {
      return serviceResult(await listVaultTree(ctx(), input));
    },

    async listFolderMetadata() {
      return serviceResult(await listVaultFolderMetadata(ctx()));
    },

    async getFolderMetadata(input) {
      return serviceResult(await getVaultFolderMetadata(ctx(), input.path));
    },

    async setFolderMetadata(input) {
      const result = serviceResult(await setVaultFolderMetadata(ctx(input.actor), input.path, input.metadata));
      return result;
    },

    async readNote(input) {
      const diskRead = await readVaultFile(ctx(), input.path);
      if (!diskRead.ok) {
        return serviceResult(diskRead);
      }

      const baselineRead = await options.documentSessions.withSession(input.path, (session) => session.readWithBaseline());
      return {
        ok: true,
        path: diskRead.value.path,
        content: baselineRead.content,
        baseline: baselineRead.baseline,
        size: diskRead.value.size,
        mtimeMs: diskRead.value.mtimeMs
      };
    },

    async createNote(input) {
      const liveSession = options.documentSessions.getOpenSession(input.path);
      if (liveSession) {
        if (!input.overwrite) {
          return failure('already_exists', 'file already exists');
        }
        const applied = await mapWriteFailure(() => liveSession.applyContent(
          input.content,
          { attribution: documentUpdateAttribution(input.actor, 'write', input.path) }
        ));
        if (!applied.ok) return applied;
        const audit = await emitVaultAudit({
          root: options.vaultRoot,
          actor: input.actor,
          operation: 'write',
          entityKind: 'file',
          path: input.path,
          summary: `Wrote ${input.path}`,
          changeEvent: { skipContentPersisted: true }
        });
        return {
          ok: true,
          path: input.path,
          content: applied.value,
          live: true,
          audit
        };
      }

      const result = serviceResult(await writeVaultFile(ctx(input.actor), {
        path: input.path,
        content: input.content,
        overwrite: input.overwrite
      }));
      return result;
    },

    async editNote(input) {
      const diskRead = await readVaultFile(ctx(), input.path);
      if (!diskRead.ok) return serviceResult(diskRead);
      const request: AnchoredSpliceRequest = {
        oldText: input.oldText,
        newText: input.newText,
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.occurrence !== undefined ? { occurrence: input.occurrence } : {})
      };
      const result = await mapWriteFailure(() => options.documentSessions.withSession(input.path, (session) =>
        session.applyBaselineEdit(
          input.baseline,
          (currentContent) => applyAnchoredSplice(currentContent, request),
          { attribution: documentUpdateAttribution(input.actor, 'splice', input.path) }
        )
      ));
      if (!result.ok) return result;
      if (!result.value.ok) return sessionFailureResult(result.value);

      const audit = await emitVaultAudit({
        root: options.vaultRoot,
        actor: input.actor,
        operation: 'splice',
        entityKind: 'file',
        path: input.path,
        summary: `Spliced ${input.path}`,
        changeEvent: { skipContentPersisted: true }
      });
      return {
        ok: true,
        path: input.path,
        content: result.value.content,
        baseline: result.value.baseline,
        audit
      };
    },

    async appendNote(input) {
      const validPath = validateServiceFilePath(input.path);
      if (!validPath.ok) return validPath;
      const result = await mapWriteFailure(() => options.documentSessions.withSession(
        input.path,
        (session) => session.applyContentEdit(
          (currentContent) => appendContent(currentContent, input.content),
          { attribution: documentUpdateAttribution(input.actor, 'append', input.path) }
        ),
        { defaultContent: '' }
      ));
      if (!result.ok) return result;
      const audit = await emitVaultAudit({
        root: options.vaultRoot,
        actor: input.actor,
        operation: 'append',
        entityKind: 'file',
        path: input.path,
        summary: `Appended to ${input.path}`,
        changeEvent: { skipContentPersisted: true }
      });
      return {
        ok: true,
        path: input.path,
        content: result.value.content,
        baseline: result.value.baseline,
        audit
      };
    },

    async prependNote(input) {
      const diskRead = await readVaultFile(ctx(), input.path);
      if (!diskRead.ok) return serviceResult(diskRead);
      const result = await mapWriteFailure(() => options.documentSessions.withSession(input.path, (session) =>
        session.applyContentEdit(
          (currentContent) => prependContent(currentContent, input.content),
          { attribution: documentUpdateAttribution(input.actor, 'prepend', input.path) }
        )
      ));
      if (!result.ok) return result;
      const audit = await emitVaultAudit({
        root: options.vaultRoot,
        actor: input.actor,
        operation: 'prepend',
        entityKind: 'file',
        path: input.path,
        summary: `Prepended to ${input.path}`,
        changeEvent: { skipContentPersisted: true }
      });
      return {
        ok: true,
        path: input.path,
        content: result.value.content,
        baseline: result.value.baseline,
        audit
      };
    },

    async deleteNote(input) {
      let deleted: Awaited<ReturnType<typeof deleteVaultFile>> extends VaultResult<infer T> ? T : never;
      const deleteOnDisk = async () => {
        deleted = await expectOkValue(deleteVaultFile(ctx(input.actor), {
          path: input.path,
          permanent: input.permanent
        }));
      };
      const deletedLive = await mapVaultFailure(() => options.documentSessions.deleteSession(input.path, deleteOnDisk));
      if (!deletedLive.ok) return deletedLive;
      if (deletedLive.value) {
        return { ok: true, ...deleted!, live: true };
      }
      const result = serviceResult(await deleteVaultFile(ctx(input.actor), {
        path: input.path,
        permanent: input.permanent
      }));
      return result;
    },

    async moveNote(input) {
      let moved: Awaited<ReturnType<typeof moveVaultPath>> extends VaultResult<infer T> ? T : never;
      const moveOnDisk = async () => {
        moved = await expectOkValue(moveVaultPath(ctx(input.actor), {
          kind: 'file',
          fromPath: input.fromPath,
          toPath: input.toPath
        }));
      };
      const movedLive = await mapVaultFailure(() => options.documentSessions.moveSession(input.fromPath, input.toPath, moveOnDisk));
      if (!movedLive.ok) return movedLive;
      if (movedLive.value) {
        return { ok: true, ...moved!, live: true };
      }
      const result = serviceResult(await moveVaultPath(ctx(input.actor), {
        kind: 'file',
        fromPath: input.fromPath,
        toPath: input.toPath
      }));
      return result;
    },

    async createFolder(input) {
      const result = serviceResult(await makeVaultFolder(ctx(input.actor), input.path));
      return result;
    },

    async deleteFolder(input) {
      let deleted: Awaited<ReturnType<typeof deleteVaultFolder>> extends VaultResult<infer T> ? T : never;
      const deleteOnDisk = async () => {
        deleted = await expectOkValue(deleteVaultFolder(ctx(input.actor), {
          path: input.path,
          recursive: input.recursive,
          permanent: input.permanent
        }));
      };
      const deletedLive = await mapVaultFailure(() => options.documentSessions.deleteSessionSubtree(input.path, deleteOnDisk));
      if (!deletedLive.ok) return deletedLive;
      return { ok: true, ...deleted!, liveDeleted: deletedLive.value };
    },

    async moveFolder(input) {
      let moved: Awaited<ReturnType<typeof moveVaultPath>> extends VaultResult<infer T> ? T : never;
      const moveOnDisk = async () => {
        moved = await expectOkValue(moveVaultPath(ctx(input.actor), {
          kind: 'folder',
          fromPath: input.fromPath,
          toPath: input.toPath
        }));
      };
      const movedLive = await mapVaultFailure(() => options.documentSessions.moveSessionSubtree(input.fromPath, input.toPath, moveOnDisk));
      if (!movedLive.ok) return movedLive;
      return { ok: true, ...moved!, liveMoved: movedLive.value };
    },

    async search(input) {
      try {
        return {
          ok: true,
          ...await searchVaultFiles(options.vaultRoot, {
            q: input.query,
            under: input.under,
            context: input.context,
            limit: input.limit,
            offset: input.offset
          })
        };
      } catch (error) {
        if (error instanceof InvalidPathError) {
          return failure('invalid_path', error.message);
        }
        /* v8 ignore next -- Non-validation search failures must propagate; invalid-path mapping is covered with real inputs. */
        throw error;
      }
    }
  };
}

function serviceResult<T extends object>(result: VaultResult<T>): ServiceResult<T> {
  if (result.ok) {
    return { ok: true, ...result.value };
  }

  return failure(result.error, result.message);
}

function failure(error: SimpleServiceErrorCode, message: string): ServiceFailure {
  return { ok: false, error, message };
}

function changeEventFromDocumentSessionEvent(event: DocumentSessionEvent): VaultChangeEvent | undefined {
  const actor: VaultActor = { kind: 'system' };
  const base = {
    path: event.path,
    actor,
    ts: new Date(event.ts).toISOString()
  };

  switch (event.kind) {
    case 'content-persisted':
      return { ...base, kind: 'content_persisted' };
    case 'external-merge':
    case 'external-change':
      return { ...base, kind: 'external_change_detected' };
    case 'persist-failure':
      return { ...base, kind: 'persist_failure' };
    case 'persist-recovered':
      return { ...base, kind: 'persist_recovered' };
    case 'doc-moved':
    case 'doc-deleted':
      return undefined;
  }
  /* v8 ignore next -- Exhaustive switch guard for future document-session event codes. */
  return assertNever(event.kind);
}

function documentUpdateAttribution(
  actor: VaultActor,
  operation: string,
  path: string
): DocumentUpdateAttribution {
  return {
    actor: actorAttribution(actor),
    operation,
    path
  };
}

function actorAttribution(actor: VaultActor): DocumentUpdateAttribution {
  return {
    kind: actor.kind,
    ...(actor.id !== undefined ? { id: actor.id } : {}),
    ...(actor.name !== undefined ? { name: actor.name } : {}),
    ...(actor.client !== undefined ? { client: actor.client } : {})
  };
}

function emitAuditChange(
  emit: VaultChangeEventHandler,
  audit: AuditEntry,
  options: AuditChangeEventOptions = {}
): void {
  const kind = auditChangeEventKind(audit, options);
  if (!kind) return;

  emit({
    kind,
    path: audit.toPath ?? audit.path,
    actor: audit.actor,
    ts: audit.ts,
    ...(audit.fromPath !== undefined ? { fromPath: audit.fromPath } : {}),
    ...(audit.toPath !== undefined ? { toPath: audit.toPath } : {})
  });
}

function auditChangeEventKind(
  audit: AuditEntry,
  options: AuditChangeEventOptions
): VaultChangeEventKind | undefined {
  switch (audit.operation) {
    case 'create':
      return audit.entityKind === 'file' ? 'file_created' : 'folder_created';
    case 'mkdir':
      return 'folder_created';
    case 'write':
      if (audit.entityKind === 'folder') return 'folder_metadata_changed';
      return options.skipContentPersisted === true ? undefined : 'content_persisted';
    case 'splice':
    case 'append':
    case 'prepend':
      return options.skipContentPersisted === true ? undefined : 'content_persisted';
    case 'delete':
      return audit.entityKind === 'file' ? 'file_deleted' : 'folder_deleted';
    case 'move':
      return audit.entityKind === 'file' ? 'file_moved' : 'folder_moved';
  }
  /* v8 ignore next -- Exhaustive switch guard for future audit operation codes. */
  return assertNever(audit.operation);
}

/* v8 ignore next -- Called only by exhaustive guards when a future union member is missing above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled event code: ${String(value)}`);
}

function validateServiceFilePath(filePath: string): ServiceResult<{ path: string }> {
  try {
    return { ok: true, path: validateVaultPath(filePath, 'file') };
  } catch (error) {
    if (error instanceof InvalidPathError) {
      return failure('invalid_path', error.message);
    }
    /* v8 ignore next -- validateVaultPath only throws InvalidPathError for user input; this guard protects future validators. */
    throw error;
  }
}

async function expectOkValue<T>(resultPromise: Promise<VaultResult<T>>): Promise<T> {
  const result = await resultPromise;
  if (!result.ok) {
    throw new VaultResultFailure(result);
  }
  return result.value;
}

async function mapVaultFailure<T>(operation: () => T | Promise<T>): Promise<{ ok: true; value: T } | ServiceFailure> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof VaultResultFailure) {
      return vaultFailureResult(error.result);
    }
    /* v8 ignore next -- Non-vault exceptions must propagate; callers only synthesize VaultResultFailure in tests and live disk callbacks. */
    throw error;
  }
}

async function mapWriteFailure<T>(operation: () => T | Promise<T>): Promise<{ ok: true; value: T } | ServiceFailure> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof PersistFailedError) {
      return failure('persist_failed', 'Document edit could not be durably saved to disk.');
    }
    /* v8 ignore next -- Non-persist exceptions must propagate; coverage exercises the PersistFailedError mapping path. */
    throw error;
  }
}

class VaultResultFailure extends Error {
  constructor(readonly result: VaultResult<unknown>) {
    super(result.ok ? 'Unexpected successful vault result' : result.message);
  }
}

function vaultFailureResult(result: VaultResult<unknown>): ServiceFailure {
  /* v8 ignore next -- VaultResultFailure is constructed only from failed VaultResult values. */
  if (result.ok) {
    throw new Error('Expected failed vault result');
  }
  return failure(result.error, result.message);
}

function sessionFailureResult(value: SessionSpliceReject): ServiceFailure {
  switch (value.rejected) {
    case 'not_found':
      return failure('not_found', 'text to replace was not found');
    case 'stale_doc':
      return {
        ok: false,
        error: 'stale_doc',
        message: 'document changed since the provided baseline',
        current_content: value.current_content,
        baseline: value.baseline,
        ...(value.truncated === true ? { truncated: true } : {})
      };
    case 'ambiguous':
      return {
        ok: false,
        error: 'ambiguous',
        message: 'text to replace matched multiple locations',
        match_count: value.match_count
      };
    case 'too_large_splice':
      return {
        ok: false,
        error: 'too_large_splice',
        message: 'splice text exceeds the byte limit',
        limit_bytes: value.limit_bytes
      };
    case 'too_large_document':
      return {
        ok: false,
        error: 'too_large_document',
        message: 'document would exceed the byte limit',
        current_bytes: value.current_bytes,
        limit_bytes: value.limit_bytes
      };
  }
  /* v8 ignore next -- Exhaustive switch guard for future session rejection codes. */
  throw new Error(`Unhandled service failure: ${JSON.stringify(value)}`);
}
