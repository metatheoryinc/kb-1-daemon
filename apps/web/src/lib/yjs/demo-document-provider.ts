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

export interface DemoDocumentProviderOpenFailure {
  ok: false;
  error: 'not_found';
  message: string;
}

export class DemoDocumentProviderOpenError extends Error {
  constructor(readonly failure: DemoDocumentProviderOpenFailure) {
    super(failure.message);
    this.name = 'DemoDocumentProviderOpenError';
  }
}

export interface DemoDocumentProviderOptions {
  url?: string;
  /** Vault the document lives in — selects the scoped Yjs WS route. */
  vaultId?: string;
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
  const socket = new WebSocket(options.url ?? yjsWebSocketUrl(options.vaultId, options.path));
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

  socket.addEventListener('close', (event) => {
    options.onStatus?.('closed');
    if (destroyed) return;
    const failure = parseOpenFailure(event.reason);
    if (failure) {
      options.onError?.(new DemoDocumentProviderOpenError(failure));
    }
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

export function isDemoDocumentProviderOpenError(error: unknown): error is DemoDocumentProviderOpenError {
  return error instanceof DemoDocumentProviderOpenError;
}

function yjsWebSocketUrl(vaultId: string | undefined, documentPath = 'hello-world.md'): string {
  // The collaborative socket is vault-scoped. A vaultId is always supplied
  // in the app; the fallback keeps the helper usable without one.
  const base = vaultId
    ? `/api/vaults/${encodeURIComponent(vaultId)}/files/${encodeVaultPath(documentPath)}/yjs`
    : `/api/files/${encodeVaultPath(documentPath)}/yjs`;
  const url = new URL(base, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function encodeVaultPath(documentPath: string): string {
  return documentPath.split('/').map(encodeURIComponent).join('/');
}

/**
 * Build the browser route for a document inside a vault:
 * `/<vaultId>/<encoded path>` (or just `/<vaultId>` at the vault root).
 * The vault id is the daemon's stable slug.
 */
export function vaultRoute(vaultId: string, documentPath = ''): string {
  const base = `/${encodeURIComponent(vaultId)}`;
  return documentPath ? `${base}/${encodeVaultPath(documentPath)}` : base;
}

/**
 * Split a browser pathname into `{ vaultId, path }`. The first segment is
 * the vault id; the rest is the vault-relative document path. The root
 * path (`/`) yields no vault id, signalling "redirect to the default
 * vault".
 */
export function parseVaultRoute(pathname: string): { vaultId: string | null; path: string } {
  const trimmed = pathname.replace(/^\/+/, '');
  if (trimmed === '') return { vaultId: null, path: '' };
  const slash = trimmed.indexOf('/');
  if (slash === -1) {
    return { vaultId: decodeURIComponent(trimmed), path: '' };
  }
  const vaultId = decodeURIComponent(trimmed.slice(0, slash));
  const rest = trimmed.slice(slash + 1);
  const path = rest
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/');
  return { vaultId, path };
}

function toUint8Array(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof Blob) return undefined;
  return undefined;
}

function parseOpenFailure(reason: string): DemoDocumentProviderOpenFailure | undefined {
  if (!reason) return undefined;
  try {
    const parsed = JSON.parse(reason) as Partial<DemoDocumentProviderOpenFailure>;
    if (
      parsed.ok === false &&
      parsed.error === 'not_found' &&
      typeof parsed.message === 'string'
    ) {
      return {
        ok: false,
        error: 'not_found',
        message: parsed.message
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
