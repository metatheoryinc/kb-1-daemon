import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import {
  DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
  DOCUMENT_SESSION_NOT_FOUND_FAILURE,
  DOCUMENT_SESSION_UNSAFE_DIVERGENCE_FAILURE,
  DocumentSessionNotFoundError,
  PersistFailedError,
  type DocumentSessionTimingEvent,
  type DocumentSessionTimingHandler,
  type OneFileDocumentSession
} from './session.js';
import {
  LOCAL_USER_DOCUMENT_UPDATE_ATTRIBUTION,
  MESSAGE_ACKED_SYNC_UPDATE,
  MESSAGE_SYNC,
  UNKNOWN_DOCUMENT_UPDATE_ATTRIBUTION,
  createDocumentUpdateAttributionOrigin,
  decodeAckedSyncUpdate,
  documentUpdateAttributionFromOrigin,
  documentUpdateAttributionSourceFromOrigin,
  encodeAttributedSyncUpdate,
  encodeSessionEvent,
  encodeSyncUpdateAck,
  encodeSyncedMessage,
  type DocumentUpdateAttribution
} from './protocol.js';

const socketOpen = 1;
const Y_TEXT_NAME = 'markdown';

export interface YjsWebSocketLike {
  readyState: number;
  send(data: Uint8Array, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: () => void): this;
}

export interface BoundYjsWebSocket {
  closed: Promise<void>;
}

export interface YjsWebSocketBindingOptions {
  attribution?: DocumentUpdateAttribution;
  onTiming?: YjsWebSocketTimingHandler;
}

export type YjsWebSocketTimingEvent =
  | DocumentSessionTimingEvent
  | {
      stage:
        | 'document_session.open'
        | 'initial_sync.emitted'
        | 'synced_marker.emitted'
        | 'save_ack.emitted';
      durationMs: number;
      ackId?: string;
    };

export type YjsWebSocketTimingHandler = (event: YjsWebSocketTimingEvent) => void;

export async function bindYjsWebSocket(
  session: OneFileDocumentSession,
  socket: YjsWebSocketLike,
  options: YjsWebSocketBindingOptions = {}
): Promise<BoundYjsWebSocket> {
  const bindingStartedAt = performance.now();
  let cleanupStarted = false;
  let sessionReady = false;
  let sessionDoc: Y.Doc | undefined;
  const pendingMessages: unknown[] = [];
  let syncedMessageSent = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  let unsubscribeSessionEvents: () => void = () => {};
  const deferredPersistedAckIds = new Set<string>();
  const socketUpdateOrigin = createDocumentUpdateAttributionOrigin(
    options.attribution ?? LOCAL_USER_DOCUMENT_UPDATE_ATTRIBUTION,
    socket
  );

  const updateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === socket || documentUpdateAttributionSourceFromOrigin(origin) === socket) {
      return;
    }

    const attribution = documentUpdateAttributionFromOrigin(origin) ?? UNKNOWN_DOCUMENT_UPDATE_ATTRIBUTION;
    sendBytes(socket, encodeAttributedSyncUpdate({ attribution, update }));

    sendSync(socket, (encoder) => {
      syncProtocol.writeUpdate(encoder, update);
    });
  };

  const cleanup = () => {
    if (cleanupStarted) {
      return;
    }

    cleanupStarted = true;
    unsubscribeSessionEvents();
    sessionDoc?.off('update', updateHandler);
    session.flush().then(resolveClosed, (error: unknown) => {
      if (error instanceof PersistFailedError) {
        resolveClosed();
        return;
      }
      rejectClosed(error);
    });
  };

  const handleMessage = (data: unknown) => {
    if (!sessionReady) {
      pendingMessages.push(data);
      return;
    }

    processSyncMessage(data);
  };

  const sendSyncedOnce = () => {
    if (syncedMessageSent) {
      return;
    }
    syncedMessageSent = true;
    sendBytes(socket, encodeSyncedMessage());
    emitTiming(options.onTiming, {
      stage: 'synced_marker.emitted',
      durationMs: elapsedMs(bindingStartedAt),
    });
  };

  const processSyncMessage = (data: unknown) => {
    try {
      const message = toUint8Array(data);
      if (!message) {
        return;
      }

      const decoder = decoding.createDecoder(message);
      const encoder = encoding.createEncoder();
      const messageType = decoding.readVarUint(decoder);
      const activeDoc = sessionDoc;
      if (!activeDoc || !session.isOpened()) {
        closeDeletedDocument(socket);
        return;
      }

      if (messageType === MESSAGE_ACKED_SYNC_UPDATE) {
        const ackedUpdate = decodeAckedSyncUpdate(decoder);
        if (!ackedUpdate) {
          return;
        }
        if (hasUnsafeIndependentUpdate(session, activeDoc, ackedUpdate.update)) {
          closeUnsafeDivergence(socket);
          return;
        }
        Y.applyUpdate(activeDoc, ackedUpdate.update, socketUpdateOrigin);
        const saveStartedAt = performance.now();
        void session.flush({ onTiming: options.onTiming as DocumentSessionTimingHandler | undefined }).then(() => {
          sendBytes(socket, encodeSyncUpdateAck({ ackId: ackedUpdate.ackId, ts: Date.now() }));
          emitTiming(options.onTiming, {
            stage: 'save_ack.emitted',
            durationMs: elapsedMs(saveStartedAt),
            ackId: ackedUpdate.ackId,
          });
        }, (error: unknown) => {
          if (error instanceof PersistFailedError) {
            deferredPersistedAckIds.add(ackedUpdate.ackId);
            return;
          }
          console.warn('KB-1 failed to acknowledge persisted Yjs update.', error);
        });
        return;
      }

      if (messageType !== MESSAGE_SYNC) {
        return;
      }

      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const syncResult = processYjsSyncPayload(
        session,
        activeDoc,
        socket,
        socketUpdateOrigin,
        decoder,
        encoder,
      );
      if (syncResult === 'closed') {
        return;
      }

      if (encoding.length(encoder) > 1) {
        sendEncoded(socket, encoder);
      }
      if (syncResult === 'answered-sync-step1') {
        sendSyncedOnce();
      }
    } catch {
      socket.close(1003, 'Invalid Yjs sync message');
    }
  };

  socket.on('message', handleMessage);
  socket.on('close', cleanup);
  socket.on('error', cleanup);

  try {
    const sessionOpenStartedAt = performance.now();
    await session.open({
      createIfMissing: false,
      onTiming: options.onTiming as DocumentSessionTimingHandler | undefined,
    });
    emitTiming(options.onTiming, {
      stage: 'document_session.open',
      durationMs: elapsedMs(sessionOpenStartedAt),
    });
  } catch (error) {
    if (error instanceof DocumentSessionNotFoundError) {
      socket.close(DOCUMENT_SESSION_FAILURE_CLOSE_CODE, JSON.stringify(error.failure));
      resolveClosed();
      return { closed };
    }
    throw error;
  }
  if (cleanupStarted || socket.readyState !== socketOpen) {
    cleanup();
    return { closed };
  }
  sessionReady = true;
  const openedDoc = session.ydoc;
  sessionDoc = openedDoc;

  openedDoc.on('update', updateHandler);
  unsubscribeSessionEvents = session.onEvent((event) => {
    sendBytes(socket, encodeSessionEvent(event));
    if (event.kind === 'doc-deleted') {
      deferredPersistedAckIds.clear();
      closeDeletedDocument(socket);
      return;
    }
    if (event.kind === 'content-persisted' && deferredPersistedAckIds.size > 0) {
      for (const ackId of deferredPersistedAckIds) {
        sendBytes(socket, encodeSyncUpdateAck({ ackId, ts: event.ts }));
      }
      deferredPersistedAckIds.clear();
    }
  });

  const activePersistFailure = session.getActivePersistFailureEvent();
  if (activePersistFailure) {
    sendBytes(socket, encodeSessionEvent(activePersistFailure));
  }

  for (const data of pendingMessages.splice(0)) {
    processSyncMessage(data);
  }

  sendSync(socket, (encoder) => {
    syncProtocol.writeSyncStep1(encoder, openedDoc);
  });
  emitTiming(options.onTiming, {
    stage: 'initial_sync.emitted',
    durationMs: elapsedMs(bindingStartedAt),
  });

  return { closed };
}

function sendSync(socket: YjsWebSocketLike, write: (encoder: encoding.Encoder) => void): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  write(encoder);
  sendEncoded(socket, encoder);
}

function sendEncoded(socket: YjsWebSocketLike, encoder: encoding.Encoder): void {
  sendBytes(socket, encoding.toUint8Array(encoder));
}

function sendBytes(socket: YjsWebSocketLike, bytes: Uint8Array): void {
  if (socket.readyState !== socketOpen) {
    return;
  }

  socket.send(bytes);
}

type SyncMessageResult = 'answered-sync-step1' | 'processed' | 'closed';

function processYjsSyncPayload(
  session: OneFileDocumentSession,
  doc: Y.Doc,
  socket: YjsWebSocketLike,
  origin: unknown,
  decoder: decoding.Decoder,
  encoder: encoding.Encoder
): SyncMessageResult {
  const syncMessageType = decoding.readVarUint(decoder);
  if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
    const remoteStateVector = decoding.readVarUint8Array(decoder);
    syncProtocol.writeSyncStep2(encoder, doc, remoteStateVector);
    return 'answered-sync-step1';
  }

  if (syncMessageType === syncProtocol.messageYjsSyncStep2 || syncMessageType === syncProtocol.messageYjsUpdate) {
    const update = decoding.readVarUint8Array(decoder);
    if (hasUnsafeIndependentUpdate(session, doc, update)) {
      closeUnsafeDivergence(socket);
      return 'closed';
    }
    Y.applyUpdate(doc, update, origin);
    return 'processed';
  }

  throw new Error('Unknown Yjs sync message type');
}

function hasUnsafeIndependentUpdate(
  session: OneFileDocumentSession,
  localDoc: Y.Doc,
  update: Uint8Array,
): boolean {
  if (!session.hasNonEmptyMaterializedContent()) {
    return false;
  }

  const localText = localDoc.getText(Y_TEXT_NAME).toString();
  if (localText.length === 0) {
    return false;
  }

  const incomingDoc = new Y.Doc();
  Y.applyUpdate(incomingDoc, update);
  const incomingText = incomingDoc.getText(Y_TEXT_NAME).toString();
  if (incomingText.length === 0) {
    incomingDoc.destroy();
    return false;
  }

  const localState = Y.decodeStateVector(Y.encodeStateVector(localDoc));
  const incomingState = Y.decodeStateVector(Y.encodeStateVector(incomingDoc));
  incomingDoc.destroy();
  if (stateVectorsShareClient(localState, incomingState)) {
    return false;
  }

  return true;
}

function stateVectorsShareClient(left: Map<number, number>, right: Map<number, number>): boolean {
  for (const clientId of left.keys()) {
    if (right.has(clientId)) {
      return true;
    }
  }
  return false;
}

function closeUnsafeDivergence(socket: YjsWebSocketLike): void {
  socket.close(DOCUMENT_SESSION_FAILURE_CLOSE_CODE, JSON.stringify(DOCUMENT_SESSION_UNSAFE_DIVERGENCE_FAILURE));
}

function closeDeletedDocument(socket: YjsWebSocketLike): void {
  socket.close(
    DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
    JSON.stringify(DOCUMENT_SESSION_NOT_FOUND_FAILURE),
  );
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function emitTiming(
  handler: YjsWebSocketTimingHandler | undefined,
  event: YjsWebSocketTimingEvent,
): void {
  if (!handler) return;
  try {
    handler(event);
  } catch {
    // Diagnostic observers must never affect document availability or durability.
  }
}

function toUint8Array(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return undefined;
}
