import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import diff from 'fast-diff';
import * as Y from 'yjs';
import { DOCUMENT_BYTES_LIMIT, isNodeError, utf8ByteLength } from '@kb-1/vault-core';

import {
  LOCAL_AGENT_DOCUMENT_UPDATE_ATTRIBUTION,
  LOCAL_USER_DOCUMENT_UPDATE_ATTRIBUTION,
  createDocumentUpdateAttributionOrigin,
  documentUpdateAttributionFromOrigin,
  type DocumentSessionEvent,
  type DocumentUpdateAttribution
} from './protocol.js';

const Y_TEXT_NAME = 'markdown';
const DOCUMENT_SESSION_STATE_VERSION = 1;
const EXTERNAL_CHANGE_ORIGIN = Symbol('kb1.external-change');
const WATCH_DEBOUNCE_MS = 150;
const WATCH_POLL_MS = 2000;
const TIMING_REPLAY_EVENT_LIMIT = 32;
const WINDOWS_WATCH_DIRECTORY_CACHE = new Map<string, string>();

export function resolveWatchDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform,
  nativeRealpath: (path: string) => string = realpathSync.native,
  cache: Map<string, string> = WINDOWS_WATCH_DIRECTORY_CACHE
): string {
  // Windows can report the watched directory through its long path even when
  // the caller supplied an equivalent 8.3 short path. Older libuv releases
  // assert when those two spellings no longer share a textual prefix, so hand
  // fs.watch() the canonical spelling up front.
  if (platform !== 'win32') {
    return directory;
  }

  const cached = cache.get(directory);
  if (cached) {
    return cached;
  }

  const resolved = nativeRealpath(directory);
  cache.set(directory, resolved);
  cache.set(resolved, resolved);
  return resolved;
}

interface DocumentSessionStateFile {
  version: typeof DOCUMENT_SESSION_STATE_VERSION;
  contentHash: string;
  updateBase64: string;
}

export interface DocumentSessionWarning {
  type: 'external-change-detected';
  filePath: string;
  expectedHash: string;
  actualHash: string | undefined;
}

export interface OneFileDocumentSessionOptions {
  defaultContent?: string;
  eventPath?: string;
  stateFilePath?: string;
  warn?: (warning: DocumentSessionWarning) => void;
  watchDebounceMs?: number;
  watchPollMs?: number;
}

export type DocumentSessionTimingStage =
  | 'markdown.read'
  | 'yjs_state.read'
  | 'yjs_state.restore'
  | 'yjs_state.atomic_write_fsync'
  | 'markdown.atomic_write_fsync';

export interface DocumentSessionTimingEvent {
  stage: DocumentSessionTimingStage;
  durationMs: number;
  outcome?: 'disabled' | 'missing' | 'valid' | 'stale' | 'invalid' | 'repaired' | 'written';
}

export type DocumentSessionTimingHandler = (event: DocumentSessionTimingEvent) => void;

interface DocumentSessionOpenOptions {
  createIfMissing?: boolean;
  onTiming?: DocumentSessionTimingHandler;
}

interface DocumentSessionFlushOptions {
  onTiming?: DocumentSessionTimingHandler;
}

interface TimingCycle {
  events: DocumentSessionTimingEvent[];
  handlerReferences: Map<DocumentSessionTimingHandler, number>;
}

interface StableOpenStateReservation {
  run<T>(operation: (opened: boolean) => Promise<T>): Promise<T>;
  release(): void;
}

export type DocumentSessionEventHandler = (event: DocumentSessionEvent) => void;

export interface DocumentSessionMutationOptions {
  attribution?: DocumentUpdateAttribution;
}

// Deliberately re-declared at the doc-session boundary to keep this package decoupled from service/transport mappers while preserving the closed one-failure-dialect shape.
export interface DocumentSessionFailure {
  ok: false;
  error: 'not_found' | 'unsafe_divergence';
  message: string;
}

export const DOCUMENT_SESSION_NOT_FOUND_FAILURE: DocumentSessionFailure = {
  ok: false,
  error: 'not_found',
  message: 'file not found'
};

export const DOCUMENT_SESSION_UNSAFE_DIVERGENCE_FAILURE: DocumentSessionFailure = {
  ok: false,
  error: 'unsafe_divergence',
  message: 'document history diverged from durable content; reload the document to reconnect from disk'
};

export const DOCUMENT_SESSION_FAILURE_CLOSE_CODE = 1008;

interface DocumentSessionFailureCarrier {
  readonly failure: DocumentSessionFailure;
}

export class DocumentSessionNotFoundError extends Error implements DocumentSessionFailureCarrier {
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

interface OneFileDocumentSessionRuntimeSurface {
  getContent(): Promise<string>;
  readWithBaseline(): Promise<{ content: string; baseline: string }>;
  reset(content?: string): Promise<string>;
  applyContent(content: string, options?: DocumentSessionMutationOptions): Promise<string>;
  applyBaselineEdit(
    baseline: string,
    edit: (currentContent: string) => SessionContentEditResult,
    options?: DocumentSessionMutationOptions,
  ): Promise<SessionSpliceResult>;
  applyContentEdit(
    edit: (currentContent: string) => string,
    options?: DocumentSessionMutationOptions,
  ): Promise<{ content: string; baseline: string }>;
}

export class OneFileDocumentSession implements OneFileDocumentSessionRuntimeSurface {
  filePath: string;

  private readonly defaultContent: string;
  private readonly createMissingOnOpen: boolean;
  private stateFilePath: string | undefined;
  private eventPath: string;
  private readonly warn: (warning: DocumentSessionWarning) => void;
  private readonly watchDebounceMs: number;
  private readonly watchPollMs: number;
  private readonly doc = new Y.Doc();
  private readonly text = this.doc.getText(Y_TEXT_NAME);
  private readonly eventHandlers = new Set<DocumentSessionEventHandler>();
  private opened = false;
  private openPromise: Promise<void> | undefined;
  private stableOpenTail: Promise<void> = Promise.resolve();
  private openTimingCycle: TimingCycle | undefined;
  private lastWrittenHash: string | undefined;
  private lastWrittenContent: string | undefined;
  private nonEmptyMaterializedContent = false;
  // Set only around this session's own atomic write so file-watch echoes can be distinguished from external edits.
  private pendingWriteHash: string | undefined;
  private pendingPersistAttribution: DocumentUpdateAttribution | undefined;
  private persistRequested = false;
  private persistPromise: Promise<void> | undefined;
  private persistTimingCycle: TimingCycle | undefined;
  private persistFailed = false;
  private persistFailureError: PersistFailedError | undefined;
  private activePersistFailureEvent: DocumentSessionEvent | undefined;
  private watcher: FSWatcher | undefined;
  private watchDebounceTimer: NodeJS.Timeout | undefined;
  private watchPollTimer: NodeJS.Timeout | undefined;
  private externalCheckPromise: Promise<void> | undefined;
  private pathTransitionPromise: Promise<void> | undefined;
  private pathMutationTail: Promise<void> = Promise.resolve();
  private deleted = false;

  constructor(filePath: string, options: OneFileDocumentSessionOptions = {}) {
    this.filePath = filePath;
    this.eventPath = options.eventPath ?? filePath;
    this.defaultContent = options.defaultContent ?? '';
    this.createMissingOnOpen = options.defaultContent !== undefined;
    this.stateFilePath = options.stateFilePath;
    this.watchDebounceMs = options.watchDebounceMs ?? WATCH_DEBOUNCE_MS;
    this.watchPollMs = options.watchPollMs ?? WATCH_POLL_MS;
    this.warn = options.warn ?? ((warning) => {
      console.warn(`KB-1 external document change detected at ${warning.filePath}; reconciling active Yjs session from disk.`);
    });
  }

  get ydoc(): Y.Doc {
    this.assertNotDeleted();
    return this.doc;
  }

  isOpened(): boolean {
    return this.opened && !this.deleted;
  }

  hasNonEmptyMaterializedContent(): boolean {
    return !this.deleted && this.nonEmptyMaterializedContent;
  }

  async open(options: DocumentSessionOpenOptions = {}): Promise<void> {
    this.assertNotDeleted();
    if (this.opened) {
      return;
    }

    // Stable-path operations install a barrier before inspecting the current
    // open attempt. Opens that start afterward must observe the filesystem only
    // once that operation has finished.
    await this.stableOpenTail;
    this.assertNotDeleted();
    if (this.opened) {
      return;
    }

    if (!this.openPromise) {
      const timingCycle = createTimingCycle();
      this.openTimingCycle = timingCycle;
      this.openPromise = this.loadFromFile(
        options.createIfMissing ?? this.createMissingOnOpen,
      ).finally(() => {
        this.openPromise = undefined;
        if (this.openTimingCycle === timingCycle) {
          this.openTimingCycle = undefined;
        }
      });
    }

    await observeTimingCycle(
      this.openPromise,
      this.openTimingCycle,
      options.onTiming,
    );
  }

  async withStableOpenState<T>(operation: (opened: boolean) => Promise<T>): Promise<T> {
    return this.reserveStableOpenState().run(operation);
  }

  reserveStableOpenState(): StableOpenStateReservation {
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const previous = this.stableOpenTail;
    this.stableOpenTail = previous.then(() => barrier);
    let released = false;
    let consumed = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseBarrier?.();
    };

    return {
      run: async <T>(operation: (opened: boolean) => Promise<T>): Promise<T> => {
        if (consumed) throw new Error('Stable open-state reservation has already been consumed.');
        consumed = true;
        await previous;
        try {
          const pendingOpen = this.openPromise;
          if (pendingOpen) {
            try {
              await pendingOpen;
            } catch (error) {
              // A client may be probing a missing path while a create is queued.
              // Once that attempt settles, the stable operation may safely take the
              // cold path while later opens remain behind this barrier.
              if (!(error instanceof DocumentSessionNotFoundError)) {
                throw error;
              }
            }
          }
          return await operation(this.isOpened());
        } finally {
          release();
        }
      },
      release: () => {
        consumed = true;
        release();
      }
    };
  }

  private async loadFromFile(
    createIfMissing: boolean,
  ): Promise<void> {
    const onTiming = (event: DocumentSessionTimingEvent): void => {
      recordTimingEvent(this.openTimingCycle, event);
    };
    const markdownReadStartedAt = performance.now();
    const content = await this.readFile({ createIfMissing });
    emitTiming(onTiming, {
      stage: 'markdown.read',
      durationMs: elapsedMs(markdownReadStartedAt),
    });
    const contentHash = hashContent(content);
    const restoreOutcome = await this.tryRestoreStateSnapshot(
      content,
      contentHash,
      onTiming,
    );
    if (restoreOutcome !== 'valid' && restoreOutcome !== 'repaired') {
      this.text.insert(0, content);
    }
    this.nonEmptyMaterializedContent = content.length > 0;
    this.lastWrittenHash = contentHash;
    this.lastWrittenContent = content;
    if (restoreOutcome !== 'valid') {
      await this.writeStateSnapshot(contentHash, onTiming);
    }
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
    this.assertNotDeleted();

    this.doc.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, content);
    }, updateOriginForOptions({}, LOCAL_USER_DOCUMENT_UPDATE_ATTRIBUTION));

    await this.flush();
    return this.currentContent();
  }

  async applyContent(content: string, options: DocumentSessionMutationOptions = {}): Promise<string> {
    await this.open();
    this.assertNotDeleted();

    const current = this.currentContent();
    if (current !== content) {
      this.doc.transact(() => {
        this.text.applyDelta(createFastDiffYTextDelta(current, content));
      }, updateOriginForOptions(options, LOCAL_USER_DOCUMENT_UPDATE_ATTRIBUTION));
    }

    await this.flush();
    return this.currentContent();
  }

  async applyBaselineEdit(
    baseline: string,
    edit: (currentContent: string) => SessionContentEditResult,
    options: DocumentSessionMutationOptions = {},
  ): Promise<SessionSpliceResult> {
    await this.open();
    this.assertNotDeleted();

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
      }, updateOriginForOptions(options, LOCAL_AGENT_DOCUMENT_UPDATE_ATTRIBUTION));
    }

    await this.flush();
    return {
      ok: true,
      content: this.currentContent(),
      baseline: this.currentBaseline()
    };
  }

  async applyContentEdit(
    edit: (currentContent: string) => string,
    options: DocumentSessionMutationOptions = {},
  ): Promise<{ content: string; baseline: string }> {
    await this.open();
    return this.applyPositionedContent(edit(this.currentContentAfterOpen()), options);
  }

  async flush(options: DocumentSessionFlushOptions = {}): Promise<void> {
    if (this.persistPromise) {
      await this.observePersist(this.persistPromise, options.onTiming);
    }
    if (this.persistFailureError) {
      await this.observePersist(this.requestPersist(), options.onTiming);
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.doc.off('update', this.handleDocumentUpdate);
    this.stopWatching();
  }

  resumeAfterCloseFailure(): void {
    if (!this.opened || this.deleted) return;
    this.doc.off('update', this.handleDocumentUpdate);
    this.doc.on('update', this.handleDocumentUpdate);
    this.startWatching();
  }

  async moveTo(
    filePath: string,
    eventPath: string,
    moveOnDisk: () => Promise<void>,
    stateFilePath = this.stateFilePath
  ): Promise<void> {
    await this.runPathMutation(async () => {
      await this.prepareForPathTransition();
      await this.completeMoveAfterTransitionInternal(
        filePath,
        eventPath,
        Promise.resolve().then(moveOnDisk),
        stateFilePath
      );
    });
  }

  // Path transitions are two-phase: flush and stop watching first, then every caller awaits the same disk move before rebinding paths.
  async prepareForPathTransition(): Promise<void> {
    await this.open();
    this.assertNotDeleted();
    this.stopWatching();
    try {
      const externalCheck = this.externalCheckPromise;
      if (externalCheck) {
        await externalCheck;
      }
      this.assertNotDeleted();
      await this.flush();
    } catch (error) {
      if (!this.deleted) {
        this.startWatching();
      }
      throw error;
    }
  }

  async completeMoveAfterTransition(
    filePath: string,
    eventPath: string,
    transition: Promise<void>,
    stateFilePath = this.stateFilePath
  ): Promise<void> {
    await this.runPathMutation(() => (
      this.completeMoveAfterTransitionInternal(filePath, eventPath, transition, stateFilePath)
    ));
  }

  private async completeMoveAfterTransitionInternal(
    filePath: string,
    eventPath: string,
    transition: Promise<void>,
    stateFilePath = this.stateFilePath
  ): Promise<void> {
    this.assertNotDeleted();
    const fromPath = this.eventPath;
    const previousStateFilePath = this.stateFilePath;
    let moved = false;
    const completion = (async () => {
      await transition;
      this.assertNotDeleted();
      moved = true;
      this.filePath = filePath;
      this.eventPath = eventPath;
      this.stateFilePath = stateFilePath;
      const content = this.currentContent();
      const contentHash = hashContent(content);
      await atomicWriteFile(this.filePath, content);
      await this.writeStateSnapshot(contentHash);
      if (previousStateFilePath && previousStateFilePath !== this.stateFilePath) {
        await rm(previousStateFilePath, { force: true });
      }
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
    await this.runPathMutation(() => this.deleteWithInternal(deleteOnDisk));
  }

  private async deleteWithInternal(deleteOnDisk: () => Promise<void>): Promise<void> {
    if (this.deleted) {
      return;
    }
    await this.prepareForPathTransition();

    const transition = (async () => {
      await deleteOnDisk();
      await this.deleteStateSnapshot();
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

  private async runPathMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.pathMutationTail.then(mutation);
    this.pathMutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private readonly handleDocumentUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin === EXTERNAL_CHANGE_ORIGIN) {
      return;
    }
    if (this.deleted) {
      return;
    }

    this.pendingPersistAttribution = documentUpdateAttributionFromOrigin(origin);
    this.requestPersist().catch((error: unknown) => {
      console.warn(`KB-1 failed to persist document update for ${this.filePath}; keeping active Yjs session open.`, error);
    });
  };

  private requestPersist(): Promise<void> {
    this.persistRequested = true;

    if (!this.persistPromise) {
      const timingCycle = createTimingCycle();
      this.persistTimingCycle = timingCycle;
      this.persistPromise = this.persistLoop().finally(() => {
        this.persistPromise = undefined;
        if (this.persistTimingCycle === timingCycle) {
          this.persistTimingCycle = undefined;
        }
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
    const attribution = this.pendingPersistAttribution;
    this.pendingPersistAttribution = undefined;
    const markdownReadStartedAt = performance.now();
    const diskContent = await readOptionalFile(this.filePath);
    this.recordPersistTiming({
      stage: 'markdown.read',
      durationMs: elapsedMs(markdownReadStartedAt),
    });
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
      const markdownWriteStartedAt = performance.now();
      await atomicWriteFile(this.filePath, content);
      this.recordPersistTiming({
        stage: 'markdown.atomic_write_fsync',
        durationMs: elapsedMs(markdownWriteStartedAt),
        outcome: 'written',
      });
      await this.writeStateSnapshot(contentHash, (event) => {
        this.recordPersistTiming(event);
      });
      this.lastWrittenHash = contentHash;
      this.lastWrittenContent = content;
      this.nonEmptyMaterializedContent = content.length > 0;
      this.markPersistRecovered();
      this.emitEvent({
        ...this.createEvent('content-persisted'),
        ...(attribution !== undefined ? { attribution } : {})
      });
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

  private assertNotDeleted(): void {
    if (this.deleted) {
      throw new DocumentSessionNotFoundError(this.filePath);
    }
  }

  private async applyPositionedContent(
    content: string,
    options: DocumentSessionMutationOptions = {},
  ): Promise<{ content: string; baseline: string }> {
    await this.open();
    if (this.deleted) {
      throw new Error(`Document session for ${this.eventPath} has been deleted.`);
    }
    const current = this.currentContent();
    if (current !== content) {
      this.doc.transact(() => {
        this.text.applyDelta(createFastDiffYTextDelta(current, content));
      }, updateOriginForOptions(options, LOCAL_AGENT_DOCUMENT_UPDATE_ATTRIBUTION));
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

    this.watchPollTimer = setInterval(() => {
      this.checkForExternalChange().catch((error: unknown) => {
        console.warn(`KB-1 fallback file poll failed for ${this.filePath}.`, error);
      });
    }, this.watchPollMs);
    this.watchPollTimer.unref?.();

    try {
      this.watcher = watch(resolveWatchDirectory(directory), (eventType, changedFilename) => {
        if (eventType !== 'change' && eventType !== 'rename') {
          return;
        }

        if (changedFilename && changedFilename.toString() !== filename) {
          return;
        }

        this.scheduleExternalCheck();
      });

      this.watcher.on('error', (error) => {
        console.warn(`KB-1 file watcher failed for ${this.filePath}; fallback polling remains active.`, error);
      });
    } catch (error) {
      console.warn(`KB-1 file watcher could not start for ${this.filePath}; fallback polling remains active.`, error);
    }
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
        console.warn(`KB-1 file watcher check failed for ${this.filePath}.`, error);
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
      this.nonEmptyMaterializedContent = content.length > 0;
      await this.writeStateSnapshot(contentHash);
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
    this.nonEmptyMaterializedContent = content.length > 0;
    await this.writeStateSnapshot(contentHash);
    this.emitEvent(eventKind);
  }

  private async tryRestoreStateSnapshot(
    content: string,
    contentHash: string,
    onTiming?: DocumentSessionTimingHandler,
  ): Promise<'disabled' | 'missing' | 'valid' | 'stale' | 'invalid' | 'repaired'> {
    if (!this.stateFilePath) {
      emitTiming(onTiming, {
        stage: 'yjs_state.read',
        durationMs: 0,
        outcome: 'disabled',
      });
      return 'disabled';
    }
    const stateReadStartedAt = performance.now();
    const raw = await readOptionalFile(this.stateFilePath);
    if (raw === undefined) {
      emitTiming(onTiming, {
        stage: 'yjs_state.read',
        durationMs: elapsedMs(stateReadStartedAt),
        outcome: 'missing',
      });
      return 'missing';
    }
    emitTiming(onTiming, {
      stage: 'yjs_state.read',
      durationMs: elapsedMs(stateReadStartedAt),
    });

    const restoreStartedAt = performance.now();
    try {
      const parsed = JSON.parse(raw) as Partial<DocumentSessionStateFile>;
      if (
        parsed.version !== DOCUMENT_SESSION_STATE_VERSION ||
        parsed.contentHash !== contentHash ||
        typeof parsed.updateBase64 !== 'string'
      ) {
        emitTiming(onTiming, {
          stage: 'yjs_state.restore',
          durationMs: elapsedMs(restoreStartedAt),
          outcome: 'stale',
        });
        return 'stale';
      }

      Y.applyUpdate(this.doc, decodeBase64Bytes(parsed.updateBase64), this);
      if (this.text.toString() === content) {
        emitTiming(onTiming, {
          stage: 'yjs_state.restore',
          durationMs: elapsedMs(restoreStartedAt),
          outcome: 'valid',
        });
        return 'valid';
      }

      this.doc.transact(() => {
        this.text.delete(0, this.text.length);
        this.text.insert(0, content);
      }, this);
      emitTiming(onTiming, {
        stage: 'yjs_state.restore',
        durationMs: elapsedMs(restoreStartedAt),
        outcome: 'repaired',
      });
      return 'repaired';
    } catch (error) {
      console.warn(`KB-1 ignored invalid Yjs state snapshot for ${this.filePath}.`, error);
      emitTiming(onTiming, {
        stage: 'yjs_state.restore',
        durationMs: elapsedMs(restoreStartedAt),
        outcome: 'invalid',
      });
      return 'invalid';
    }
  }

  private async writeStateSnapshot(
    contentHash = hashContent(this.currentContent()),
    onTiming?: DocumentSessionTimingHandler,
  ): Promise<void> {
    if (!this.stateFilePath) return;
    const snapshot: DocumentSessionStateFile = {
      version: DOCUMENT_SESSION_STATE_VERSION,
      contentHash,
      updateBase64: encodeBase64Bytes(Y.encodeStateAsUpdate(this.doc))
    };
    const stateWriteStartedAt = performance.now();
    await atomicWriteFile(this.stateFilePath, `${JSON.stringify(snapshot)}\n`);
    emitTiming(onTiming, {
      stage: 'yjs_state.atomic_write_fsync',
      durationMs: elapsedMs(stateWriteStartedAt),
      outcome: 'written',
    });
  }

  private async observePersist(
    persist: Promise<void>,
    onTiming?: DocumentSessionTimingHandler,
  ): Promise<void> {
    await observeTimingCycle(persist, this.persistTimingCycle, onTiming);
  }

  private recordPersistTiming(event: DocumentSessionTimingEvent): void {
    recordTimingEvent(this.persistTimingCycle, event);
  }

  private async deleteStateSnapshot(): Promise<void> {
    if (!this.stateFilePath) return;
    await rm(this.stateFilePath, { force: true });
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
    console.warn(`KB-1 failed to persist document update for ${this.filePath}; keeping active Yjs session open.`, error);
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
        console.warn(`KB-1 document session event handler failed for ${this.filePath}.`, error);
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
  // Windows opens the directory handle fine but rejects fsync on it with
  // EPERM, so this durability step cannot be honoured there. MoveFileEx (the
  // rename in atomicWriteFile) is already atomic on NTFS; skip the directory
  // fsync on win32, matching the graceful-fs/rimraf convention.
  if (process.platform === 'win32') {
    return;
  }

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

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function createTimingCycle(): TimingCycle {
  return {
    events: [],
    handlerReferences: new Map(),
  };
}

async function observeTimingCycle(
  operation: Promise<void>,
  timingCycle: TimingCycle | undefined,
  handler: DocumentSessionTimingHandler | undefined,
): Promise<void> {
  if (!handler || !timingCycle) {
    await operation;
    return;
  }

  const referenceCount = timingCycle.handlerReferences.get(handler) ?? 0;
  if (referenceCount === 0) {
    for (const event of timingCycle.events) emitTiming(handler, event);
  }
  timingCycle.handlerReferences.set(handler, referenceCount + 1);
  try {
    await operation;
  } finally {
    const remainingReferences = (timingCycle.handlerReferences.get(handler) ?? 1) - 1;
    if (remainingReferences === 0) {
      timingCycle.handlerReferences.delete(handler);
    } else {
      timingCycle.handlerReferences.set(handler, remainingReferences);
    }
  }
}

function recordTimingEvent(
  timingCycle: TimingCycle | undefined,
  event: DocumentSessionTimingEvent,
): void {
  if (!timingCycle) return;
  if (timingCycle.events.length === TIMING_REPLAY_EVENT_LIMIT) {
    timingCycle.events.shift();
  }
  timingCycle.events.push(event);
  for (const handler of timingCycle.handlerReferences.keys()) {
    emitTiming(handler, event);
  }
}

function emitTiming(
  handler: DocumentSessionTimingHandler | undefined,
  event: DocumentSessionTimingEvent,
): void {
  if (!handler) return;
  try {
    handler(event);
  } catch {
    // Diagnostic observers must never affect document availability or durability.
  }
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function decodeBase64Bytes(value: string): Uint8Array {
  return Buffer.from(value, 'base64');
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

function updateOriginForOptions(
  options: DocumentSessionMutationOptions,
  fallback: DocumentUpdateAttribution,
): unknown {
  return createDocumentUpdateAttributionOrigin(options.attribution ?? fallback);
}

type YTextDeltaOperation =
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
