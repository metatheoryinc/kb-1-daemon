import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import * as Y from 'yjs';

import type { DocumentSessionEvent } from './protocol.js';

export const DEFAULT_DEMO_DOCUMENT_CONTENT = [
  '# Hello KB-2',
  '',
  'This Markdown file is served by the local KB-2 daemon.',
  ''
].join('\n');

const Y_TEXT_NAME = 'markdown';
const EXTERNAL_CHANGE_ORIGIN = Symbol('kb2.external-change');
const WATCH_DEBOUNCE_MS = 150;
const WATCH_POLL_MS = 2000;

export interface DocumentSessionWarning {
  type: 'external-change-detected';
  filePath: string;
  expectedHash: string;
  actualHash: string | undefined;
}

export interface OneFileDocumentSessionOptions {
  defaultContent?: string;
  warn?: (warning: DocumentSessionWarning) => void;
  watchDebounceMs?: number;
  watchPollMs?: number;
}

export type DocumentSessionEventHandler = (event: DocumentSessionEvent) => void;

export class OneFileDocumentSession {
  readonly filePath: string;

  private readonly defaultContent: string;
  private readonly warn: (warning: DocumentSessionWarning) => void;
  private readonly watchDebounceMs: number;
  private readonly watchPollMs: number;
  private readonly doc = new Y.Doc();
  private readonly text = this.doc.getText(Y_TEXT_NAME);
  private readonly eventHandlers = new Set<DocumentSessionEventHandler>();
  private opened = false;
  private openPromise: Promise<void> | undefined;
  private lastWrittenHash: string | undefined;
  private pendingWriteHash: string | undefined;
  private persistRequested = false;
  private persistPromise: Promise<void> | undefined;
  private persistFailed = false;
  private activePersistFailureEvent: DocumentSessionEvent | undefined;
  private watcher: FSWatcher | undefined;
  private watchDebounceTimer: NodeJS.Timeout | undefined;
  private watchPollTimer: NodeJS.Timeout | undefined;
  private externalCheckPromise: Promise<void> | undefined;

  constructor(filePath: string, options: OneFileDocumentSessionOptions = {}) {
    this.filePath = filePath;
    this.defaultContent = options.defaultContent ?? DEFAULT_DEMO_DOCUMENT_CONTENT;
    this.watchDebounceMs = options.watchDebounceMs ?? WATCH_DEBOUNCE_MS;
    this.watchPollMs = options.watchPollMs ?? WATCH_POLL_MS;
    this.warn = options.warn ?? ((warning) => {
      console.warn(`KB-2 external document change detected at ${warning.filePath}; reconciling active Yjs session from disk.`);
    });
  }

  get ydoc(): Y.Doc {
    return this.doc;
  }

  async open(): Promise<void> {
    if (this.opened) {
      return;
    }

    if (!this.openPromise) {
      this.openPromise = this.loadFromFile().finally(() => {
        this.openPromise = undefined;
      });
    }

    await this.openPromise;
  }

  private async loadFromFile(): Promise<void> {
    const content = await this.readOrCreateFile();
    this.text.insert(0, content);
    this.lastWrittenHash = hashContent(content);
    this.doc.on('update', this.handleDocumentUpdate);
    this.opened = true;
    this.startWatching();
  }

  async getContent(): Promise<string> {
    await this.open();
    return this.currentContent();
  }

  onEvent(handler: DocumentSessionEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  getActivePersistFailureEvent(): DocumentSessionEvent | undefined {
    return this.activePersistFailureEvent;
  }

  async reset(content = this.defaultContent): Promise<string> {
    await this.open();

    this.doc.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, content);
    }, this);

    await this.flush();
    return this.currentContent();
  }

  async flush(): Promise<void> {
    if (this.persistPromise) {
      await this.persistPromise;
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.doc.off('update', this.handleDocumentUpdate);
    this.stopWatching();
  }

  private readonly handleDocumentUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin === EXTERNAL_CHANGE_ORIGIN) {
      return;
    }

    this.requestPersist().catch((error: unknown) => {
      console.warn(`KB-2 failed to persist document update for ${this.filePath}; keeping active Yjs session open.`, error);
    });
  };

  private requestPersist(): Promise<void> {
    this.persistRequested = true;

    if (!this.persistPromise) {
      this.persistPromise = this.persistLoop().finally(() => {
        this.persistPromise = undefined;
      });
    }

    return this.persistPromise;
  }

  private async persistLoop(): Promise<void> {
    while (this.persistRequested) {
      this.persistRequested = false;
      try {
        await this.materialize();
      } catch (error) {
        this.markPersistFailed(error);
      }
    }
  }

  private async materialize(): Promise<void> {
    const content = this.currentContent();
    const diskContent = await readOptionalFile(this.filePath);
    const diskHash = diskContent === undefined ? undefined : hashContent(diskContent);

    if (this.lastWrittenHash !== undefined && diskHash !== this.lastWrittenHash) {
      this.warn({
        type: 'external-change-detected',
        filePath: this.filePath,
        expectedHash: this.lastWrittenHash,
        actualHash: diskHash
      });
      await this.reconcileExternalContent(diskContent ?? '', diskHash ?? hashContent(''));
      return;
    }

    const contentHash = hashContent(content);
    this.pendingWriteHash = contentHash;
    try {
      await atomicWriteFile(this.filePath, content);
      this.lastWrittenHash = contentHash;
      this.markPersistRecovered();
    } finally {
      if (this.pendingWriteHash === contentHash) {
        this.pendingWriteHash = undefined;
      }
    }
  }

  private async readOrCreateFile(): Promise<string> {
    const existing = await readOptionalFile(this.filePath);
    if (existing !== undefined) {
      return existing;
    }

    await atomicWriteFile(this.filePath, this.defaultContent);
    return this.defaultContent;
  }

  private currentContent(): string {
    return this.text.toString();
  }

  private startWatching(): void {
    if (this.watcher) {
      return;
    }

    const directory = dirname(this.filePath);
    const filename = basename(this.filePath);

    this.watcher = watch(directory, (eventType, changedFilename) => {
      if (eventType !== 'change' && eventType !== 'rename') {
        return;
      }

      if (changedFilename && changedFilename.toString() !== filename) {
        return;
      }

      this.scheduleExternalCheck();
    });

    this.watcher.on('error', (error) => {
      console.warn(`KB-2 file watcher failed for ${this.filePath}; fallback polling remains active.`, error);
    });

    this.watchPollTimer = setInterval(() => {
      this.checkForExternalChange().catch((error: unknown) => {
        console.warn(`KB-2 fallback file poll failed for ${this.filePath}.`, error);
      });
    }, this.watchPollMs);
    this.watchPollTimer.unref?.();
  }

  private stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;

    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = undefined;
    }

    if (this.watchPollTimer) {
      clearInterval(this.watchPollTimer);
      this.watchPollTimer = undefined;
    }
  }

  private scheduleExternalCheck(): void {
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
    }

    this.watchDebounceTimer = setTimeout(() => {
      this.watchDebounceTimer = undefined;
      this.checkForExternalChange().catch((error: unknown) => {
        console.warn(`KB-2 file watcher check failed for ${this.filePath}.`, error);
      });
    }, this.watchDebounceMs);
    this.watchDebounceTimer.unref?.();
  }

  private async checkForExternalChange(): Promise<void> {
    if (this.externalCheckPromise) {
      await this.externalCheckPromise;
      return;
    }

    this.externalCheckPromise = this.runExternalChangeCheck().finally(() => {
      this.externalCheckPromise = undefined;
    });
    await this.externalCheckPromise;
  }

  private async runExternalChangeCheck(): Promise<void> {
    if (!this.opened || this.lastWrittenHash === undefined) {
      return;
    }

    const diskContent = await readOptionalFile(this.filePath);
    const diskHash = diskContent === undefined ? hashContent('') : hashContent(diskContent);

    if (diskHash === this.lastWrittenHash || diskHash === this.pendingWriteHash) {
      return;
    }

    await this.reconcileExternalContent(diskContent ?? '', diskHash);
  }

  private async reconcileExternalContent(content: string, contentHash: string): Promise<void> {
    const current = this.currentContent();
    if (current === content) {
      this.lastWrittenHash = contentHash;
      return;
    }

    applyMinimalTextSplice(this.text, current, content, this.doc);
    this.lastWrittenHash = contentHash;
    this.emitEvent('external-change');
  }

  private markPersistFailed(error: unknown): void {
    this.persistFailed = true;
    const event = this.createEvent('persist-failure');
    this.activePersistFailureEvent = event;
    this.emitEvent(event);
    console.warn(`KB-2 failed to persist document update for ${this.filePath}; keeping active Yjs session open.`, error);
  }

  private markPersistRecovered(): void {
    if (!this.persistFailed) {
      return;
    }

    this.persistFailed = false;
    this.activePersistFailureEvent = undefined;
    this.emitEvent('persist-recovered');
  }

  private createEvent(kind: DocumentSessionEvent['kind']): DocumentSessionEvent {
    return {
      kind,
      path: this.filePath,
      ts: Date.now()
    };
  }

  private emitEvent(eventOrKind: DocumentSessionEvent | DocumentSessionEvent['kind']): void {
    const event = typeof eventOrKind === 'string'
      ? this.createEvent(eventOrKind)
      : eventOrKind;

    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.warn(`KB-2 document session event handler failed for ${this.filePath}.`, error);
      }
    }
  }
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });

  const temporaryPath = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function applyMinimalTextSplice(
  text: Y.Text,
  current: string,
  next: string,
  doc: Y.Doc,
): void {
  let prefixLength = 0;
  const maxPrefixLength = Math.min(current.length, next.length);
  while (
    prefixLength < maxPrefixLength &&
    current.charCodeAt(prefixLength) === next.charCodeAt(prefixLength)
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  const maxSuffixLength = maxPrefixLength - prefixLength;
  while (
    suffixLength < maxSuffixLength &&
    current.charCodeAt(current.length - suffixLength - 1) ===
      next.charCodeAt(next.length - suffixLength - 1)
  ) {
    suffixLength += 1;
  }

  const deleteLength = current.length - prefixLength - suffixLength;
  const inserted = next.slice(prefixLength, next.length - suffixLength);

  doc.transact(() => {
    if (deleteLength > 0) {
      text.delete(prefixLength, deleteLength);
    }

    if (inserted.length > 0) {
      text.insert(prefixLength, inserted);
    }
  }, EXTERNAL_CHANGE_ORIGIN);
}
