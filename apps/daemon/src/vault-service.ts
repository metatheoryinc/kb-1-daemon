import { PersistFailedError, type DocumentSessionManager } from '@kb-2/doc-session';
import type { LocalMcpVaultService, ServiceFailure, ServiceResult } from '@kb-2/local-mcp';
import {
  InvalidPathError,
  appendAudit,
  appendContent,
  applyAnchoredSplice,
  deleteVaultFile,
  deleteVaultFolder,
  getVaultInfo,
  listVaultTree,
  makeVaultFolder,
  moveVaultPath,
  prependContent,
  readVaultFile,
  searchVaultFiles,
  validateVaultPath,
  writeVaultFile,
  type AnchoredSpliceRequest,
  type VaultActor,
  type VaultResult
} from '@kb-2/vault-core';

export interface VaultServiceOptions {
  vaultRoot: string;
  documentSessions?: DocumentSessionManager;
}

export function createVaultService(options: VaultServiceOptions): LocalMcpVaultService {
  const ctx = (actor?: VaultActor) => ({ root: options.vaultRoot, ...(actor ? { actor } : {}) });

  return {
    async vaultInfo() {
      return serviceResult(await getVaultInfo(ctx()));
    },

    async listFiles(input) {
      return serviceResult(await listVaultTree(ctx(), input));
    },

    async readNote(input) {
      const diskRead = await readVaultFile(ctx(), input.path);
      if (!diskRead.ok || !options.documentSessions) {
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
      const liveSession = options.documentSessions?.getOpenSession(input.path);
      if (liveSession) {
        if (!input.overwrite) {
          return failure('already_exists', 'file already exists');
        }
        const applied = await mapWriteFailure(() => liveSession.applyContent(input.content));
        if (!applied.ok) return applied;
        const audit = await appendAudit({
          root: options.vaultRoot,
          actor: input.actor,
          operation: 'write',
          entityKind: 'file',
          path: input.path,
          summary: `Wrote ${input.path}`
        });
        return {
          ok: true,
          path: input.path,
          content: applied.value,
          live: true,
          audit
        };
      }

      return serviceResult(await writeVaultFile(ctx(input.actor), {
        path: input.path,
        content: input.content,
        overwrite: input.overwrite
      }));
    },

    async editNote(input) {
      const diskRead = await readVaultFile(ctx(), input.path);
      if (!diskRead.ok) return serviceResult(diskRead);
      if (!options.documentSessions) {
        return failure('session_unavailable', 'document sessions are unavailable');
      }

      const request: AnchoredSpliceRequest = {
        oldText: input.oldText,
        newText: input.newText,
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.occurrence !== undefined ? { occurrence: input.occurrence } : {})
      };
      const result = await mapWriteFailure(() => options.documentSessions!.withSession(input.path, (session) =>
        session.applyBaselineEdit(input.baseline, (currentContent) => applyAnchoredSplice(currentContent, request))
      ));
      if (!result.ok) return result;
      if (!result.value.ok) return { ok: false, ...withoutOk(result.value) };

      const audit = await appendAudit({
        root: options.vaultRoot,
        actor: input.actor,
        operation: 'splice',
        entityKind: 'file',
        path: input.path,
        summary: `Spliced ${input.path}`
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
      if (!options.documentSessions) {
        return failure('session_unavailable', 'document sessions are unavailable');
      }

      const result = await mapWriteFailure(() => options.documentSessions!.withSession(
        input.path,
        (session) => session.applyContentEdit((currentContent) => appendContent(currentContent, input.content)),
        { defaultContent: '' }
      ));
      if (!result.ok) return result;
      const audit = await appendAudit({
        root: options.vaultRoot,
        actor: input.actor,
        operation: 'append',
        entityKind: 'file',
        path: input.path,
        summary: `Appended to ${input.path}`
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
      if (!options.documentSessions) {
        return failure('session_unavailable', 'document sessions are unavailable');
      }

      const result = await mapWriteFailure(() => options.documentSessions!.withSession(input.path, (session) =>
        session.applyContentEdit((currentContent) => prependContent(currentContent, input.content))
      ));
      if (!result.ok) return result;
      const audit = await appendAudit({
        root: options.vaultRoot,
        actor: input.actor,
        operation: 'prepend',
        entityKind: 'file',
        path: input.path,
        summary: `Prepended to ${input.path}`
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
      const deleteOnDisk = () => expectOk(deleteVaultFile(ctx(input.actor), {
        path: input.path,
        permanent: input.permanent
      }));
      const deletedLive = await mapVaultFailure(() => options.documentSessions?.deleteSession(input.path, deleteOnDisk));
      if (!deletedLive.ok) return deletedLive;
      if (deletedLive.value) {
        return { ok: true, path: input.path, live: true };
      }
      return serviceResult(await deleteVaultFile(ctx(input.actor), {
        path: input.path,
        permanent: input.permanent
      }));
    },

    async moveNote(input) {
      const moveOnDisk = () => expectOk(moveVaultPath(ctx(input.actor), {
        kind: 'file',
        fromPath: input.fromPath,
        toPath: input.toPath
      }));
      const movedLive = await mapVaultFailure(() => options.documentSessions?.moveSession(input.fromPath, input.toPath, moveOnDisk));
      if (!movedLive.ok) return movedLive;
      if (movedLive.value) {
        return { ok: true, fromPath: input.fromPath, toPath: input.toPath, live: true };
      }
      return serviceResult(await moveVaultPath(ctx(input.actor), {
        kind: 'file',
        fromPath: input.fromPath,
        toPath: input.toPath
      }));
    },

    async createFolder(input) {
      return serviceResult(await makeVaultFolder(ctx(input.actor), input.path));
    },

    async deleteFolder(input) {
      const deleteOnDisk = () => expectOk(deleteVaultFolder(ctx(input.actor), {
        path: input.path,
        recursive: input.recursive,
        permanent: input.permanent
      }));
      if (options.documentSessions) {
        const deletedLive = await mapVaultFailure(() => options.documentSessions!.deleteSessionSubtree(input.path, deleteOnDisk));
        if (!deletedLive.ok) return deletedLive;
        return { ok: true, path: input.path, liveDeleted: deletedLive.value };
      }
      return serviceResult(await deleteVaultFolder(ctx(input.actor), {
        path: input.path,
        recursive: input.recursive,
        permanent: input.permanent
      }));
    },

    async moveFolder(input) {
      const moveOnDisk = () => expectOk(moveVaultPath(ctx(input.actor), {
        kind: 'folder',
        fromPath: input.fromPath,
        toPath: input.toPath
      }));
      if (options.documentSessions) {
        const movedLive = await mapVaultFailure(() => options.documentSessions!.moveSessionSubtree(input.fromPath, input.toPath, moveOnDisk));
        if (!movedLive.ok) return movedLive;
        return { ok: true, fromPath: input.fromPath, toPath: input.toPath, liveMoved: movedLive.value };
      }
      return serviceResult(await moveVaultPath(ctx(input.actor), {
        kind: 'folder',
        fromPath: input.fromPath,
        toPath: input.toPath
      }));
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

function failure(error: string, message: string): ServiceFailure {
  return { ok: false, error, message };
}

function validateServiceFilePath(filePath: string): ServiceResult<{ path: string }> {
  try {
    return { ok: true, path: validateVaultPath(filePath, 'file') };
  } catch (error) {
    if (error instanceof InvalidPathError) {
      return failure('invalid_path', error.message);
    }
    throw error;
  }
}

async function expectOk<T>(resultPromise: Promise<VaultResult<T>>): Promise<void> {
  const result = await resultPromise;
  if (!result.ok) {
    throw new VaultResultFailure(result);
  }
}

async function mapVaultFailure<T>(operation: () => T | Promise<T>): Promise<{ ok: true; value: T } | ServiceFailure> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof VaultResultFailure) {
      return vaultFailureResult(error.result);
    }
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
    throw error;
  }
}

class VaultResultFailure extends Error {
  constructor(readonly result: VaultResult<unknown>) {
    super(result.ok ? 'Unexpected successful vault result' : result.message);
  }
}

function vaultFailureResult(result: VaultResult<unknown>): ServiceFailure {
  if (result.ok) {
    throw new Error('Expected failed vault result');
  }
  return failure(result.error, result.message);
}

function withoutOk<T extends { ok: false }>(value: T): Omit<T, 'ok'> {
  const { ok: _ok, ...rest } = value;
  return rest;
}
