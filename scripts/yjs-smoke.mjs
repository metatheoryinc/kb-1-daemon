#!/usr/bin/env node

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const messageSync = 0;
const port = process.env.KB1_PORT || '8787';
const host = process.env.KB1_HOST || '127.0.0.1';
const url = process.env.KB1_YJS_URL
  || `ws://${host}:${port}/api/vaults/demo-vault/files/README.md/yjs`;
const expectedStarterText = process.env.KB1_YJS_EXPECTED_TEXT || 'Welcome to your vault';
const timeoutMs = Number(process.env.KB1_SMOKE_TIMEOUT_MS || '10000');
const endpoints = smokeEndpoints(url);
const clients = [];

try {
  const clientA = await connectYjsClient(url);
  clients.push(clientA);
  const clientB = await connectYjsClient(url);
  clients.push(clientB);

  await waitForSharedContent(
    [clientA, clientB],
    (content) => content.includes(expectedStarterText),
    `the shipped starter text ${JSON.stringify(expectedStarterText)}`
  );

  const stamp = `${Date.now()}-${process.pid}`;
  const markerA = `- Yjs release smoke client A ${stamp}\n`;
  const markerB = `- Yjs release smoke client B ${stamp}\n`;
  clientA.text.insert(clientA.text.length, markerA);
  clientB.text.insert(clientB.text.length, markerB);

  await waitForSharedContent(
    [clientA, clientB],
    (content) => content.includes(markerA) && content.includes(markerB),
    'both concurrent client edits'
  );

  const flush = await fetch(endpoints.flush, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const flushBody = await jsonResponse(flush, 'flush dirty Yjs sessions');
  if (flushBody.ok !== true || typeof flushBody.durableAsOf !== 'string') {
    throw new Error(`Yjs flush did not return a durability barrier: ${JSON.stringify(flushBody)}`);
  }

  await waitForPersistedContent(endpoints.rawFile, (content) => (
    content.includes(markerA) && content.includes(markerB)
  ));

  await Promise.all(clients.splice(0).map((client) => client.close()));

  const reconnect = await connectYjsClient(url);
  clients.push(reconnect);
  await waitForSharedContent(
    [reconnect],
    (content) => content.includes(markerA) && content.includes(markerB),
    'both durable edits after reconnect'
  );

  console.log(`Yjs release smoke passed against ${url}`);
  console.log(`Durable as of ${flushBody.durableAsOf}; verified two-client sync, raw disk bytes, and reconnect.`);
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
}

function connectYjsClient(targetUrl) {
  const doc = new Y.Doc();
  const text = doc.getText('markdown');
  const socket = new WebSocket(targetUrl);
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

  return new Promise((resolve, reject) => {
    const cleanupOpening = () => {
      clearTimeout(openingTimeout);
      socket.off('open', handleOpen);
      socket.off('error', failOpen);
    };
    const failOpen = (error) => {
      cleanupOpening();
      socket.once('error', () => undefined);
      socket.terminate();
      doc.destroy();
      reject(error);
    };
    const handleOpen = () => {
      cleanupOpening();
      socket.on('error', (error) => {
        console.error(`Yjs smoke socket error: ${error.message}`);
      });
      try {
        sendSync(socket, (encoder) => {
          syncProtocol.writeSyncStep1(encoder, doc);
        });
      } catch (error) {
        socket.terminate();
        doc.destroy();
        reject(error);
        return;
      }

      resolve({
        doc,
        text,
        close: () => closeSocket(socket, doc)
      });
    };
    const openingTimeout = setTimeout(() => {
      failOpen(new Error(`Timed out opening Yjs WebSocket ${targetUrl}`));
    }, timeoutMs);
    socket.once('open', handleOpen);
    socket.once('error', failOpen);
  });
}

function closeSocket(socket, doc) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(closeTimeout);
      doc.destroy();
      resolve();
    };
    const closeTimeout = setTimeout(() => {
      socket.terminate();
      finish();
    }, timeoutMs);
    if (socket.readyState === WebSocket.CLOSED) {
      finish();
      return;
    }
    socket.once('close', finish);
    socket.close();
  });
}

function sendSync(socket, write) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  write(encoder);
  socket.send(encoding.toUint8Array(encoder));
}

function toUint8Array(data) {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (data instanceof Uint8Array) {
    return data;
  }

  return Buffer.concat(data);
}

async function waitForSharedContent(clientsToCheck, predicate, description) {
  await waitForCondition(
    () => clientsToCheck.every((client) => predicate(client.text.toString())),
    (notify) => {
      for (const client of clientsToCheck) client.doc.on('update', notify);
      return () => {
        for (const client of clientsToCheck) client.doc.off('update', notify);
      };
    },
    `Timed out waiting for ${description}. Current content: ${clientsToCheck.map((client) => client.text.toString()).join(', ')}`
  );
}

async function waitForPersistedContent(fileUrl, predicate) {
  const deadline = Date.now() + timeoutMs;
  let lastBody;
  while (Date.now() < deadline) {
    const response = await fetch(fileUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    });
    lastBody = await response.text();
    if (response.ok && predicate(lastBody)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for durable raw file content: ${JSON.stringify(lastBody)}`);
}

function waitForCondition(predicate, subscribe, timeoutMessage) {
  if (predicate()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let unsubscribe = () => undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      unsubscribe();
    };
    const notify = () => {
      if (!predicate()) return;
      cleanup();
      resolve();
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    unsubscribe = subscribe(notify);
    notify();
  });
}

async function jsonResponse(response, action) {
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !body || typeof body !== 'object') {
    throw new Error(`Failed to ${action}: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function smokeEndpoints(webSocketUrl) {
  const parsed = new URL(webSocketUrl);
  const match = parsed.pathname.match(/^(\/api\/vaults\/[^/]+)\/files\/(.+)\/yjs$/);
  if (!match) {
    throw new Error(
      `KB1_YJS_URL must use /api/vaults/:id/files/:path/yjs so persistence can be verified: ${webSocketUrl}`
    );
  }
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  const origin = parsed.origin;
  return {
    rawFile: new URL(`${match[1]}/raw/${match[2]}`, origin),
    flush: new URL(`${match[1]}/ops/flush`, origin)
  };
}
