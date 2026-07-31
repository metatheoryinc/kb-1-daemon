import { createHash } from 'node:crypto';
import { join } from 'node:path';

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

interface DocumentSessionManagerRuntimeSurface {
  onEvent(handler: DocumentSessionEventHandler): () => void;
  attachClientSession(vaultPath: string): ClientDocumentSession;
  withSession<T>(
    vaultPath: string,
    operation: (session: OneFileDocumentSession) => Promise<T>,
    options?: Partial<Pick<OneFileDocumentSessionOptions, 'defaultContent'>>
  ): Promise<T>;
  getOpenSession(vaultPath: string): OneFileDocumentSession | undefined;
  getOpenSessionCount(): number;
  flushDirtySessions(): Promise<FlushDocumentSessionsResult>;
  moveSession(fromPath: string, toPath: string, moveOnDisk: () => Promise<void>): Promise<boolean>;
  moveSessionSubtree(fromFolder: string, toFolder: string, moveOnDisk: () => Promise<void>): Promise<string[]>;
  deleteSessionSubtree(folderPath: string, deleteOnDisk: () => Promise<void>): Promise<string[]>;
  close(): Promise<void>;
}

export class DocumentSessionManager implements DocumentSessionManagerRuntimeSurface {
  private readonly root: string;
  private readonly options: Omit<OneFileDocumentSessionOptions, 'eventPath'>;
  private readonly idleSessionGraceMs: number;
  private readonly sessions = new Map<string, OneFileDocumentSession>();
  private readonly clientCounts = new Map<string, number>();
  private readonly idleCloseTimers = new Map<string, NodeJS.Timeout>();
  private readonly closingSessions = new Set<Promise<void>>();
  private readonly eventHandlers = new Set<DocumentSessionEventHandler>();

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

  attachClientSession(vaultPath: string): ClientDocumentSession {
    const session = this.getSession(vaultPath);
    this.cancelIdleClose(vaultPath);
    this.clientCounts.set(vaultPath, (this.clientCounts.get(vaultPath) ?? 0) + 1);
    let released = false;
    return {
      session,
      release: () => {
        if (released) return;
        released = true;
        const nextCount = (this.clientCounts.get(vaultPath) ?? 1) - 1;
        if (nextCount > 0) {
          this.clientCounts.set(vaultPath, nextCount);
          return;
        }
        this.clientCounts.delete(vaultPath);
        this.scheduleIdleClose(vaultPath);
      }
    };
  }

  async withSession<T>(
    vaultPath: string,
    operation: (session: OneFileDocumentSession) => Promise<T>,
    options: Partial<Pick<OneFileDocumentSessionOptions, 'defaultContent'>> = {}
  ): Promise<T> {
    this.cancelIdleClose(vaultPath);
    const session = this.getSession(vaultPath, options);
    try {
      return await operation(session);
    } finally {
      if (!this.hasClients(vaultPath)) {
        this.scheduleIdleClose(vaultPath);
      }
    }
  }

  getOpenSession(vaultPath: string): OneFileDocumentSession | undefined {
    const session = this.sessions.get(vaultPath);
    if (!session?.isOpened()) return undefined;
    return session;
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
    const session = this.sessions.get(fromPath);
    if (!session) return false;

    await session.moveTo(this.toFilePath(toPath), toPath, moveOnDisk, this.toStateFilePath(toPath));
    this.sessions.delete(fromPath);
    this.sessions.set(toPath, session);
    return true;
  }

  async moveSessionSubtree(
    fromFolder: string,
    toFolder: string,
    moveOnDisk: () => Promise<void>
  ): Promise<string[]> {
    const moved: string[] = [];
    const matches = [...this.sessions.entries()]
      .filter(([path]) => path.startsWith(`${fromFolder}/`))
      .sort(([left], [right]) => left.localeCompare(right));
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
      this.sessions.delete(fromPath);
      this.sessions.set(toPath, session);
      moved.push(toPath);
    }));
    return moved;
  }

  async deleteSession(path: string, deleteOnDisk: () => Promise<void>): Promise<boolean> {
    const session = this.sessions.get(path);
    if (!session) return false;

    await session.deleteWith(deleteOnDisk);
    this.sessions.delete(path);
    return true;
  }

  async deleteSessionSubtree(folderPath: string, deleteOnDisk: () => Promise<void>): Promise<string[]> {
    const matches = [...this.sessions.keys()]
      .filter((path) => path.startsWith(`${folderPath}/`))
      .sort();
    let diskDeleted = false;
    const deleted: string[] = [];

    for (const path of matches) {
      await this.deleteSession(path, async () => {
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
  }

  async close(): Promise<void> {
    for (const timer of this.idleCloseTimers.values()) {
      clearTimeout(timer);
    }
    this.idleCloseTimers.clear();
    await Promise.allSettled([...this.closingSessions]);
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    this.clientCounts.clear();
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

  private hasClients(vaultPath: string): boolean {
    return (this.clientCounts.get(vaultPath) ?? 0) > 0;
  }

  private cancelIdleClose(vaultPath: string): void {
    const existing = this.idleCloseTimers.get(vaultPath);
    if (!existing) return;
    clearTimeout(existing);
    this.idleCloseTimers.delete(vaultPath);
  }

  private scheduleIdleClose(vaultPath: string): void {
    if (this.hasClients(vaultPath) || !this.sessions.has(vaultPath)) return;
    this.cancelIdleClose(vaultPath);
    if (!this.sessions.get(vaultPath)?.isOpened()) {
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

  private async closeSession(vaultPath: string): Promise<void> {
    this.cancelIdleClose(vaultPath);
    if (this.hasClients(vaultPath)) return;
    const session = this.sessions.get(vaultPath);
    if (!session) return;
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
