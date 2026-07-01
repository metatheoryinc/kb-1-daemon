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
  classifyArtifactPath,
  deleteVaultFile,
  deleteVaultFolder,
  emitVaultAudit,
  flushFileHistory,
  historyOperationFromAudit,
  getFolderMetadata as getVaultFolderMetadata,
  getVaultInfo,
  listFileHistory,
  listFolderMetadata as listVaultFolderMetadata,
  listVaultTree,
  makeVaultFolder,
  moveFileHistory,
  moveFolderHistory,
  moveVaultPath,
  onVaultAudit,
  prependContent,
  readVaultRawFile,
  readVaultFile,
  recordFileHistory,
  searchVaultFiles,
  setFolderMetadata as setVaultFolderMetadata,
  validateVaultPath,
  writeVaultRawFile,
  writeVaultFile,
  type AnchoredSpliceRequest,
  type AuditChangeEventOptions,
  type AuditEntry,
  type ArtifactInfo,
  type FileHistoryEntry,
  type FolderMetadataInput,
  type ReadRawFileValue,
  type VaultEntry,
  type VaultActor,
  type VaultErrorCode,
  type VaultResult,
  type WriteRawFileValue
} from '@kb-2/vault-core';

export type { AuditEntry, VaultActor };
export type { ArtifactInfo };
export type { FileHistoryEntry };

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
  | 'vault_metadata_changed'
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

const TREE_WATCH_INTERVAL_MS = 1_000;

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
  readRawFile(input: { path: string }): Promise<ServiceResult<ReadRawFileValue>>;
  writeRawFile(input: { path: string; bytes: Uint8Array; overwrite?: boolean; actor: VaultActor }): Promise<ServiceResult<WriteRawFileValue>>;
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
  listNoteHistory(input: { path: string; before?: string; beforeId?: string; limit?: number }): Promise<ServiceResult<{ entries: FileHistoryEntry[]; hasMore: boolean }>>;
  flushDirtySessions(): Promise<ServiceResult<{ flushed: number; durableAsOf: string }>>;
  onEvent(handler: VaultChangeEventHandler): () => void;
}

export interface VaultServiceOptions {
  vaultRoot: string;
  documentSessions: DocumentSessionManager;
  historyCoalesceWindowMs?: number;
}

export function createVaultService(options: VaultServiceOptions): VaultService {
  const ctx = (actor?: VaultActor) => ({ root: options.vaultRoot, ...(actor ? { actor } : {}) });
  const eventHandlers = new Set<VaultChangeEventHandler>();
  const emitChange = (event: VaultChangeEvent) => {
    if (event.kind !== 'external_change_detected') {
      treeWatchSnapshot = undefined;
    }
    for (const handler of eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.warn('KB-2 vault change event handler failed.', error);
      }
    }
  };
  let unsubscribeAudit: (() => void) | undefined;
  let treeWatchTimer: ReturnType<typeof setInterval> | undefined;
  let treeWatchSnapshot: string | undefined;
  let treeWatchInFlight = false;
  const ensureAuditSubscription = () => {
    if (unsubscribeAudit) return;
    unsubscribeAudit = onVaultAudit((audit, input) => {
      if (input.root !== options.vaultRoot) return;
      emitAuditChange(emitChange, audit, input.changeEvent);
    });
  };
  const pollTreeWatch = async () => {
    if (treeWatchInFlight) return;

    treeWatchInFlight = true;
    try {
      const result = await listVaultTree(ctx(), { depth: Number.MAX_SAFE_INTEGER });
      if (!result.ok) return;

      const nextSnapshot = treeSnapshot(result.value.entries);
      if (treeWatchSnapshot === undefined) {
        treeWatchSnapshot = nextSnapshot;
        return;
      }

      if (treeWatchSnapshot === nextSnapshot) return;

      treeWatchSnapshot = nextSnapshot;
      emitChange({
        kind: 'external_change_detected',
        path: '',
        actor: { kind: 'system' },
        ts: new Date().toISOString()
      });
    } catch (error) {
      console.warn('KB-2 vault tree watch failed.', error);
    } finally {
      treeWatchInFlight = false;
    }
  };
  const ensureTreeWatch = () => {
    if (treeWatchTimer) return;

    treeWatchSnapshot = undefined;
    void pollTreeWatch();
    treeWatchTimer = setInterval(() => {
      void pollTreeWatch();
    }, TREE_WATCH_INTERVAL_MS);
  };
  const releaseTreeWatch = () => {
    if (!treeWatchTimer) return;

    clearInterval(treeWatchTimer);
    treeWatchTimer = undefined;
    treeWatchSnapshot = undefined;
    treeWatchInFlight = false;
  };
  const ensureEventSources = () => {
    ensureAuditSubscription();
    ensureTreeWatch();
  };
  const releaseAuditSubscription = () => {
    if (eventHandlers.size > 0) return;
    unsubscribeAudit?.();
    unsubscribeAudit = undefined;
  };
  const releaseEventSources = () => {
    if (eventHandlers.size > 0) return;
    releaseAuditSubscription();
    releaseTreeWatch();
  };
  options.documentSessions.onEvent((event) => {
    const change = changeEventFromDocumentSessionEvent(event);
    if (change) emitChange(change);
    if (
      event.kind === 'content-persisted' &&
      event.attribution !== undefined &&
      !isServiceWriteAttribution(event.attribution)
    ) {
      void recordPersistedSessionHistory(event).catch((error: unknown) => {
        console.warn('KB-2 failed to record file history for persisted document session.', error);
      });
    }
  });
  const recordHistory = async (
    path: string,
    operation: 'create' | 'update',
    actor: VaultActor,
    content: string
  ): Promise<void> => {
    const result = await recordFileHistory(options.vaultRoot, {
      path,
      operation,
      actor,
      content,
      coalesceWindowMs: options.historyCoalesceWindowMs
    });
    if (!result.ok) {
      throw new Error(`Failed to record file history for ${path}: ${result.message}`);
    }
  };
  const recordHistoryFromAudit = async (audit: AuditEntry, content: string): Promise<void> => {
    const operation = historyOperationFromAudit(audit.operation);
    if (operation !== 'create' && operation !== 'update') return;
    await recordHistory(audit.path, operation, audit.actor, content);
  };
  const recordServiceHistoryFromAudit = async (audit: AuditEntry, content: string): Promise<void> => {
    try {
      await recordHistoryFromAudit(audit, content);
    } catch (error: unknown) {
      console.warn('KB-2 failed to record file history for service write.', error);
    }
  };
  const flushPendingHistory = async (paths?: string[]): Promise<void> => {
    try {
      const result = await flushFileHistory(options.vaultRoot, paths === undefined ? {} : { paths });
      if (!result.ok) {
        throw new Error(`Failed to flush file history: ${result.message}`);
      }
    } catch (error: unknown) {
      console.warn('KB-2 failed to flush file history.', error);
    }
  };
  const recordPersistedSessionHistory = async (event: DocumentSessionEvent): Promise<void> => {
    const actor = vaultActorFromDocumentAttribution(event.attribution);
    const read = await readVaultFile(ctx(), event.path);
    if (!read.ok) return;
    await recordHistory(event.path, 'update', actor, read.value.content);
  };
  const carryHistoryAfterFileMove = async (moved: {
    fromPath: string;
    toPath: string;
    audit: AuditEntry;
  }): Promise<void> => {
    try {
      const read = await readVaultFile(ctx(), moved.toPath);
      if (!read.ok) return;
      const result = await moveFileHistory(options.vaultRoot, {
        fromPath: moved.fromPath,
        toPath: moved.toPath,
        actor: moved.audit.actor,
        content: read.value.content,
        coalesceWindowMs: options.historyCoalesceWindowMs,
      });
      if (!result.ok) {
        throw new Error(`Failed to move file history from ${moved.fromPath} to ${moved.toPath}: ${result.message}`);
      }
    } catch (error: unknown) {
      console.warn('KB-2 failed to carry file history after note move.', error);
    }
  };
  const carryHistoryAfterFolderMove = async (moved: {
    fromPath: string;
    toPath: string;
    audit: AuditEntry;
  }): Promise<void> => {
    try {
      const result = await moveFolderHistory(options.vaultRoot, {
        fromPath: moved.fromPath,
        toPath: moved.toPath,
        actor: moved.audit.actor,
      });
      if (!result.ok) {
        throw new Error(`Failed to move folder history from ${moved.fromPath} to ${moved.toPath}: ${result.message}`);
      }
    } catch (error: unknown) {
      console.warn('KB-2 failed to carry file history after folder move.', error);
    }
  };

  return {
    onEvent(handler) {
      eventHandlers.add(handler);
      ensureEventSources();
      return () => {
        eventHandlers.delete(handler);
        releaseEventSources();
      };
    },

    async flushDirtySessions() {
      const result = await mapWriteFailure(() => options.documentSessions.flushDirtySessions());
      if (!result.ok) return result;
      await flushPendingHistory();
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

    async readRawFile(input) {
      return serviceResult(await readVaultRawFile(ctx(), input.path));
    },

    async writeRawFile(input) {
      return serviceResult(await writeVaultRawFile(ctx(input.actor), {
        path: input.path,
        bytes: input.bytes,
        overwrite: input.overwrite
      }));
    },

    async listNoteHistory(input) {
      const read = await readVaultFile(ctx(), input.path);
      if (!read.ok && read.error === 'not_found') {
        return { ok: true, entries: [], hasMore: false };
      }
      return serviceResult(await listFileHistory(options.vaultRoot, input));
    },

    async createNote(input) {
      const validPath = validateServiceFilePath(input.path);
      if (!validPath.ok) return validPath;
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
        await recordServiceHistoryFromAudit(audit, applied.value);
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
      if (result.ok) {
        await recordServiceHistoryFromAudit(result.audit, input.content);
      }
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
      await recordServiceHistoryFromAudit(audit, result.value.content);
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
      await recordServiceHistoryFromAudit(audit, result.value.content);
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
      await recordServiceHistoryFromAudit(audit, result.value.content);
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
      await flushPendingHistory([input.fromPath]);
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
        await carryHistoryAfterFileMove(moved!);
        return { ok: true, ...moved!, live: true };
      }
      const result = serviceResult(await moveVaultPath(ctx(input.actor), {
        kind: 'file',
        fromPath: input.fromPath,
        toPath: input.toPath
      }));
      if (result.ok) {
        await carryHistoryAfterFileMove(result);
      }
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
      await flushPendingHistory();
      const moveOnDisk = async () => {
        moved = await expectOkValue(moveVaultPath(ctx(input.actor), {
          kind: 'folder',
          fromPath: input.fromPath,
          toPath: input.toPath
        }));
      };
      const movedLive = await mapVaultFailure(() => options.documentSessions.moveSessionSubtree(input.fromPath, input.toPath, moveOnDisk));
      if (!movedLive.ok) return movedLive;
      await carryHistoryAfterFolderMove(moved!);
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

function vaultActorFromDocumentAttribution(attribution: DocumentUpdateAttribution | undefined): VaultActor {
  const actor = attribution?.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    return { kind: 'unknown' };
  }
  const candidate = actor as Record<string, unknown>;
  if (
    candidate.kind !== 'user' &&
    candidate.kind !== 'mcp_client' &&
    candidate.kind !== 'integration' &&
    candidate.kind !== 'system' &&
    candidate.kind !== 'unknown'
  ) {
    return { kind: 'unknown' };
  }
  return {
    kind: candidate.kind,
    ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
    ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    ...(typeof candidate.client === 'string' ? { client: candidate.client } : {})
  };
}

function isServiceWriteAttribution(attribution: DocumentUpdateAttribution): boolean {
  return typeof attribution.operation === 'string';
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

function treeSnapshot(entries: VaultEntry[]): string {
  return JSON.stringify(
    entries
      .map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {})
      }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind))
  );
}

/* v8 ignore next -- Called only by exhaustive guards when a future union member is missing above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled event code: ${String(value)}`);
}

function validateServiceFilePath(filePath: string): ServiceResult<{ path: string }> {
  try {
    const path = validateVaultPath(filePath, 'file');
    const artifact = classifyArtifactPath(path);
    if (!artifact.editable) {
      return failure('not_editable', 'file is not an editable text artifact');
    }
    return { ok: true, path };
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
