import { join } from 'node:path';

import { OneFileDocumentSession, type OneFileDocumentSessionOptions } from './session.js';

export const DEFAULT_IDLE_SESSION_GRACE_MS = 30_000;

export interface DocumentSessionManagerOptions extends OneFileDocumentSessionOptions {
  root: string;
  idleSessionGraceMs?: number;
}

export interface ClientDocumentSession {
  session: OneFileDocumentSession;
  release: () => void;
}

export class DocumentSessionManager {
  private readonly root: string;
  private readonly options: Omit<OneFileDocumentSessionOptions, 'eventPath'>;
  private readonly idleSessionGraceMs: number;
  private readonly sessions = new Map<string, OneFileDocumentSession>();
  private readonly clientCounts = new Map<string, number>();
  private readonly idleCloseTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: DocumentSessionManagerOptions) {
    this.root = options.root;
    this.idleSessionGraceMs = options.idleSessionGraceMs ?? DEFAULT_IDLE_SESSION_GRACE_MS;
    const { root: _root, idleSessionGraceMs: _idleSessionGraceMs, ...sessionOptions } = options;
    this.options = sessionOptions;
  }

  getSession(vaultPath: string, overrides: Partial<Pick<OneFileDocumentSessionOptions, 'defaultContent'>> = {}): OneFileDocumentSession {
    const existing = this.sessions.get(vaultPath);
    if (existing) return existing;

    const session = new OneFileDocumentSession(this.toFilePath(vaultPath), {
      ...this.options,
      ...overrides,
      eventPath: vaultPath
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
    return this.sessions.get(vaultPath);
  }

  getOpenSessionCount(): number {
    return this.sessions.size;
  }

  async moveSession(
    fromPath: string,
    toPath: string,
    moveOnDisk: () => Promise<void>
  ): Promise<boolean> {
    const session = this.sessions.get(fromPath);
    if (!session) return false;

    await session.moveTo(this.toFilePath(toPath), toPath, moveOnDisk);
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

    await Promise.all(matches.map(([, session]) => session.prepareForPathTransition()));
    const diskMove = Promise.resolve().then(moveOnDisk);
    await Promise.all(matches.map(async ([fromPath, session]) => {
      const toPath = `${toFolder}/${fromPath.slice(fromFolder.length + 1)}`;
      await session.completeMoveAfterTransition(this.toFilePath(toPath), toPath, diskMove);
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
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    this.clientCounts.clear();
  }

  private toFilePath(vaultPath: string): string {
    return join(this.root, ...vaultPath.split('/'));
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
    const timer = setTimeout(() => {
      void this.closeSession(vaultPath).catch((error: unknown) => {
        console.warn(`KB-2 failed to close idle document session for ${vaultPath}.`, error);
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
    await session.close();
    if (!this.hasClients(vaultPath) && this.sessions.get(vaultPath) === session) {
      this.sessions.delete(vaultPath);
    }
  }
}
