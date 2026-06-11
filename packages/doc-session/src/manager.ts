import { join } from 'node:path';

import { OneFileDocumentSession, type OneFileDocumentSessionOptions } from './session.js';

export interface DocumentSessionManagerOptions extends OneFileDocumentSessionOptions {
  root: string;
}

export class DocumentSessionManager {
  private readonly root: string;
  private readonly options: Omit<OneFileDocumentSessionOptions, 'eventPath'>;
  private readonly sessions = new Map<string, OneFileDocumentSession>();

  constructor(options: DocumentSessionManagerOptions) {
    this.root = options.root;
    const { root: _root, ...sessionOptions } = options;
    this.options = sessionOptions;
  }

  getSession(vaultPath: string): OneFileDocumentSession {
    const existing = this.sessions.get(vaultPath);
    if (existing) return existing;

    const session = new OneFileDocumentSession(this.toFilePath(vaultPath), {
      ...this.options,
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

  getOpenSession(vaultPath: string): OneFileDocumentSession | undefined {
    return this.sessions.get(vaultPath);
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
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
  }

  private toFilePath(vaultPath: string): string {
    return join(this.root, ...vaultPath.split('/'));
  }
}
