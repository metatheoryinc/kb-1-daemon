import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket, WebSocketServer } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import {
  MESSAGE_SESSION_EVENT,
  MESSAGE_SYNC,
  OneFileDocumentSession,
  decodeSessionEvent,
  type DocumentSessionEvent
} from './index.js';
import { bindYjsWebSocket } from './websocket.js';

const DEMO_DOCUMENT_YJS_PATH = '/api/demo-document/yjs';

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

  it('reconciles idle external file changes and broadcasts the quiet merge event to every client', async () => {
    const filePath = join(kb2Home, 'demo-vault', 'hello-world.md');
    const session = new OneFileDocumentSession(filePath, {
      defaultContent: 'initial\n',
      watchDebounceMs: 10,
      watchPollMs: 50
    });
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

    await waitForSharedContent([clientA, clientB], (content) => content === 'initial\n');

    await writeFile(filePath, 'changed outside\n', 'utf8');

    await waitForSharedContent([clientA, clientB], (content) => content === 'changed outside\n');
    await waitForSessionEvent([clientA, clientB], 'external-merge');

    clientA.close();
    clientB.close();
    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
    await session.close();
  });

  it('broadcasts persist failure and recovery events to every client', async () => {
    const filePath = join(kb2Home, 'demo-vault', 'hello-world.md');
    const vaultDir = join(kb2Home, 'demo-vault');
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

    try {
      await chmod(vaultDir, 0o500);
      clientA.text.insert(0, 'unsaved while readonly\n');
      await waitForSessionEvent([clientA, clientB], 'persist-failure');

      await chmod(vaultDir, 0o700);
      clientA.text.insert(clientA.text.length, 'saved after recovery\n');
      await waitForSessionEvent([clientA, clientB], 'persist-recovered');

      await waitForDiskContent(filePath, (content) =>
        content === 'unsaved while readonly\nsaved after recovery\n'
      );
    } finally {
      await chmod(vaultDir, 0o700).catch(() => undefined);
      clientA.close();
      clientB.close();
      await closeWebSocketServer(webSocketServer);
      await closeServer(server);
      await session.close();
    }
  });

  it('replays active persist failure to clients that bind after the failure', async () => {
    const filePath = join(kb2Home, 'demo-vault', 'hello-world.md');
    const vaultDir = join(kb2Home, 'demo-vault');
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

    try {
      await chmod(vaultDir, 0o500);
      clientA.text.insert(0, 'unsaved before joiner\n');
      await waitForSessionEvent([clientA], 'persist-failure');

      const lateClient = await connectYjsClient(`ws://127.0.0.1:${port}${DEMO_DOCUMENT_YJS_PATH}`);
      try {
        await waitForSessionEvent([lateClient], 'persist-failure');
      } finally {
        lateClient.close();
      }

      await chmod(vaultDir, 0o700);
      clientA.text.insert(clientA.text.length, 'saved after replay\n');
      await waitForSessionEvent([clientA], 'persist-recovered');
    } finally {
      await chmod(vaultDir, 0o700).catch(() => undefined);
      clientA.close();
      await closeWebSocketServer(webSocketServer);
      await closeServer(server);
      await session.close();
    }
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
  events: DocumentSessionEvent[];
  close: () => void;
}

async function connectYjsClient(url: string): Promise<YjsClient> {
  const doc = new Y.Doc();
  const text = doc.getText('markdown');
  const events: DocumentSessionEvent[] = [];
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

    if (messageType === MESSAGE_SESSION_EVENT) {
      const event = decodeSessionEvent(decoder);
      if (event) {
        events.push(event);
      }
      return;
    }

    if (messageType !== MESSAGE_SYNC) {
      return;
    }

    encoding.writeVarUint(encoder, MESSAGE_SYNC);
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
    events,
    close: () => socket.close()
  };
}

function sendSync(socket: WebSocket, write: (encoder: encoding.Encoder) => void): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
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

async function waitForSessionEvent(
  clients: YjsClient[],
  kind: DocumentSessionEvent['kind'],
): Promise<void> {
  await waitUntil(() => clients.every((client) => client.events.some((event) => event.kind === kind)), () =>
    `Timed out waiting for ${kind}: ${clients.map((client) => JSON.stringify(client.events)).join(' | ')}`
  );
}

async function waitForDiskContent(
  filePath: string,
  predicate: (content: string) => boolean,
): Promise<void> {
  await waitUntil(async () => predicate(await readFile(filePath, 'utf8')), () =>
    `Timed out waiting for disk content at ${filePath}`
  );
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
