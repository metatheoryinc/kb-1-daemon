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
import { afterEach, beforeEach, describe, it } from 'vitest';

import { bindYjsWebSocket, OneFileDocumentSession } from '@kb-2/doc-session';
import {
  createDemoDocumentProvider,
  DEMO_DOCUMENT_TEXT_NAME,
  DEMO_DOCUMENT_YJS_PATH,
} from './demo-document-provider';

const messageSync = 0;

describe('demo document provider', () => {
  let kb2Home: string;
  let originalEnv: NodeJS.ProcessEnv;
  let server: Server | undefined;
  let webSocketServer: WebSocketServer | undefined;
  let session: OneFileDocumentSession | undefined;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    kb2Home = await mkdtemp(join(tmpdir(), 'kb2-web-provider-'));
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
    await rm(kb2Home, { recursive: true, force: true });
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  });

  it('converges with a raw y-protocols client through the daemon and persists to disk', async () => {
    const filePath = join(kb2Home, 'demo-vault', 'hello-world.md');
    session = new OneFileDocumentSession(filePath);
    await session.open();

    server = createServer();
    webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== DEMO_DOCUMENT_YJS_PATH) {
        socket.destroy();
        return;
      }

      webSocketServer!.handleUpgrade(request, socket, head, (webSocket) => {
        void bindYjsWebSocket(session!, webSocket);
      });
    });
    await listen(server);
    const port = (server.address() as AddressInfo).port;

    const url = `ws://127.0.0.1:${port}${DEMO_DOCUMENT_YJS_PATH}`;
    const provider = createDemoDocumentProvider({ url });
    const raw = await connectRawYjsClient(url);

    await waitForContent(
      [provider.text, raw.text],
      (content) => content.includes('Hello KB-2'),
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

    raw.close();
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
  const text = doc.getText(DEMO_DOCUMENT_TEXT_NAME);
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
