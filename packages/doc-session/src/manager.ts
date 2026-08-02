import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { statOrNull } from '@kb-1/vault-core';

import { OneFileDocumentSession, type DocumentSessionEventHandler, type OneFileDocumentSessionOptions } from './session.js';

export const DEFAULT_IDLE_SESSION_GRACE_MS = 30_000;
const DOCUMENT_SESSION_STATE_DIR = '.kb1/doc-session-state';

export interface DocumentSessionManagerOptions extends OneFileDocumentSessionOptions {
  root: string;
  idleSessionGraceMs?: number;
}

export interface ClientDocumentSession {
  session: OneFileDocumentSession;
  release: () => void;
}

export interface FlushDocumentSessionsResult {
  flushed: number;
}

export class DocumentSessionPathConflictError extends Error {
  constructor(
    readonly fromPath: string,
    readonly toPath: string
  ) {
    super(`Document session destination is already active: ${toPath}`);
    this.name = 'DocumentSessionPathConflictError';
  }
}

interface DocumentSessionManagerRuntimeSurface {
  onEvent(handler: DocumentSessionEventHandler): () => void;
  attachClientSession(vaultPath: string): Promise<ClientDocumentSession>;
  withSession<T>(
    vaultPath: string,
    operation: (session: OneFileDocumentSession) => Promise<T>,
    options?: Partial<Pick<OneFileDocumentSessionOptions, 'defaultContent'>>
  ): Promise<T>;
  getOpenSession(vaultPath: string): OneFileDocumentSession | undefined;
  withStablePath<T>(
    vaultPath: string,
    operation: (liveSession: OneFileDocumentSession | undefined) => Promise<T>
  ): Promise<T>;
  getOpenSessionCount(): number;
  flushDirtySessions(): Promise<FlushDocumentSessionsResult>;
  moveSession(fromPath: string, toPath: string, moveOnDisk: () => Promise<void>): Promise<boolean>;
  moveSessionSubtree(fromFolder: string, toFolder: string, moveOnDisk: () => Promise<void>): Promise<string[]>;
  deleteSessionSubtree(folderPath: string, deleteOnDisk: () => Promise<void>): Promise<string[]>;
  close(): Promise<void>;
}

interface PathReservation {
  readonly matches: (vaultPath: string) => boolean;
  readonly settled: Promise<void>;
  readonly release: () => void;
}

export class DocumentSessionManager implements DocumentSessionManagerRuntimeSurface {
  private readonly root: string;
  private readonly options: Omit<OneFileDocumentSessionOptions, 'eventPath'>;
  private readonly idleSessionGraceMs: number;
  private readonly sessions = new Map<string, OneFileDocumentSession>();
  private readonly clientCounts = new Map<OneFileDocumentSession, number>();
  private readonly operationCounts = new Map<OneFileDocumentSession, number>();
  private readonly activeSessionOperations = new Set<Promise<void>>();
  private readonly idleCloseTimers = new Map<string, NodeJS.Timeout>();
  private readonly closingSessions = new Set<Promise<void>>();
  private readonly eventHandlers = new Set<DocumentSessionEventHandler>();
  private readonly pathReservations = new Set<PathReservation>();
  private structureMutationTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closing = false;
  private closed = false;

  constructor(options: DocumentSessionManagerOptions) {
    this.root = options.root;
    this.idleSessionGraceMs = options.idleSessionGraceMs ?? DEFAULT_IDLE_SESSION_GRACE_MS;
    const { root: _root, idleSessionGraceMs: _idleSessionGraceMs, ...sessionOptions } = options;
    this.options = sessionOptions;
  }

  onEvent(handler: DocumentSessionEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  getSession(vaultPath: string, overrides: Partial<Pick<OneFileDocumentSessionOptions, 'defaultContent'>> = {}): OneFileDocumentSession {
    this.assertActive();
    if (this.hasPathReservation(vaultPath)) {
      throw new Error(`Document session path is transitioning: ${vaultPath}`);
    }
    this.cancelIdleClose(vaultPath);
    const existing = this.sessions.get(vaultPath);
    if (existing) return existing;

    const session = new OneFileDocumentSession(this.toFilePath(vaultPath), {
      ...this.options,
      ...overrides,
      eventPath: vaultPath,
      stateFilePath: this.toStateFilePath(vaultPath)
    });
    this.sessions.set(vaultPath, session);
    session.onEvent((event) => {
      if (event.kind === 'doc-deleted') {
        for (const [path, candidate] of this.sessions.entries()) {
          if (candidate === session) {
            this.sessions.delete(path);
          }
        }
      }
      this.emitEvent(event);
    });
    return session;
  }

  async attachClientSession(vaultPath: string): Promise<ClientDocumentSession> {
    return this.withAvailablePath(vaultPath, () => {
      const session = this.getSession(vaultPath);
      this.cancelIdleClose(vaultPath);
      this.clientCounts.set(session, (this.clientCounts.get(session) ?? 0) + 1);
      let released = false;
      return {
        session,
        release: () => {
          if (released) return;
          released = true;
          const currentPath = this.findSessionPath(session) ?? vaultPath;
          const nextCount = (this.clientCounts.get(session) ?? 1) - 1;
          if (nextCount > 0) {
            this.clientCounts.set(session, nextCount);
            return;
          }
          this.clientCounts.delete(session);
          if (!this.hasActiveOperations(session)) {
            this.scheduleIdleClose(currentPath);
          }
        }
      };
    });
  }

  async withSession<T>(
    vaultPath: string,
    operation: (session: OneFileDocumentSession) => Promise<T>,
    options: Partial<Pick<OneFileDocumentSessionOptions, 'defaultContent'>> = {}
  ): Promise<T> {
    return this.withAvailablePath(vaultPath, () => {
      this.cancelIdleClose(vaultPath);
      const session = this.getSession(vaultPath, options);
      return this.runSessionOperation(vaultPath, session, operation);
    });
  }

  getOpenSession(vaultPath: string): OneFileDocumentSession | undefined {
    if (this.closing) return undefined;
    if (this.hasPathReservation(vaultPath)) {
      throw new Error(`Document session path is transitioning: ${vaultPath}`);
    }
    const session = this.sessions.get(vaultPath);
    if (!session?.isOpened()) return undefined;
    return session;
  }

  async withStablePath<T>(
    vaultPath: string,
    operation: (liveSession: OneFileDocumentSession | undefined) => Promise<T>
  ): Promise<T> {
    const pathAlreadyReserved = this.hasPathReservation(vaultPath);
    const pathReservation = this.reserveExactPaths([vaultPath]);
    const sessionAtReservation = pathAlreadyReserved ? undefined : this.sessions.get(vaultPath);
    const openReservation = sessionAtReservation?.reserveStableOpenState();
    return this.runStructureMutation(pathReservation, () => {
      const session = this.sessions.get(vaultPath);
      if (openReservation && session === sessionAtReservation) {
        return openReservation.run((opened) => operation(opened ? session : undefined));
      }
      openReservation?.release();
      if (!session) return operation(undefined);
      return session.withStableOpenState((opened) => operation(opened ? session : undefined));
    });
  }

  getOpenSessionCount(): number {
    return this.sessions.size + this.closingSessions.size;
  }

  async flushDirtySessions(): Promise<FlushDocumentSessionsResult> {
    const dirtySessions = [...this.sessions.values()].filter((session) => session.hasUnsettledPersist());
    const results = await Promise.allSettled(dirtySessions.map((session) => session.flush()));
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected) {
      throw rejected.reason;
    }
    return { flushed: dirtySessions.length };
  }

  async moveSession(
    fromPath: string,
    toPath: string,
    moveOnDisk: () => Promise<void>
  ): Promise<boolean> {
    return this.runStructureMutation(this.reserveExactPaths([fromPath, toPath]), async () => {
      const session = this.sessions.get(fromPath);
      const sourceStat = await statOrNull(this.toFilePath(fromPath));
      if (!sourceStat?.isFile()) {
        await moveOnDisk();
        return false;
      }
      const destination = this.sessions.get(toPath);
      if (destination && destination !== session) {
        throw new DocumentSessionPathConflictError(fromPath, toPath);
      }
      if (!session) {
        await moveOnDisk();
        return false;
      }

      await session.moveTo(this.toFilePath(toPath), toPath, moveOnDisk, this.toStateFilePath(toPath));
      this.rekeySession(fromPath, toPath, session);
      return true;
    });
  }

  async moveSessionSubtree(
    fromFolder: string,
    toFolder: string,
    moveOnDisk: () => Promise<void>
  ): Promise<string[]> {
    return this.runStructureMutation(this.reserveSubtrees([fromFolder, toFolder]), async () => {
      const moved: string[] = [];
      const sourceStat = await statOrNull(this.toFilePath(fromFolder));
      if (!sourceStat?.isDirectory()) {
        await moveOnDisk();
        return moved;
      }
      const matches = [...this.sessions.entries()]
        .filter(([path]) => path.startsWith(`${fromFolder}/`))
        .sort(([left], [right]) => left.localeCompare(right));
      const sourceSessions = new Set(matches.map(([, session]) => session));
      const destinationCollision = [...this.sessions.entries()].find(([path, session]) => (
        (path === toFolder || path.startsWith(`${toFolder}/`)) && !sourceSessions.has(session)
      ));
      if (destinationCollision) {
        throw new DocumentSessionPathConflictError(fromFolder, destinationCollision[0]);
      }
      if (matches.length === 0) {
        await moveOnDisk();
        return moved;
      }

      // All live child sessions share one disk move; each session then completes its own in-memory path rebinding after that promise settles.
      await Promise.all(matches.map(([, session]) => session.prepareForPathTransition()));
      const diskMove = Promise.resolve().then(moveOnDisk);
      await Promise.all(matches.map(async ([fromPath, session]) => {
        const toPath = `${toFolder}/${fromPath.slice(fromFolder.length + 1)}`;
        await session.completeMoveAfterTransition(this.toFilePath(toPath), toPath, diskMove, this.toStateFilePath(toPath));
        this.rekeySession(fromPath, toPath, session);
        moved.push(toPath);
      }));
      return moved;
    });
  }

  async deleteSession(path: string, deleteOnDisk: () => Promise<void>): Promise<boolean> {
    return this.runStructureMutation(
      this.reserveExactPaths([path]),
      () => this.deleteSessionUnlocked(path, deleteOnDisk)
    );
  }

  private async deleteSessionUnlocked(path: string, deleteOnDisk: () => Promise<void>): Promise<boolean> {
    const session = this.sessions.get(path);
    if (!session) {
      await deleteOnDisk();
      return false;
    }

    await session.deleteWith(deleteOnDisk);
    this.sessions.delete(path);
    return true;
  }

  async deleteSessionSubtree(folderPath: string, deleteOnDisk: () => Promise<void>): Promise<string[]> {
    return this.runStructureMutation(this.reserveSubtrees([folderPath]), async () => {
      const matches = [...this.sessions.keys()]
        .filter((path) => path.startsWith(`${folderPath}/`))
        .sort();
      let diskDeleted = false;
      const deleted: string[] = [];

      for (const path of matches) {
        await this.deleteSessionUnlocked(path, async () => {
          if (diskDeleted) return;
          diskDeleted = true;
          await deleteOnDisk();
        });
        deleted.push(path);
      }

      if (!diskDeleted) {
        await deleteOnDisk();
      }
      return deleted;
    });
  }

  private async runStructureMutation<T>(reservation: PathReservation, mutation: () => Promise<T>): Promise<T> {
    this.assertActive();
    const result = this.structureMutationTail.then(mutation).finally(reservation.release);
    this.structureMutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closing = true;
    const closeWork = this.structureMutationTail.then(() => this.closeUnlocked());
    this.closePromise = closeWork.then(
      () => {
        this.closed = true;
      },
      (error: unknown) => {
        this.closing = false;
        for (const [vaultPath, session] of this.sessions.entries()) {
          session.resumeAfterCloseFailure();
          if (!this.isSessionInUse(session)) {
            this.scheduleIdleClose(vaultPath);
          }
        }
        this.closePromise = undefined;
        throw error;
      }
    );
    this.structureMutationTail = this.closePromise.then(
      () => undefined,
      () => undefined
    );
    return this.closePromise;
  }

  private async closeUnlocked(): Promise<void> {
    for (const timer of this.idleCloseTimers.values()) {
      clearTimeout(timer);
    }
    this.idleCloseTimers.clear();
    await Promise.allSettled([...this.closingSessions]);
    await Promise.allSettled([...this.activeSessionOperations]);
    const closeResults = await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
    const rejectedClose = closeResults.find((result) => result.status === 'rejected');
    if (rejectedClose) {
      throw rejectedClose.reason;
    }
    this.sessions.clear();
    this.clientCounts.clear();
    this.operationCounts.clear();
    this.activeSessionOperations.clear();
  }

  private reserveExactPaths(paths: string[]): PathReservation {
    return this.createPathReservation((vaultPath) => paths.includes(vaultPath));
  }

  private reserveSubtrees(folders: string[]): PathReservation {
    return this.createPathReservation((vaultPath) => (
      folders.some((folder) => vaultPath === folder || vaultPath.startsWith(`${folder}/`))
    ));
  }

  private createPathReservation(matches: (vaultPath: string) => boolean): PathReservation {
    this.assertActive();
    let releaseReservation: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    let released = false;
    const reservation: PathReservation = {
      matches,
      settled,
      release: () => {
        if (released) return;
        released = true;
        this.pathReservations.delete(reservation);
        releaseReservation?.();
      }
    };
    this.pathReservations.add(reservation);
    return reservation;
  }

  private hasPathReservation(vaultPath: string): boolean {
    return [...this.pathReservations].some((reservation) => reservation.matches(vaultPath));
  }

  private async waitForPathAvailability(vaultPath: string): Promise<void> {
    this.assertActive();
    while (true) {
      const reservations = [...this.pathReservations]
        .filter((reservation) => reservation.matches(vaultPath));
      if (reservations.length === 0) return;
      await Promise.all(reservations.map((reservation) => reservation.settled));
      this.assertActive();
    }
  }

  private async withAvailablePath<T>(vaultPath: string, operation: () => T | Promise<T>): Promise<T> {
    while (true) {
      await this.waitForPathAvailability(vaultPath);
      try {
        return operation();
      } catch (error) {
        if (this.hasPathReservation(vaultPath)) continue;
        throw error;
      }
    }
  }

  private assertActive(): void {
    if (this.closing || this.closed) {
      throw new Error('Document session manager is closed.');
    }
  }

  private emitEvent(event: Parameters<DocumentSessionEventHandler>[0]): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.warn('KB-1 document session manager event handler failed.', error);
      }
    }
  }

  private toFilePath(vaultPath: string): string {
    return join(this.root, ...vaultPath.split('/'));
  }

  private toStateFilePath(vaultPath: string): string {
    return join(this.root, DOCUMENT_SESSION_STATE_DIR, `${hashVaultPath(vaultPath)}.json`);
  }

  private hasActiveOperations(session: OneFileDocumentSession): boolean {
    return (this.operationCounts.get(session) ?? 0) > 0;
  }

  private isSessionInUse(session: OneFileDocumentSession): boolean {
    return (this.clientCounts.get(session) ?? 0) > 0 || this.hasActiveOperations(session);
  }

  private runSessionOperation<T>(
    vaultPath: string,
    session: OneFileDocumentSession,
    operation: (session: OneFileDocumentSession) => Promise<T>
  ): Promise<T> {
    this.operationCounts.set(session, (this.operationCounts.get(session) ?? 0) + 1);
    const result = (async () => {
      try {
        return await operation(session);
      } finally {
        const remaining = (this.operationCounts.get(session) ?? 1) - 1;
        if (remaining > 0) {
          this.operationCounts.set(session, remaining);
        } else {
          this.operationCounts.delete(session);
        }
        const currentPath = this.findSessionPath(session) ?? vaultPath;
        if (!this.isSessionInUse(session)) {
          this.scheduleIdleClose(currentPath);
        }
      }
    })();
    const lifecycle = result.then(
      () => undefined,
      () => undefined
    );
    this.activeSessionOperations.add(lifecycle);
    void lifecycle.finally(() => {
      this.activeSessionOperations.delete(lifecycle);
    });
    return result;
  }

  private findSessionPath(session: OneFileDocumentSession): string | undefined {
    for (const [vaultPath, candidate] of this.sessions.entries()) {
      if (candidate === session) return vaultPath;
    }
    return undefined;
  }

  private rekeySession(fromPath: string, toPath: string, session: OneFileDocumentSession): void {
    this.cancelIdleClose(fromPath);
    this.cancelIdleClose(toPath);
    this.sessions.delete(fromPath);
    this.sessions.set(toPath, session);
    if (!this.isSessionInUse(session)) {
      this.scheduleIdleClose(toPath);
    }
  }

  private cancelIdleClose(vaultPath: string): void {
    const existing = this.idleCloseTimers.get(vaultPath);
    if (!existing) return;
    clearTimeout(existing);
    this.idleCloseTimers.delete(vaultPath);
  }

  private scheduleIdleClose(vaultPath: string): void {
    if (this.closing || this.closed) return;
    const session = this.sessions.get(vaultPath);
    if (!session || this.isSessionInUse(session)) return;
    this.cancelIdleClose(vaultPath);
    if (!session.isOpened()) {
      this.sessions.delete(vaultPath);
      return;
    }
    const timer = setTimeout(() => {
      const closing = this.closeSession(vaultPath);
      this.closingSessions.add(closing);
      void closing
        .catch((error: unknown) => {
          console.warn(`KB-1 failed to close idle document session for ${vaultPath}.`, error);
        })
        .finally(() => {
          this.closingSessions.delete(closing);
        });
    }, this.idleSessionGraceMs);
    timer.unref?.();
    this.idleCloseTimers.set(vaultPath, timer);
  }

  private closeSession(vaultPath: string): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.runStructureMutation(
      this.reserveExactPaths([vaultPath]),
      () => this.closeSessionUnlocked(vaultPath)
    );
  }

  private async closeSessionUnlocked(vaultPath: string): Promise<void> {
    this.cancelIdleClose(vaultPath);
    const session = this.sessions.get(vaultPath);
    if (!session) return;
    if (this.isSessionInUse(session)) return;
    if (session.hasActivePersistFailure()) {
      console.warn(`KB-1 refused to close idle document session for ${vaultPath}; content is not durably persisted.`);
      return;
    }

    // If a client acquires this path while close is in flight, it must hydrate
    // a fresh session rather than reusing a half-detached closing session.
    this.sessions.delete(vaultPath);
    try {
      await session.close();
    } catch (error) {
      if (session.hasActivePersistFailure()) {
        this.sessions.set(vaultPath, session);
        console.warn(`KB-1 refused to close idle document session for ${vaultPath}; content is not durably persisted.`, error);
        return;
      }
      throw error;
    }
  }
}

function hashVaultPath(vaultPath: string): string {
  return createHash('sha256').update(vaultPath).digest('hex');
}
