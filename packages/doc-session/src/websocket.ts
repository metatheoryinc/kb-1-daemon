import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';

import { PersistFailedError, type OneFileDocumentSession } from './session.js';
import { MESSAGE_SYNC, encodeSessionEvent } from './protocol.js';

export const DEMO_DOCUMENT_YJS_PATH = '/api/demo-document/yjs';

const socketOpen = 1;

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

export async function bindYjsWebSocket(
  session: OneFileDocumentSession,
  socket: YjsWebSocketLike
): Promise<BoundYjsWebSocket> {
  await session.open();
  let cleanupStarted = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  let unsubscribeSessionEvents: () => void = () => {};

  const updateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === socket) {
      return;
    }

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
    session.ydoc.off('update', updateHandler);
    session.flush().then(resolveClosed, (error: unknown) => {
      if (error instanceof PersistFailedError) {
        resolveClosed();
        return;
      }
      rejectClosed(error);
    });
  };

  socket.on('message', (data) => {
    try {
      const message = toUint8Array(data);
      if (!message) {
        return;
      }

      const decoder = decoding.createDecoder(message);
      const encoder = encoding.createEncoder();
      const messageType = decoding.readVarUint(decoder);

      if (messageType !== MESSAGE_SYNC) {
        return;
      }

      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, session.ydoc, socket);

      if (encoding.length(encoder) > 1) {
        sendEncoded(socket, encoder);
      }
    } catch {
      socket.close(1003, 'Invalid Yjs sync message');
    }
  });

  session.ydoc.on('update', updateHandler);
  unsubscribeSessionEvents = session.onEvent((event) => {
    sendBytes(socket, encodeSessionEvent(event));
  });

  const activePersistFailure = session.getActivePersistFailureEvent();
  if (activePersistFailure) {
    sendBytes(socket, encodeSessionEvent(activePersistFailure));
  }

  sendSync(socket, (encoder) => {
    syncProtocol.writeSyncStep1(encoder, session.ydoc);
  });

  socket.on('close', cleanup);
  socket.on('error', cleanup);

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
