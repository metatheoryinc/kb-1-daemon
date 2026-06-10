import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket, WebSocketServer } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import { OneFileDocumentSession } from './session.js';
import { DEMO_DOCUMENT_YJS_PATH, bindYjsWebSocket } from './websocket.js';

const messageSync = 0;

describe('Yjs WebSocket session', () => {
  let kb2Home: string;

  beforeEach(async () => {
    kb2Home = await mkdtemp(join(tmpdir(), 'kb2-yjs-ws-'));
  });

  afterEach(async () => {
    await rm(kb2Home, { force: true, recursive: true });
  });

  it('syncs two clients and persists their merged edits', async () => {
    const filePath = join(kb2Home, 'demo-vault', 'hello-world.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await session.open();

    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== DEMO_DOCUMENT_YJS_PATH) {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        void bindYjsWebSocket(session, webSocket);
      });
    });
    await listen(server);

    const port = (server.address() as AddressInfo).port;
    const clientA = await connectYjsClient(`ws://127.0.0.1:${port}${DEMO_DOCUMENT_YJS_PATH}`);
    const clientB = await connectYjsClient(`ws://127.0.0.1:${port}${DEMO_DOCUMENT_YJS_PATH}`);

    clientA.text.insert(0, 'A');
    clientB.text.insert(0, 'B');

    await waitForSharedContent([clientA, clientB], (content) => content.includes('A') && content.includes('B') && content.length === 2);
    await session.flush();

    const diskContent = await readFile(filePath, 'utf8');
    expect(diskContent).toHaveLength(2);
    expect(diskContent).toContain('A');
    expect(diskContent).toContain('B');

    clientA.close();
    clientB.close();
    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
    await session.close();
  });

  it('closes malformed sync frames without crashing the session', async () => {
    const filePath = join(kb2Home, 'demo-vault', 'hello-world.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await session.open();

    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== DEMO_DOCUMENT_YJS_PATH) {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        void bindYjsWebSocket(session, webSocket);
      });
    });
    await listen(server);

    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${DEMO_DOCUMENT_YJS_PATH}`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const closeCode = new Promise<number>((resolve) => {
      socket.once('close', (code) => resolve(code));
    });
    socket.send(new Uint8Array([255]));

    await expect(closeCode).resolves.toBe(1003);
    await expect(session.getContent()).resolves.toBe('');

    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
    await session.close();
  });
});

interface YjsClient {
  doc: Y.Doc;
  text: Y.Text;
  close: () => void;
}

async function connectYjsClient(url: string): Promise<YjsClient> {
  const doc = new Y.Doc();
  const text = doc.getText('markdown');
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';

  doc.on('update', (update, origin) => {
    if (origin === socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    sendSync(socket, (encoder) => {
      syncProtocol.writeUpdate(encoder, update);
    });
  });

  socket.on('message', (data) => {
    const message = toUint8Array(data);
    const decoder = decoding.createDecoder(message);
    const encoder = encoding.createEncoder();
    const messageType = decoding.readVarUint(decoder);

    if (messageType !== messageSync) {
      return;
    }

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
    close: () => socket.close()
  };
}

function sendSync(socket: WebSocket, write: (encoder: encoding.Encoder) => void): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  write(encoder);
  socket.send(encoding.toUint8Array(encoder));
}

function toUint8Array(data: WebSocket.RawData): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (data instanceof Uint8Array) {
    return data;
  }

  return Buffer.concat(data);
}

async function waitForSharedContent(
  clients: YjsClient[],
  predicate: (content: string) => boolean
): Promise<void> {
  if (clients.every((client) => predicate(client.text.toString()))) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for shared Yjs content: ${clients.map((client) => client.text.toString()).join(', ')}`));
    }, 2000);

    const onUpdate = () => {
      if (!clients.every((client) => predicate(client.text.toString()))) {
        return;
      }

      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearTimeout(timeout);
      for (const client of clients) {
        client.doc.off('update', onUpdate);
      }
    };

    for (const client of clients) {
      client.doc.on('update', onUpdate);
    }
  });
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
