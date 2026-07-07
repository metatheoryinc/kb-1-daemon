#!/usr/bin/env node

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

const messageSync = 0;
const port = process.env.KB1_PORT || process.env.KB2_PORT || '8787';
const host = process.env.KB1_HOST || process.env.KB2_HOST || '127.0.0.1';
const url = process.env.KB1_YJS_URL
  || process.env.KB2_YJS_URL
  || `ws://${host}:${port}/api/vaults/demo-vault/files/README.md/yjs`;

const clientA = await connectYjsClient(url);
const clientB = await connectYjsClient(url);

await waitForSharedContent([clientA, clientB], (content) => content.includes('Hello KB-1'));

const stamp = Date.now();
clientA.text.insert(clientA.text.length, `- smoke client A ${stamp}\n`);
clientB.text.insert(clientB.text.length, `- smoke client B ${stamp}\n`);

await waitForSharedContent([clientA, clientB], (content) => content.includes('smoke client A') && content.includes('smoke client B'));

console.log(`Connected two Yjs clients to ${url}`);
console.log(clientA.text.toString());

clientA.close();
clientB.close();

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
    socket.once('open', () => {
      sendSync(socket, (encoder) => {
        syncProtocol.writeSyncStep1(encoder, doc);
      });

      resolve({
        doc,
        text,
        close: () => socket.close()
      });
    });
    socket.once('error', reject);
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

async function waitForSharedContent(clients, predicate) {
  if (clients.every((client) => predicate(client.text.toString()))) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for shared Yjs content: ${clients.map((client) => client.text.toString()).join(', ')}`));
    }, 5000);

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
