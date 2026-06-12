import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  MESSAGE_SESSION_EVENT,
  MESSAGE_SYNC,
  MESSAGE_SYNCED,
  decodeSessionEvent,
  type DocumentSessionEvent,
} from '@kb-2/doc-session/protocol';

export const DEMO_DOCUMENT_YJS_PATH = '/api/demo-document/yjs';
export const DEMO_DOCUMENT_TEXT_NAME = 'markdown';

export type DemoDocumentProviderStatus =
  | 'connecting'
  | 'syncing'
  | 'open'
  | 'closed'
  | 'error';

export interface DemoDocumentProvider {
  doc: Y.Doc;
  text: Y.Text;
  destroy: () => void;
}

export interface DemoDocumentProviderOptions {
  url?: string;
  path?: string;
  onStatus?: (status: DemoDocumentProviderStatus) => void;
  onError?: (error: unknown) => void;
  onSessionEvent?: (event: DocumentSessionEvent) => void;
  onSynced?: () => void;
}

export function createDemoDocumentProvider(
  options: DemoDocumentProviderOptions = {},
): DemoDocumentProvider {
  const doc = new Y.Doc();
  const text = doc.getText(DEMO_DOCUMENT_TEXT_NAME);
  const socket = new WebSocket(options.url ?? yjsWebSocketUrl(options.path));
  socket.binaryType = 'arraybuffer';

  let destroyed = false;
  options.onStatus?.('connecting');

  const sendSync = (write: (encoder: encoding.Encoder) => void): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    write(encoder);
    socket.send(encoding.toUint8Array(encoder));
  };

  const updateHandler = (update: Uint8Array, origin: unknown): void => {
    if (origin === socket || destroyed) return;
    sendSync((encoder) => {
      syncProtocol.writeUpdate(encoder, update);
    });
  };

  doc.on('update', updateHandler);

  socket.addEventListener('open', () => {
    options.onStatus?.('syncing');
    sendSync((encoder) => {
      syncProtocol.writeSyncStep1(encoder, doc);
    });
  });

  socket.addEventListener('message', (event) => {
    try {
      const message = toUint8Array(event.data);
      if (!message) return;

      const decoder = decoding.createDecoder(message);
      const encoder = encoding.createEncoder();
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SESSION_EVENT) {
        const event = decodeSessionEvent(decoder);
        if (event) {
          options.onSessionEvent?.(event);
        }
        return;
      }

      if (messageType === MESSAGE_SYNCED) {
        options.onStatus?.('open');
        options.onSynced?.();
        return;
      }

      if (messageType !== MESSAGE_SYNC) return;

      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, socket);
      if (encoding.length(encoder) > 1) {
        socket.send(encoding.toUint8Array(encoder));
      }
    } catch (error) {
      options.onError?.(error);
      socket.close(1003, 'Invalid Yjs sync message');
    }
  });

  socket.addEventListener('error', (event) => {
    options.onStatus?.('error');
    options.onError?.(event);
  });

  socket.addEventListener('close', () => {
    options.onStatus?.('closed');
  });

  return {
    doc,
    text,
    destroy: () => {
      destroyed = true;
      doc.off('update', updateHandler);
      socket.close(1000, 'Editor unmounted');
      doc.destroy();
      options.onStatus?.('closed');
    },
  };
}

function yjsWebSocketUrl(documentPath = 'hello-world.md'): string {
  const url = new URL(`/api/files/${encodeVaultPath(documentPath)}/yjs`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function encodeVaultPath(documentPath: string): string {
  return documentPath.split('/').map(encodeURIComponent).join('/');
}

function toUint8Array(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof Blob) return undefined;
  return undefined;
}
