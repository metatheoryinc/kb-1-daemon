import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import diff from 'fast-diff';
import * as Y from 'yjs';
import { DOCUMENT_BYTES_LIMIT, isNodeError, utf8ByteLength } from '@kb-2/vault-core';

import type { DocumentSessionEvent } from './protocol.js';

const Y_TEXT_NAME = 'markdown';
const EXTERNAL_CHANGE_ORIGIN = Symbol('kb2.external-change');
const AGENT_SPLICE_ORIGIN = Symbol('kb2.agent-splice');
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
  eventPath?: string;
  warn?: (warning: DocumentSessionWarning) => void;
  watchDebounceMs?: number;
  watchPollMs?: number;
}

export type DocumentSessionEventHandler = (event: DocumentSessionEvent) => void;

export interface DocumentSessionFailure {
  ok: false;
  error: 'not_found';
  message: string;
}

export const DOCUMENT_SESSION_NOT_FOUND_FAILURE: DocumentSessionFailure = {
  ok: false,
  error: 'not_found',
  message: 'file not found'
};

export const DOCUMENT_SESSION_FAILURE_CLOSE_CODE = 1008;

export class DocumentSessionNotFoundError extends Error {
  readonly failure = DOCUMENT_SESSION_NOT_FOUND_FAILURE;

  constructor(readonly filePath: string) {
    super(DOCUMENT_SESSION_NOT_FOUND_FAILURE.message);
    this.name = 'DocumentSessionNotFoundError';
  }
}

export type SessionContentEditReject =
  | { ok: false; rejected: 'not_found' }
  | { ok: false; rejected: 'ambiguous'; match_count: number }
  | { ok: false; rejected: 'too_large_splice'; limit_bytes: number }
  | { ok: false; rejected: 'too_large_document'; current_bytes: number; limit_bytes: number };
export type SessionContentEditResult = { ok: true; content: string } | SessionContentEditReject;

export type SessionSpliceResult =
  | { ok: true; content: string; baseline: string }
  | {
      ok: false;
      rejected: 'stale_doc';
      current_content: string;
      baseline: string;
      truncated?: boolean;
    }
  | SessionContentEditReject;
export type SessionSpliceReject = Exclude<SessionSpliceResult, { ok: true }>;

export class PersistFailedError extends Error {
  constructor(
    readonly filePath: string,
    readonly cause: unknown
  ) {
    super(`Failed to persist document session for ${filePath}`);
    this.name = 'PersistFailedError';
  }
}

export class OneFileDocumentSession {
  filePath: string;

  private readonly defaultContent: string;
  private readonly createMissingOnOpen: boolean;
  private eventPath: string;
  private readonly warn: (warning: DocumentSessionWarning) => void;
  private readonly watchDebounceMs: number;
  private readonly watchPollMs: number;
  private readonly doc = new Y.Doc();
  private readonly text = this.doc.getText(Y_TEXT_NAME);
  private readonly eventHandlers = new Set<DocumentSessionEventHandler>();
  private opened = false;
  private openPromise: Promise<void> | undefined;
  private lastWrittenHash: string | undefined;
  private lastWrittenContent: string | undefined;
  // Set only around this session's own atomic write so file-watch echoes can be distinguished from external edits.
  private pendingWriteHash: string | undefined;
  private persistRequested = false;
  private persistPromise: Promise<void> | undefined;
  private persistFailed = false;
  private persistFailureError: PersistFailedError | undefined;
  private activePersistFailureEvent: DocumentSessionEvent | undefined;
  private watcher: FSWatcher | undefined;
  private watchDebounceTimer: NodeJS.Timeout | undefined;
  private watchPollTimer: NodeJS.Timeout | undefined;
  private externalCheckPromise: Promise<void> | undefined;
  private pathTransitionPromise: Promise<void> | undefined;
  private deleted = false;

  constructor(filePath: string, options: OneFileDocumentSessionOptions = {}) {
    this.filePath = filePath;
    this.eventPath = options.eventPath ?? filePath;
    this.defaultContent = options.defaultContent ?? '';
    this.createMissingOnOpen = options.defaultContent !== undefined;
    this.watchDebounceMs = options.watchDebounceMs ?? WATCH_DEBOUNCE_MS;
    this.watchPollMs = options.watchPollMs ?? WATCH_POLL_MS;
    this.warn = options.warn ?? ((warning) => {
      console.warn(`KB-2 external document change detected at ${warning.filePath}; reconciling active Yjs session from disk.`);
    });
  }

  get ydoc(): Y.Doc {
    return this.doc;
  }

  async open(options: { createIfMissing?: boolean } = {}): Promise<void> {
    if (this.opened) {
      return;
    }

    if (!this.openPromise) {
      this.openPromise = this.loadFromFile(options.createIfMissing ?? this.createMissingOnOpen).finally(() => {
        this.openPromise = undefined;
      });
    }

    await this.openPromise;
  }

  private async loadFromFile(createIfMissing: boolean): Promise<void> {
    const content = await this.readFile({ createIfMissing });
    this.text.insert(0, content);
    this.lastWrittenHash = hashContent(content);
    this.lastWrittenContent = content;
    this.doc.on('update', this.handleDocumentUpdate);
    this.opened = true;
    this.startWatching();
  }

  async getContent(): Promise<string> {
    await this.open();
    return this.currentContent();
  }

  async readWithBaseline(): Promise<{ content: string; baseline: string }> {
    await this.open();
    return {
      content: this.currentContent(),
      baseline: this.currentBaseline()
    };
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

  hasActivePersistFailure(): boolean {
    return this.persistFailed;
  }

  hasUnsettledPersist(): boolean {
    return this.persistRequested || this.persistPromise !== undefined || this.persistFailureError !== undefined;
  }

  async reset(content = this.defaultContent): Promise<string> {
    await this.open();
    if (this.deleted) {
      throw new Error(`Document session for ${this.eventPath} has been deleted.`);
    }

    this.doc.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, content);
    }, this);

    await this.flush();
    return this.currentContent();
  }

  async applyContent(content: string): Promise<string> {
    await this.open();
    if (this.deleted) {
      throw new Error(`Document session for ${this.eventPath} has been deleted.`);
    }

    const current = this.currentContent();
    if (current !== content) {
      this.doc.transact(() => {
        this.text.applyDelta(createFastDiffYTextDelta(current, content));
      }, this);
    }

    await this.flush();
    return this.currentContent();
  }

  async applyBaselineEdit(
    baseline: string,
    edit: (currentContent: string) => SessionContentEditResult
  ): Promise<SessionSpliceResult> {
    await this.open();
    if (this.deleted) {
      throw new Error(`Document session for ${this.eventPath} has been deleted.`);
    }

    const currentBaseline = this.currentBaseline();
    if (baseline !== currentBaseline) {
      return this.staleDocResult(currentBaseline);
    }

    const current = this.currentContent();
    const result = edit(current);
    if (!result.ok) return result;

    if (current !== result.content) {
      this.doc.transact(() => {
        this.text.applyDelta(createFastDiffYTextDelta(current, result.content));
      }, AGENT_SPLICE_ORIGIN);
    }

    await this.flush();
    return {
      ok: true,
      content: this.currentContent(),
      baseline: this.currentBaseline()
    };
  }

  async applyContentEdit(edit: (currentContent: string) => string): Promise<{ content: string; baseline: string }> {
    await this.open();
    return this.applyPositionedContent(edit(this.currentContentAfterOpen()));
  }

  async flush(): Promise<void> {
    if (this.persistPromise) {
      await this.persistPromise;
    }
    if (this.persistFailureError) {
      await this.requestPersist();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.doc.off('update', this.handleDocumentUpdate);
    this.stopWatching();
  }

  async moveTo(
    filePath: string,
    eventPath: string,
    moveOnDisk: () => Promise<void>
  ): Promise<void> {
    await this.prepareForPathTransition();
    await this.completeMoveAfterTransition(filePath, eventPath, Promise.resolve().then(moveOnDisk));
  }

  // Path transitions are two-phase: flush and stop watching first, then every caller awaits the same disk move before rebinding paths.
  async prepareForPathTransition(): Promise<void> {
    await this.open();
    if (this.deleted) {
      throw new Error(`Document session for ${this.eventPath} has been deleted.`);
    }
    await this.flush();
    this.stopWatching();
  }

  async completeMoveAfterTransition(
    filePath: string,
    eventPath: string,
    transition: Promise<void>
  ): Promise<void> {
    const fromPath = this.eventPath;
    let moved = false;
    const completion = (async () => {
      await transition;
      moved = true;
      this.filePath = filePath;
      this.eventPath = eventPath;
      const content = this.currentContent();
      const contentHash = hashContent(content);
      await atomicWriteFile(this.filePath, content);
      this.lastWrittenHash = contentHash;
      this.lastWrittenContent = content;
      this.pendingWriteHash = undefined;
      this.startWatching();
      this.emitEvent({
        kind: 'doc-moved',
        path: eventPath,
        fromPath,
        toPath: eventPath,
        ts: Date.now()
      });
    })();

    this.pathTransitionPromise = completion;
    try {
      await completion;
    } catch (error) {
      if (!moved && !this.deleted) {
        this.startWatching();
      }
      throw error;
    } finally {
      if (this.pathTransitionPromise === completion) {
        this.pathTransitionPromise = undefined;
      }
    }
  }

  async deleteWith(deleteOnDisk: () => Promise<void>): Promise<void> {
    await this.open();
    if (this.deleted) {
      return;
    }
    await this.flush();

    const transition = (async () => {
      this.stopWatching();
      await deleteOnDisk();
      this.markDeleted();
    })();

    this.pathTransitionPromise = transition;
    try {
      await transition;
    } catch (error) {
      if (!this.deleted) {
        this.startWatching();
      }
      throw error;
    } finally {
      if (this.pathTransitionPromise === transition) {
        this.pathTransitionPromise = undefined;
      }
    }
  }

  private readonly handleDocumentUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin === EXTERNAL_CHANGE_ORIGIN) {
      return;
    }
    if (this.deleted) {
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
    let failure: PersistFailedError | undefined;
    // Coalesce writes requested while a persist is in flight; the loop drains until no newer request remains.
    while (this.persistRequested) {
      this.persistRequested = false;
      try {
        await this.materialize();
      } catch (error) {
        failure = this.markPersistFailed(error);
      }
    }
    if (failure) {
      throw failure;
    }
  }

  private async materialize(): Promise<void> {
    if (this.pathTransitionPromise) {
      await this.pathTransitionPromise;
    }
    if (this.deleted) {
      return;
    }

    const content = this.currentContent();
    const diskContent = await readOptionalFile(this.filePath);
    const diskHash = diskContent === undefined ? undefined : hashContent(diskContent);

    // Re-check disk immediately before writing so external edits observed between debounce and persist are merged first.
    if (this.lastWrittenHash !== undefined && diskHash !== this.lastWrittenHash) {
      this.warn({
        type: 'external-change-detected',
        filePath: this.filePath,
        expectedHash: this.lastWrittenHash,
        actualHash: diskHash
      });
      await this.reconcileExternalContent(diskContent ?? '', diskHash ?? hashContent(''), diskContent === undefined);
      return;
    }

    const contentHash = hashContent(content);
    this.pendingWriteHash = contentHash;
    try {
      await atomicWriteFile(this.filePath, content);
      this.lastWrittenHash = contentHash;
      this.lastWrittenContent = content;
      this.markPersistRecovered();
      this.emitEvent('content-persisted');
    } finally {
      if (this.pendingWriteHash === contentHash) {
        this.pendingWriteHash = undefined;
      }
    }
  }

  private async readFile(options: { createIfMissing: boolean }): Promise<string> {
    const existing = await readOptionalFile(this.filePath);
    if (existing !== undefined) {
      return existing;
    }

    if (!options.createIfMissing) {
      throw new DocumentSessionNotFoundError(this.filePath);
    }

    await atomicWriteFile(this.filePath, this.defaultContent);
    return this.defaultContent;
  }

  private currentContent(): string {
    return this.text.toString();
  }

  private currentBaseline(): string {
    return encodeBase64Bytes(Y.encodeStateVector(this.doc));
  }

  private currentContentAfterOpen(): string {
    if (!this.opened || this.deleted) {
      throw new Error(`Document session for ${this.eventPath} is not open.`);
    }
    return this.currentContent();
  }

  private async applyPositionedContent(content: string): Promise<{ content: string; baseline: string }> {
    await this.open();
    if (this.deleted) {
      throw new Error(`Document session for ${this.eventPath} has been deleted.`);
    }
    const current = this.currentContent();
    if (current !== content) {
      this.doc.transact(() => {
        this.text.applyDelta(createFastDiffYTextDelta(current, content));
      }, AGENT_SPLICE_ORIGIN);
    }
    await this.flush();
    return {
      content: this.currentContent(),
      baseline: this.currentBaseline()
    };
  }

  private staleDocResult(currentBaseline: string): Extract<SessionSpliceResult, { rejected: 'stale_doc' }> {
    const content = this.currentContent();
    if (utf8ByteLength(content) <= DOCUMENT_BYTES_LIMIT) {
      return {
        ok: false,
        rejected: 'stale_doc',
        current_content: content,
        baseline: currentBaseline
      };
    }

    return {
      ok: false,
      rejected: 'stale_doc',
      current_content: truncateUtf8(content, DOCUMENT_BYTES_LIMIT),
      baseline: currentBaseline,
      truncated: true
    };
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
    if (diskContent === undefined) {
      this.markDeleted();
      return;
    }
    const diskHash = hashContent(diskContent);

    if (diskHash === this.lastWrittenHash || diskHash === this.pendingWriteHash) {
      return;
    }

    await this.reconcileExternalContent(diskContent ?? '', diskHash, diskContent === undefined);
  }

  private async reconcileExternalContent(
    content: string,
    contentHash: string,
    missingFromDisk: boolean,
  ): Promise<void> {
    if (missingFromDisk) {
      this.markDeleted();
      return;
    }

    const current = this.currentContent();
    if (current === content) {
      this.lastWrittenHash = contentHash;
      this.lastWrittenContent = content;
      return;
    }

    const truncatedToEmpty = current.length > 0 && content.length === 0;
    const eventKind: DocumentSessionEvent['kind'] =
      !truncatedToEmpty && current === this.lastWrittenContent
        ? 'external-merge'
        : 'external-change';

    this.doc.transact(() => {
      this.text.applyDelta(createFastDiffYTextDelta(current, content));
    }, EXTERNAL_CHANGE_ORIGIN);
    this.lastWrittenHash = contentHash;
    // Mirrors the last materialized string; revisit resident memory cost before multi-file sessions.
    this.lastWrittenContent = content;
    this.emitEvent(eventKind);
  }

  private markPersistFailed(error: unknown): PersistFailedError {
    this.persistFailed = true;
    const persistError = error instanceof PersistFailedError
      ? error
      : new PersistFailedError(this.filePath, error);
    this.persistFailureError = persistError;
    const event = this.createEvent('persist-failure');
    this.activePersistFailureEvent = event;
    this.emitEvent(event);
    console.warn(`KB-2 failed to persist document update for ${this.filePath}; keeping active Yjs session open.`, error);
    return persistError;
  }

  private markPersistRecovered(): void {
    if (!this.persistFailed) {
      return;
    }

    this.persistFailed = false;
    this.persistFailureError = undefined;
    this.activePersistFailureEvent = undefined;
    this.emitEvent('persist-recovered');
  }

  private createEvent(kind: DocumentSessionEvent['kind']): DocumentSessionEvent {
    return {
      kind,
      path: this.eventPath,
      ts: Date.now()
    };
  }

  private markDeleted(): void {
    if (this.deleted) {
      return;
    }
    this.deleted = true;
    this.stopWatching();
    this.activePersistFailureEvent = undefined;
    this.emitEvent('doc-deleted');
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
    const file = await open(temporaryPath, 'w');
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, filePath);
    await fsyncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && (error as { code?: string }).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function truncateUtf8(value: string, limitBytes: number): string {
  // Iterate by code point so truncation never splits a surrogate pair while honoring the byte cap.
  let output = '';
  let bytes = 0;
  for (const char of value) {
    const next = utf8ByteLength(char);
    if (bytes + next > limitBytes) break;
    output += char;
    bytes += next;
  }
  return output;
}

export type YTextDeltaOperation =
  | { retain: number }
  | { insert: string }
  | { delete: number };

export function createFastDiffYTextDelta(current: string, next: string): YTextDeltaOperation[] {
  return diff(current, next).map(([operation, value]) => {
    if (operation === diff.EQUAL) {
      return { retain: value.length };
    }

    if (operation === diff.INSERT) {
      return { insert: value };
    }

    return { delete: value.length };
  });
}
