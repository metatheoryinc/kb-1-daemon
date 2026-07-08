import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket, WebSocketServer } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bindYjsWebSocket,
  OneFileDocumentSession,
  encodeSessionEvent,
  type DocumentSessionEvent,
} from '@kb-1/doc-session';
import {
  createLocalDocumentProvider,
  LOCAL_DOCUMENT_TEXT_NAME,
  isLocalDocumentProviderOpenError,
  type LocalDocumentProviderSaveState,
} from './local-document-provider';

const messageSync = 0;
const TEST_DOCUMENT_YJS_PATH = '/api/demo-document/yjs';
const DEFAULT_TEST_DOCUMENT_CONTENT = [
  '# Hello KB-1',
  '',
  'This Markdown file is served by the local KB-1 daemon.',
  '',
].join('\n');

describe('local document provider', () => {
  let kb1Home: string;
  let originalEnv: NodeJS.ProcessEnv;
  let server: Server | undefined;
  let webSocketServer: WebSocketServer | undefined;
  let session: OneFileDocumentSession | undefined;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    kb1Home = await mkdtemp(join(tmpdir(), 'kb1-web-provider-'));
    (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
  });

  afterEach(async () => {
    if (webSocketServer) {
      await closeWebSocketServer(webSocketServer);
      webSocketServer = undefined;
    }
    if (server) {
      await closeServer(server);
      server = undefined;
    }
    if (session) {
      await session.close();
      session = undefined;
    }
    process.env = originalEnv;
    await rm(kb1Home, { recursive: true, force: true });
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  });

  it('converges with a raw y-protocols client through the daemon and persists to disk', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
    session = new OneFileDocumentSession(filePath, { defaultContent: DEFAULT_TEST_DOCUMENT_CONTENT });
    await session.open();

    server = createServer();
    webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== TEST_DOCUMENT_YJS_PATH) {
        socket.destroy();
        return;
      }

      webSocketServer!.handleUpgrade(request, socket, head, (webSocket) => {
        void bindYjsWebSocket(session!, webSocket);
      });
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;

    const url = `ws://127.0.0.1:${port}${TEST_DOCUMENT_YJS_PATH}`;
    const saveStates: LocalDocumentProviderSaveState[] = [];
    const provider = createLocalDocumentProvider({
      url,
      onSaveState: (state) => saveStates.push(state),
    });
    const raw = await connectRawYjsClient(url);

    await waitForContent(
      [provider.text, raw.text],
      (content) => content.includes('Hello KB-1'),
    );

    provider.text.insert(provider.text.length, '\nprovider edit');
    raw.text.insert(raw.text.length, '\nraw client edit');

    await waitForContent(
      [provider.text, raw.text],
      (content) => content.includes('provider edit') && content.includes('raw client edit'),
    );

    await waitForDiskContent(
      filePath,
      (content) => content.includes('provider edit') && content.includes('raw client edit'),
    );
    await waitUntil(
      () =>
        saveStates.some((state) => state.status === 'saving') &&
        saveStates[saveStates.length - 1]?.status === 'saved',
      () => `Timed out waiting for ack-backed save state: ${JSON.stringify(saveStates)}`
    );

    raw.close();
    provider.destroy();
  });

  it('surfaces document session events from the shared WebSocket', async () => {
    const events: DocumentSessionEvent[] = [];

    server = createServer();
    webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== TEST_DOCUMENT_YJS_PATH) {
        socket.destroy();
        return;
      }

      webSocketServer!.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.send(encodeSessionEvent({
          kind: 'external-merge',
          path: join(kb1Home, 'demo-vault', 'hello-world.md'),
          ts: 123,
        }));
      });
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;

    const provider = createLocalDocumentProvider({
      url: `ws://127.0.0.1:${port}${TEST_DOCUMENT_YJS_PATH}`,
      onSessionEvent: (event) => events.push(event),
    });

    await waitUntil(() => events.some((event) => event.kind === 'external-merge'), () =>
      `Timed out waiting for provider session event: ${JSON.stringify(events)}`
    );

    provider.destroy();
  });

  it('surfaces canonical not_found session-open failures from the WebSocket close reason', async () => {
    const errors: unknown[] = [];

    server = createServer();
    webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== TEST_DOCUMENT_YJS_PATH) {
        socket.destroy();
        return;
      }

      webSocketServer!.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.close(1008, JSON.stringify({ ok: false, error: 'not_found', message: 'file not found' }));
      });
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;

    const provider = createLocalDocumentProvider({
      url: `ws://127.0.0.1:${port}${TEST_DOCUMENT_YJS_PATH}`,
      onError: (error) => errors.push(error),
    });

    await waitUntil(() => errors.some(isLocalDocumentProviderOpenError), () =>
      `Timed out waiting for provider open failure: ${String(errors[0])}`
    );
    const failure = errors.find(isLocalDocumentProviderOpenError)?.failure;
    expect(failure).toEqual({ ok: false, error: 'not_found', message: 'file not found' });

    provider.destroy();
  });
});

interface RawYjsClient {
  doc: Y.Doc;
  text: Y.Text;
  close: () => void;
}

async function connectRawYjsClient(url: string): Promise<RawYjsClient> {
  const doc = new Y.Doc();
  const text = doc.getText(LOCAL_DOCUMENT_TEXT_NAME);
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';

  doc.on('update', (update, origin) => {
    if (origin === socket || socket.readyState !== WebSocket.OPEN) return;
    sendSync(socket, (encoder) => {
      syncProtocol.writeUpdate(encoder, update);
    });
  });

  socket.on('message', (data) => {
    const message = toUint8Array(data);
    const decoder = decoding.createDecoder(message);
    const encoder = encoding.createEncoder();
    const messageType = decoding.readVarUint(decoder);
    if (messageType !== messageSync) return;

    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.readSyncMessage(decoder, encoder, doc, socket);
    if (encoding.length(encoder) > 1) {
      socket.send(encoding.toUint8Array(encoder));
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  sendSync(socket, (encoder) => {
    syncProtocol.writeSyncStep1(encoder, doc);
  });

  return {
    doc,
    text,
    close: () => {
      socket.close();
      doc.destroy();
    },
  };
}

function sendSync(socket: WebSocket, write: (encoder: encoding.Encoder) => void): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  write(encoder);
  socket.send(encoding.toUint8Array(encoder));
}

function toUint8Array(data: WebSocket.RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  return Buffer.concat(data);
}

async function waitForContent(
  texts: Y.Text[],
  predicate: (content: string) => boolean,
): Promise<void> {
  await waitUntil(() => texts.every((text) => predicate(text.toString())), () =>
    `Timed out waiting for Yjs content: ${texts.map((text) => text.toString()).join(' | ')}`,
  );
}

async function waitForDiskContent(
  filePath: string,
  predicate: (content: string) => boolean,
): Promise<void> {
  await waitUntil(async () => {
    const content = await readFile(filePath, 'utf8');
    return predicate(content);
  }, () => `Timed out waiting for disk content at ${filePath}`);
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  errorMessage: () => string,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(errorMessage());
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.close();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
