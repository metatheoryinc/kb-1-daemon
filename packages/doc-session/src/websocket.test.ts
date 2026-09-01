import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket, WebSocketServer } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import {
  DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
  DOCUMENT_SESSION_NOT_FOUND_FAILURE,
  DOCUMENT_SESSION_UNSAFE_DIVERGENCE_FAILURE,
  LOCAL_AGENT_DOCUMENT_UPDATE_ATTRIBUTION,
  LOCAL_USER_DOCUMENT_UPDATE_ATTRIBUTION,
  MESSAGE_ACKED_SYNC_UPDATE,
  MESSAGE_ATTRIBUTED_SYNC_UPDATE,
  MESSAGE_SESSION_EVENT,
  MESSAGE_SYNC,
  MESSAGE_SYNC_UPDATE_ACK,
  OneFileDocumentSession,
  PersistFailedError,
  UNKNOWN_DOCUMENT_UPDATE_ATTRIBUTION,
  decodeAttributedSyncUpdate,
  decodeSyncUpdateAck,
  decodeSessionEvent,
  encodeAckedSyncUpdate,
  type AttributedSyncUpdate,
  type DocumentSessionEvent,
  type YjsWebSocketTimingEvent,
  type YjsWebSocketLike
} from './index.js';
import { bindYjsWebSocket, documentStateVectorTimingFields } from './websocket.js';
import { fingerprintDocumentBytes } from './fingerprint.js';

const DEMO_DOCUMENT_YJS_PATH = '/api/demo-document/yjs';

describe('Yjs WebSocket session', () => {
  let kb1Home: string;

  beforeEach(async () => {
    kb1Home = await mkdtemp(join(tmpdir(), 'kb1-yjs-ws-'));
  });

  afterEach(async () => {
    await rm(kb1Home, { force: true, recursive: true });
  });

  it('syncs two clients and persists their merged edits', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
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

  it('acknowledges a tagged client update only after it is persisted', async () => {
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    const filePath = join(kb1Home, 'demo-vault', 'acked.md');
    const stateFilePath = join(kb1Home, '.kb1', 'doc-session-state', 'acked.json');
    const session = new OneFileDocumentSession(filePath, {
      defaultContent: '',
      stateFilePath
    });
    await session.open();
    const socket = new FakeSocket();
    const timings: YjsWebSocketTimingEvent[] = [];
    const binding = await bindYjsWebSocket(session, socket, {
      onTiming: (event) => timings.push(event)
    });
    const delayStartedAt = performance.now();
    while (performance.now() - delayStartedAt < 15) {
      // Keep deferred fingerprint work waiting so timestamp drift is observable.
    }
    const clientDoc = new Y.Doc();
    clientDoc.getText('markdown').insert(0, 'acked browser edit\n');

    socket.emitMessage(encodeAckedSyncUpdate({
      ackId: 'update-1',
      update: Y.encodeStateAsUpdate(clientDoc)
    }));

    await waitForDiskContent(filePath, (content) => content === 'acked browser edit\n');
    await waitUntil(
      () => Boolean(findSyncUpdateAck(socket.sent, 'update-1')),
      () => `Timed out waiting for update ack; sent=${describeMessages(socket.sent)}`
    );

    const ack = findSyncUpdateAck(socket.sent, 'update-1');
    expect(ack?.ackId).toBe('update-1');
    expect(typeof ack?.ts).toBe('number');
    expect(timings.map((event) => event.stage)).toEqual(expect.arrayContaining([
      'document_session.open',
      'initial_sync.emitted',
      'initial_state_vector.observed',
      'markdown.read',
      'markdown.atomic_write_fsync',
      'yjs_state.atomic_write_fsync',
      'save_ack.emitted'
    ]));
    const timingStages = timings.map((event) => event.stage);
    expect(timingStages.lastIndexOf('save_ack.emitted')).toBeGreaterThan(
      timingStages.lastIndexOf('yjs_state.atomic_write_fsync')
    );
    const initialStateVector = findInitialStateVector(socket.sent);
    expect(initialStateVector).toBeDefined();
    const initialSyncTiming = timings.find((event) => event.stage === 'initial_sync.emitted');
    const initialStateVectorTiming = timings.find(
      (event) => event.stage === 'initial_state_vector.observed'
    );
    expect(initialStateVectorTiming).toMatchObject({
      documentChars: expect.any(Number),
      observedAtMs: expect.any(Number),
      stateVectorBytes: initialStateVector?.byteLength,
      stateVectorFingerprint: fingerprintDocumentBytes(initialStateVector ?? new Uint8Array()),
    });
    expect(initialStateVectorTiming?.durationMs).toBe(initialSyncTiming?.durationMs);
    const initialStateVectorObservedAtMs = initialStateVectorTiming
      && 'observedAtMs' in initialStateVectorTiming
      ? initialStateVectorTiming.observedAtMs
      : undefined;
    const initialSyncObservedAtMs = initialSyncTiming
      && 'observedAtMs' in initialSyncTiming
      ? initialSyncTiming.observedAtMs
      : undefined;
    expect(initialStateVectorObservedAtMs).toBe(initialSyncObservedAtMs);
    expect(timings.find((event) => event.stage === 'save_ack.emitted')).toMatchObject({
      ackId: 'update-1',
      observedAtMs: expect.any(Number),
      updateBytes: expect.any(Number),
      updateFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      stateVectorFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });

    socket.emitClose();
    await binding.closed;
    await session.close();
    clientDoc.destroy();
  });

  it('dispatches burst save acknowledgements before collecting their shared state timing', async () => {
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    const filePath = join(kb1Home, 'demo-vault', 'burst-acked.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await session.open();
    const socket = new FakeSocket();
    const ackCountsAtSaveTiming: number[] = [];
    const timings: YjsWebSocketTimingEvent[] = [];
    const binding = await bindYjsWebSocket(session, socket, {
      onTiming: (event) => {
        timings.push(event);
        if (event.stage === 'save_ack.emitted') {
          ackCountsAtSaveTiming.push([
            findSyncUpdateAck(socket.sent, 'burst-1'),
            findSyncUpdateAck(socket.sent, 'burst-2'),
          ].filter(Boolean).length);
        }
      }
    });
    const clientDoc = new Y.Doc();
    clientDoc.getText('markdown').insert(0, 'first');
    const firstUpdate = Y.encodeStateAsUpdate(clientDoc);
    clientDoc.getText('markdown').insert(clientDoc.getText('markdown').length, ' second');
    const secondUpdate = Y.encodeStateAsUpdate(clientDoc);

    socket.emitMessage(encodeAckedSyncUpdate({ ackId: 'burst-1', update: firstUpdate }));
    socket.emitMessage(encodeAckedSyncUpdate({ ackId: 'burst-2', update: secondUpdate }));

    await waitUntil(
      () => timings.filter((event) => event.stage === 'save_ack.emitted').length === 2,
      () => `Timed out waiting for burst save timings; sent=${describeMessages(socket.sent)}`
    );
    expect(ackCountsAtSaveTiming).toEqual([2, 2]);
    const saveTimings = timings.filter((event) => event.stage === 'save_ack.emitted');
    expect(saveTimings.map((event) => 'ackId' in event ? event.ackId : undefined).sort())
      .toEqual(['burst-1', 'burst-2']);
    expect(saveTimings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ackId: 'burst-1',
        updateBytes: firstUpdate.byteLength,
        updateFingerprint: fingerprintDocumentBytes(firstUpdate),
      }),
      expect.objectContaining({
        ackId: 'burst-2',
        updateBytes: secondUpdate.byteLength,
        updateFingerprint: fingerprintDocumentBytes(secondUpdate),
      }),
    ]));
    expect(saveTimings.every((event) => (
      'observedAtMs' in event && typeof event.observedAtMs === 'number'
    ))).toBe(true);
    expect(new Set(saveTimings.map((event) => (
      'stateVectorFingerprint' in event ? event.stateVectorFingerprint : undefined
    ))).size).toBe(1);

    socket.emitClose();
    await binding.closed;
    await session.close();
    clientDoc.destroy();
  });

  it('emits save acknowledgement telemetry when the session becomes terminal after the ack', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'terminal-after-ack.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await session.open();
    const activeDoc = session.ydoc;
    let sessionTerminal = false;
    Object.defineProperty(session, 'ydoc', {
      configurable: true,
      get: () => {
        if (sessionTerminal) throw new Error('file not found');
        return activeDoc;
      },
    });
    const socket = new FakeSocket();
    const originalSend = socket.send.bind(socket);
    socket.send = (data: Uint8Array) => {
      originalSend(data);
      if (messageType(data) === MESSAGE_SYNC_UPDATE_ACK) sessionTerminal = true;
    };
    const timings: YjsWebSocketTimingEvent[] = [];
    const binding = await bindYjsWebSocket(session, socket, {
      onTiming: (event) => timings.push(event)
    });
    const clientDoc = new Y.Doc();
    clientDoc.getText('markdown').insert(0, 'durable before terminal state\n');

    socket.emitMessage(encodeAckedSyncUpdate({
      ackId: 'terminal-after-ack',
      update: Y.encodeStateAsUpdate(clientDoc)
    }));

    await waitUntil(
      () => timings.some((event) => (
        event.stage === 'save_ack.emitted' && event.ackId === 'terminal-after-ack'
      )),
      () => `Timed out waiting for terminal save timing; sent=${describeMessages(socket.sent)}`
    );
    expect(timings.find((event) => (
      event.stage === 'save_ack.emitted' && event.ackId === 'terminal-after-ack'
    ))).toMatchObject({
      stateVectorFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });

    socket.emitClose();
    await binding.closed;
    delete (session as unknown as Record<string, unknown>).ydoc;
    await session.close();
    clientDoc.destroy();
  });

  it('emits save acknowledgement telemetry after persistence recovers', async () => {
    const vaultDir = join(kb1Home, 'demo-vault');
    const filePath = join(vaultDir, 'recovered-ack.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await session.open();
    const socket = new FakeSocket();
    const timings: YjsWebSocketTimingEvent[] = [];
    const binding = await bindYjsWebSocket(session, socket, {
      onTiming: (event) => timings.push(event)
    });
    const clientDoc = new Y.Doc();
    clientDoc.getText('markdown').insert(0, 'persist after recovery\n');
    const update = Y.encodeStateAsUpdate(clientDoc);

    try {
      await chmod(vaultDir, 0o500);
      socket.emitMessage(encodeAckedSyncUpdate({ ackId: 'recovered-1', update }));
      await waitUntil(
        () => socket.sent.some((message) => sessionEventKind(message) === 'persist-failure'),
        () => `Timed out waiting for persist failure; sent=${describeMessages(socket.sent)}`
      );
      expect(findSyncUpdateAck(socket.sent, 'recovered-1')).toBeUndefined();

      await chmod(vaultDir, 0o700);
      await session.flush();
      await waitUntil(
        () => timings.some((event) => (
          event.stage === 'save_ack.emitted' && event.ackId === 'recovered-1'
        )),
        () => `Timed out waiting for recovered save timing; sent=${describeMessages(socket.sent)}`
      );

      expect(findSyncUpdateAck(socket.sent, 'recovered-1')).toBeDefined();
      expect(timings.find((event) => (
        event.stage === 'save_ack.emitted' && event.ackId === 'recovered-1'
      ))).toMatchObject({
        observedAtMs: expect.any(Number),
        updateBytes: update.byteLength,
        updateFingerprint: fingerprintDocumentBytes(update),
        stateVectorFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
    } finally {
      await chmod(vaultDir, 0o700).catch(() => undefined);
      socket.emitClose();
      await binding.closed;
      await session.close();
      clientDoc.destroy();
    }
  });

  it('emits captured initial state telemetry after a fast socket close', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'fast-close.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: 'durable\n' });
    await session.open();
    const socket = new FakeSocket();
    const timings: YjsWebSocketTimingEvent[] = [];
    const binding = await bindYjsWebSocket(session, socket, {
      onTiming: (event) => timings.push(event)
    });

    socket.readyState = WebSocket.CLOSED;
    socket.emitClose();
    await binding.closed;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(timings.find((event) => event.stage === 'initial_state_vector.observed')).toMatchObject({
      documentChars: 'durable\n'.length,
      observedAtMs: expect.any(Number),
      stateVectorBytes: expect.any(Number),
      stateVectorFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    await session.close();
  });

  it('sends opaque attribution sidecars for attributed session mutations', async () => {
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    const filePath = join(kb1Home, 'demo-vault', 'attributed.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await session.open();
    const socket = new FakeSocket();
    const binding = await bindYjsWebSocket(session, socket);
    socket.sent.length = 0;

    const attribution = {
      actor: { kind: 'integration', id: 'agent-1', name: 'Agent One' },
      operation: 'write',
      path: 'attributed.md'
    };
    await session.applyContent('attributed write\n', { attribution });

    await waitUntil(
      () => Boolean(findAttributedSyncUpdate(socket.sent)),
      () => `Timed out waiting for attributed sync update; sent=${describeMessages(socket.sent)}`
    );
    const attributed = findAttributedSyncUpdate(socket.sent);
    expect(attributed?.attribution).toEqual(attribution);

    const attributedDoc = new Y.Doc();
    Y.applyUpdate(attributedDoc, attributed!.update);
    expect(attributedDoc.getText('markdown').toString()).toBe('attributed write\n');
    expect(socket.sent.some((message) => messageType(message) === MESSAGE_SYNC)).toBe(true);

    socket.emitClose();
    await binding.closed;
    await session.close();
    attributedDoc.destroy();
  });

  it('sends sentinel attribution sidecars for local and unknown document updates', async () => {
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    const filePath = join(kb1Home, 'demo-vault', 'sentinels.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await session.open();
    const socket = new FakeSocket();
    const binding = await bindYjsWebSocket(session, socket);

    socket.sent.length = 0;
    await session.applyContent('local write\n');
    await waitUntil(
      () => Boolean(findAttributedSyncUpdate(socket.sent)),
      () => `Timed out waiting for local user attribution; sent=${describeMessages(socket.sent)}`
    );
    expect(findAttributedSyncUpdate(socket.sent)?.attribution).toEqual(LOCAL_USER_DOCUMENT_UPDATE_ATTRIBUTION);

    socket.sent.length = 0;
    await session.applyContentEdit(() => 'local agent splice\n');
    await waitUntil(
      () => Boolean(findAttributedSyncUpdate(socket.sent)),
      () => `Timed out waiting for local agent attribution; sent=${describeMessages(socket.sent)}`
    );
    expect(findAttributedSyncUpdate(socket.sent)?.attribution).toEqual(LOCAL_AGENT_DOCUMENT_UPDATE_ATTRIBUTION);

    socket.sent.length = 0;
    session.ydoc.getText('markdown').insert(0, 'unknown origin ');
    await waitUntil(
      () => Boolean(findAttributedSyncUpdate(socket.sent)),
      () => `Timed out waiting for unknown attribution; sent=${describeMessages(socket.sent)}`
    );
    expect(findAttributedSyncUpdate(socket.sent)?.attribution).toEqual(UNKNOWN_DOCUMENT_UPDATE_ATTRIBUTION);

    socket.emitClose();
    await binding.closed;
    await session.close();
  });

  it('does not inspect Yjs state when no timing observer is configured', () => {
    const inaccessibleDoc = {
      getText: () => {
        throw new Error('timing fields must stay lazy');
      },
    } as unknown as Y.Doc;

    expect(documentStateVectorTimingFields(undefined, inaccessibleDoc)).toEqual({});
  });

  it('labels socket-origin Yjs updates with the socket binding attribution', async () => {
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    const filePath = join(kb1Home, 'demo-vault', 'socket-attribution.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await session.open();
    const sender = new FakeSocket();
    const receiver = new FakeSocket();
    const senderBinding = await bindYjsWebSocket(session, sender);
    const receiverBinding = await bindYjsWebSocket(session, receiver);
    sender.sent.length = 0;
    receiver.sent.length = 0;

    const clientDoc = new Y.Doc();
    clientDoc.getText('markdown').insert(0, 'socket edit\n');
    sender.emitMessage(encodeAckedSyncUpdate({
      ackId: 'socket-edit',
      update: Y.encodeStateAsUpdate(clientDoc)
    }));

    await waitUntil(
      () => Boolean(findAttributedSyncUpdate(receiver.sent)),
      () => `Timed out waiting for socket attribution; receiver=${describeMessages(receiver.sent)}`
    );
    expect(findAttributedSyncUpdate(receiver.sent)?.attribution).toEqual(LOCAL_USER_DOCUMENT_UPDATE_ATTRIBUTION);
    expect(findAttributedSyncUpdate(sender.sent)).toBeUndefined();

    sender.emitClose();
    receiver.emitClose();
    await senderBinding.closed;
    await receiverBinding.closed;
    await session.close();
    clientDoc.destroy();
  });

  it('defers tagged client update acknowledgement until failed persistence recovers', async () => {
    const vaultDir = join(kb1Home, 'demo-vault');
    await mkdir(vaultDir, { recursive: true });
    const filePath = join(vaultDir, 'readonly.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: '' });
    await session.open();
    const socket = new FakeSocket();
    const binding = await bindYjsWebSocket(session, socket);
    const clientDoc = new Y.Doc();
    clientDoc.getText('markdown').insert(0, 'unsaved browser edit\n');

    try {
      await chmod(vaultDir, 0o500);
      socket.emitMessage(encodeAckedSyncUpdate({
        ackId: 'update-fails',
        update: Y.encodeStateAsUpdate(clientDoc)
      }));

      await waitUntil(
        () => socket.sent.some((message) => sessionEventKind(message) === 'persist-failure'),
        () => `Timed out waiting for persist-failure; sent=${describeMessages(socket.sent)}`
      );

      expect(findSyncUpdateAck(socket.sent, 'update-fails')).toBeUndefined();

      await chmod(vaultDir, 0o700);
      await session.flush();
      await waitUntil(
        () => Boolean(findSyncUpdateAck(socket.sent, 'update-fails')),
        () => `Timed out waiting for recovered update ack; sent=${describeMessages(socket.sent)}`
      );
    } finally {
      await chmod(vaultDir, 0o700).catch(() => undefined);
      socket.emitClose();
      await binding.closed;
      await session.close();
      clientDoc.destroy();
    }
  });

  it('buffers the initial client sync request while a cold session opens', async () => {
    const vaultDir = join(kb1Home, 'demo-vault');
    const filePath = join(vaultDir, 'hello-world.md');
    await mkdir(vaultDir, { recursive: true });
    await writeFile(filePath, 'cold file content\n', 'utf8');
    const session = new OneFileDocumentSession(filePath);
    const originalOpen = session.open.bind(session);
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    session.open = async () => {
      await openGate;
      await originalOpen();
    };

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
    const client = await connectYjsClient(`ws://127.0.0.1:${port}${DEMO_DOCUMENT_YJS_PATH}`);
    releaseOpen();

    await waitForSharedContent([client], (content) => content === 'cold file content\n');

    client.close();
    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
    await session.close();
  });

  it('does not install document listeners when the socket closes during session open', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'closed-during-open.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: 'durable\n' });
    const originalOpen = session.open.bind(session);
    let releaseOpen: (() => void) | undefined;
    const openReleased = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    session.open = async (options) => {
      await openReleased;
      await originalOpen(options);
    };
    const onEvent = vi.spyOn(session, 'onEvent');
    const socket = new FakeSocket();

    const bindingPromise = bindYjsWebSocket(session, socket);
    socket.readyState = WebSocket.CLOSED;
    socket.emitClose();
    releaseOpen?.();

    const binding = await bindingPromise;
    await binding.closed;
    expect(onEvent).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
    onEvent.mockRestore();
    await session.close();
  });

  it('settles socket cleanup when the latest document persist is already failed', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'cleanup-persist-failed.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: 'durable\n' });
    await session.open();
    const socket = new FakeSocket();
    const binding = await bindYjsWebSocket(session, socket);
    const originalFlush = session.flush.bind(session);
    session.flush = vi.fn(async () => {
      throw new PersistFailedError(filePath, new Error('persist unavailable'));
    });

    socket.emitClose();
    await expect(binding.closed).resolves.toBeUndefined();

    session.flush = originalFlush;
    await session.close();
  });

  it('rejects socket cleanup when an unexpected flush failure occurs', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'cleanup-unexpected-failure.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: 'durable\n' });
    await session.open();
    const socket = new FakeSocket();
    const binding = await bindYjsWebSocket(session, socket);
    const originalFlush = session.flush.bind(session);
    const cleanupFailure = new Error('unexpected cleanup failure');
    session.flush = vi.fn(async () => {
      throw cleanupFailure;
    });

    socket.emitClose();
    await expect(binding.closed).rejects.toBe(cleanupFailure);

    session.flush = originalFlush;
    await session.close();
  });

  it('ignores unsupported non-binary socket frames', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'unsupported-frame.md');
    const session = new OneFileDocumentSession(filePath, { defaultContent: 'durable\n' });
    await session.open();
    const socket = new FakeSocket();
    const binding = await bindYjsWebSocket(session, socket);
    const sentBeforeUnsupportedFrame = socket.sent.length;

    socket.emitMessage({ unsupported: true });

    expect(socket.sent).toHaveLength(sentBeforeUnsupportedFrame);
    expect(socket.closed).toEqual([]);
    socket.emitClose();
    await binding.closed;
    await session.close();
  });

  it('persists the first edit from a freshly synced client after loading durable content', async () => {
    const vaultDir = join(kb1Home, 'demo-vault');
    const filePath = join(vaultDir, 'hello-world.md');
    await mkdir(vaultDir, { recursive: true });
    await writeFile(filePath, 'from disk\n', 'utf8');
    const session = new OneFileDocumentSession(filePath);

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
    const client = await connectYjsClient(`ws://127.0.0.1:${port}${DEMO_DOCUMENT_YJS_PATH}`);
    await waitForSharedContent([client], (content) => content === 'from disk\n');

    client.text.insert(client.text.length, 'fresh edit\n');
    await waitForDiskContent(filePath, (content) => content === 'from disk\nfresh edit\n');

    client.close();
    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
    await session.close();
  });

  it('protects a previously empty existing file after its first durable edit', async () => {
    const vaultDir = join(kb1Home, 'demo-vault');
    const filePath = join(vaultDir, 'empty-first.md');
    await mkdir(vaultDir, { recursive: true });
    await writeFile(filePath, '', 'utf8');
    const session = new OneFileDocumentSession(filePath);

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
    const client = await connectYjsClient(`ws://127.0.0.1:${port}${DEMO_DOCUMENT_YJS_PATH}`);
    client.text.insert(0, 'first durable edit\n');
    await waitForDiskContent(filePath, (content) => content === 'first durable edit\n');
    // Seeing the markdown bytes is not the full durability boundary: the
    // session records its non-empty guard after the paired Yjs snapshot is
    // written. Wait for that same persistence cycle before injecting the
    // independent stale update this test expects the guard to reject.
    await session.flush();

    const staleSocket = new FakeSocket();
    const staleBinding = await bindYjsWebSocket(session, staleSocket);
    const stalePeer = new Y.Doc();
    stalePeer.getText('markdown').insert(0, 'first durable edit\nindependent stale text\n');

    staleSocket.emitMessage(encodeSyncMessage((encoder) => {
      encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep2);
      encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(stalePeer));
    }));
    await session.flush();
    await waitUntil(
      () => staleSocket.closed.length > 0,
      () => 'Timed out waiting for the divergent stale socket to close',
      10_000,
    );

    expect(staleSocket.closed).toEqual([{
      code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
      reason: JSON.stringify(DOCUMENT_SESSION_UNSAFE_DIVERGENCE_FAILURE)
    }]);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('first durable edit\n');
    expect(session.ydoc.getText('markdown').toString()).toBe('first durable edit\n');

    staleSocket.emitClose();
    await staleBinding.closed;
    client.close();
    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
    await session.close();
    stalePeer.destroy();
  }, 15_000);

  it('serves durable content after a daemon restart from filesystem truth', async () => {
    const vaultDir = join(kb1Home, 'demo-vault');
    const filePath = join(vaultDir, 'hello-world.md');
    await mkdir(vaultDir, { recursive: true });
    await writeFile(filePath, 'restart truth\n', 'utf8');

    const firstSession = new OneFileDocumentSession(filePath);
    await firstSession.open();
    await firstSession.close();

    const secondSession = new OneFileDocumentSession(filePath);
    const server = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== DEMO_DOCUMENT_YJS_PATH) {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        void bindYjsWebSocket(secondSession, webSocket);
      });
    });
    await listen(server);

    const port = (server.address() as AddressInfo).port;
    const client = await connectYjsClient(`ws://127.0.0.1:${port}${DEMO_DOCUMENT_YJS_PATH}`);
    await waitForSharedContent([client], (content) => content === 'restart truth\n');

    client.close();
    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
    await secondSession.close();
  });

  it('fails missing document binds with canonical not_found and does not create parent folders', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'typo', 'missing.md');
    const session = new OneFileDocumentSession(filePath);
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
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    await expect(closed).resolves.toEqual({
      code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
      reason: JSON.stringify({ ok: false, error: 'not_found', message: 'file not found' })
    });
    await expect(readdir(kb1Home)).resolves.toEqual([]);

    await closeWebSocketServer(webSocketServer);
    await closeServer(server);
  });

  it('rejects stale independent peer updates without amplifying durable bytes', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    await writeFile(filePath, 'stable bytes\n', 'utf8');
    const session = new OneFileDocumentSession(filePath);
    const socket = new FakeSocket();

    const binding = await bindYjsWebSocket(session, socket);
    const stalePeer = new Y.Doc();
    stalePeer.getText('markdown').insert(0, 'stable bytes\n');

    socket.emitMessage(encodeSyncMessage((encoder) => {
      encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep2);
      encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(stalePeer));
    }));
    await session.flush();

    expect(socket.closed).toEqual([{
      code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
      reason: JSON.stringify(DOCUMENT_SESSION_UNSAFE_DIVERGENCE_FAILURE)
    }]);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('stable bytes\n');
    expect(session.ydoc.getText('markdown').toString()).toBe('stable bytes\n');

    socket.emitClose();
    await binding.closed;
    await session.close();
    stalePeer.destroy();
  });

  it('rejects divergent stale peer updates that would append duplicate durable prefixes', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    await writeFile(filePath, 'abc\n', 'utf8');
    const session = new OneFileDocumentSession(filePath);
    const socket = new FakeSocket();

    const binding = await bindYjsWebSocket(session, socket);
    const stalePeer = new Y.Doc();
    stalePeer.getText('markdown').insert(0, 'abc\nplus');

    socket.emitMessage(encodeSyncMessage((encoder) => {
      encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep2);
      encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(stalePeer));
    }));
    await session.flush();

    expect(socket.closed).toEqual([{
      code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
      reason: JSON.stringify(DOCUMENT_SESSION_UNSAFE_DIVERGENCE_FAILURE)
    }]);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('abc\n');
    expect(session.ydoc.getText('markdown').toString()).toBe('abc\n');

    socket.emitClose();
    await binding.closed;
    await session.close();
    stalePeer.destroy();
  });

  it('rejects short stale peer updates after a non-empty durable seed', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'short.md');
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    await writeFile(filePath, 'x', 'utf8');
    const session = new OneFileDocumentSession(filePath);
    const socket = new FakeSocket();

    const binding = await bindYjsWebSocket(session, socket);
    const stalePeer = new Y.Doc();
    stalePeer.getText('markdown').insert(0, 'xy');

    socket.emitMessage(encodeSyncMessage((encoder) => {
      encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep2);
      encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(stalePeer));
    }));
    await session.flush();

    expect(socket.closed).toEqual([{
      code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
      reason: JSON.stringify(DOCUMENT_SESSION_UNSAFE_DIVERGENCE_FAILURE)
    }]);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('x');
    expect(session.ydoc.getText('markdown').toString()).toBe('x');

    socket.emitClose();
    await binding.closed;
    await session.close();
    stalePeer.destroy();
  });

  it('rejects the stale browser-provider response generated from the daemon sync handshake', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    await writeFile(filePath, 'stable provider bytes\n', 'utf8');
    const session = new OneFileDocumentSession(filePath);
    const socket = new FakeSocket();

    const binding = await bindYjsWebSocket(session, socket);
    const staleBrowserDoc = new Y.Doc();
    const staleBrowserText = staleBrowserDoc.getText('markdown');
    staleBrowserText.insert(0, 'stable provider bytes\n');
    const response = receiveSyncMessage(staleBrowserDoc, socket.sent[0]);

    expect(response).toBeDefined();
    socket.emitMessage(response);
    await session.flush();

    expect(socket.closed).toEqual([{
      code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
      reason: JSON.stringify(DOCUMENT_SESSION_UNSAFE_DIVERGENCE_FAILURE)
    }]);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('stable provider bytes\n');
    expect(session.ydoc.getText('markdown').toString()).toBe('stable provider bytes\n');

    socket.emitClose();
    await binding.closed;
    await session.close();
    staleBrowserDoc.destroy();
  });

  it('accepts a warm browser-provider response after daemon restart when Yjs state was restored', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
    const stateFilePath = join(kb1Home, '.kb1', 'doc-session-state', 'hello-world.json');
    const firstSession = new OneFileDocumentSession(filePath, {
      defaultContent: 'stable provider bytes\n',
      stateFilePath
    });
    await firstSession.open();

    const browserDoc = new Y.Doc();
    Y.applyUpdate(browserDoc, Y.encodeStateAsUpdate(firstSession.ydoc));
    await firstSession.close();

    const restartedSession = new OneFileDocumentSession(filePath, { stateFilePath });
    const socket = new FakeSocket();
    const binding = await bindYjsWebSocket(restartedSession, socket);
    const response = receiveSyncMessage(browserDoc, socket.sent[0]);

    if (response) socket.emitMessage(response);
    await restartedSession.flush();

    expect(socket.closed).toEqual([]);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('stable provider bytes\n');
    expect(restartedSession.ydoc.getText('markdown').toString()).toBe('stable provider bytes\n');

    socket.emitClose();
    await binding.closed;
    await restartedSession.close();
    browserDoc.destroy();
  });

  it('keeps durable bytes stable across repeated stale reconnect updates', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    await writeFile(filePath, 'stable bytes across reconnects\n', 'utf8');
    const stalePeer = new Y.Doc();
    stalePeer.getText('markdown').insert(0, 'stable bytes across reconnects\n');

    for (let cycle = 0; cycle < 12; cycle += 1) {
      const session = new OneFileDocumentSession(filePath);
      const socket = new FakeSocket();
      const binding = await bindYjsWebSocket(session, socket);

      socket.emitMessage(encodeSyncMessage((encoder) => {
        encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep2);
        encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(stalePeer));
      }));
      await session.flush();

      expect(socket.closed).toEqual([{
        code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
        reason: JSON.stringify(DOCUMENT_SESSION_UNSAFE_DIVERGENCE_FAILURE)
      }]);
      await expect(readFile(filePath, 'utf8')).resolves.toBe('stable bytes across reconnects\n');
      expect(session.ydoc.getText('markdown').toString()).toBe('stable bytes across reconnects\n');

      socket.emitClose();
      await binding.closed;
      await session.close();
    }

    stalePeer.destroy();
  });

  it('reconciles idle external file changes and broadcasts the quiet merge event to every client', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
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
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
    const vaultDir = join(kb1Home, 'demo-vault');
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
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
    const vaultDir = join(kb1Home, 'demo-vault');
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
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
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

  it('sends the terminal event and closes a socket bound to a deleted session', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'deleted.md');
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    await writeFile(filePath, 'retired content\n', 'utf8');
    const session = new OneFileDocumentSession(filePath, { eventPath: 'deleted.md' });
    const socket = new FakeSocket();
    const binding = await bindYjsWebSocket(session, socket);

    await session.deleteWith(() => rm(filePath));

    expect(socket.sent.map(sessionEventKind)).toContain('doc-deleted');
    expect(socket.closed).toEqual([
      {
        code: DOCUMENT_SESSION_FAILURE_CLOSE_CODE,
        reason: JSON.stringify(DOCUMENT_SESSION_NOT_FOUND_FAILURE),
      },
    ]);
    expect(() => session.ydoc).toThrow('file not found');

    socket.emitClose();
    await binding.closed;
    await session.close();
  });

  it('handles alternate message payload shapes and skips sends to closed sockets', async () => {
    const filePath = join(kb1Home, 'demo-vault', 'hello-world.md');
    await mkdir(join(kb1Home, 'demo-vault'), { recursive: true });
    await writeFile(filePath, 'socket shapes\n', 'utf8');
    const session = new OneFileDocumentSession(filePath);
    const socket = new FakeSocket();
    socket.readyState = WebSocket.CLOSED;

    const binding = await bindYjsWebSocket(session, socket);
    expect(socket.sent).toEqual([]);

    socket.emitMessage('not bytes');
    socket.emitMessage(new Uint8Array([99]).buffer);
    socket.emitMessage([Buffer.from([99])]);
    expect(socket.closed).toEqual([]);

    socket.emitClose();
    await binding.closed;
    await session.close();
  });

  it('propagates unexpected session open failures', async () => {
    const socket = new FakeSocket();
    const session = {
      ydoc: new Y.Doc(),
      open: async () => {
        throw new Error('unexpected open failure');
      },
      flush: async () => undefined,
      onEvent: () => () => undefined,
      getActivePersistFailureEvent: () => undefined
    } as unknown as OneFileDocumentSession;

    await expect(bindYjsWebSocket(session, socket)).rejects.toThrow('unexpected open failure');
  });
});

interface YjsClient {
  doc: Y.Doc;
  text: Y.Text;
  events: DocumentSessionEvent[];
  close: () => void;
}

class FakeSocket implements YjsWebSocketLike {
  readyState: number = WebSocket.OPEN;
  readonly sent: Uint8Array[] = [];
  readonly closed: Array<{ code: number | undefined; reason: string | undefined }> = [];
  private readonly listeners = {
    message: [] as Array<(data: unknown) => void>,
    close: [] as Array<() => void>,
    error: [] as Array<() => void>
  };

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
  }

  on(event: 'message' | 'close' | 'error', listener: ((data: unknown) => void) | (() => void)): this {
    this.listeners[event].push(listener as never);
    return this;
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.message) {
      listener(data);
    }
  }

  emitClose(): void {
    for (const listener of this.listeners.close) {
      listener();
    }
  }
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

function encodeSyncMessage(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function findSyncUpdateAck(messages: Uint8Array[], ackId: string) {
  for (const message of messages) {
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    if (messageType !== MESSAGE_SYNC_UPDATE_ACK) {
      continue;
    }
    const ack = decodeSyncUpdateAck(decoder);
    if (ack?.ackId === ackId) {
      return ack;
    }
  }
  return undefined;
}

function findAttributedSyncUpdate(messages: Uint8Array[]): AttributedSyncUpdate | undefined {
  for (const message of messages) {
    const decoder = decoding.createDecoder(message);
    if (decoding.readVarUint(decoder) !== MESSAGE_ATTRIBUTED_SYNC_UPDATE) {
      continue;
    }
    const update = decodeAttributedSyncUpdate(decoder);
    if (update) return update;
  }
  return undefined;
}

function sessionEventKind(message: Uint8Array): DocumentSessionEvent['kind'] | undefined {
  const decoder = decoding.createDecoder(message);
  const messageType = decoding.readVarUint(decoder);
  if (messageType !== MESSAGE_SESSION_EVENT) {
    return undefined;
  }
  return decodeSessionEvent(decoder)?.kind;
}

function describeMessages(messages: Uint8Array[]): string {
  return JSON.stringify(messages.map((message) => {
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC_UPDATE_ACK) {
      return { type: 'sync-update-ack', ack: decodeSyncUpdateAck(decoder) };
    }
    if (messageType === MESSAGE_SESSION_EVENT) {
      return { type: 'session-event', event: decodeSessionEvent(decoder) };
    }
    if (messageType === MESSAGE_ACKED_SYNC_UPDATE) {
      return { type: 'acked-sync-update' };
    }
    if (messageType === MESSAGE_ATTRIBUTED_SYNC_UPDATE) {
      return { type: 'attributed-sync-update', update: decodeAttributedSyncUpdate(decoder) };
    }
    if (messageType === MESSAGE_SYNC) {
      return { type: 'sync' };
    }
    return { type: messageType };
  }));
}

function messageType(message: Uint8Array): number {
  const decoder = decoding.createDecoder(message);
  return decoding.readVarUint(decoder);
}

function findInitialStateVector(messages: Uint8Array[]): Uint8Array | undefined {
  for (const message of messages) {
    const decoder = decoding.createDecoder(message);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
    if (decoding.readVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) continue;
    return decoding.readVarUint8Array(decoder);
  }
  return undefined;
}

function receiveSyncMessage(doc: Y.Doc, message: Uint8Array): Uint8Array | undefined {
  const decoder = decoding.createDecoder(message);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  if (messageType !== MESSAGE_SYNC) {
    return undefined;
  }

  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.readSyncMessage(decoder, encoder, doc, 'daemon');
  if (encoding.length(encoder) <= 1) {
    return undefined;
  }
  return encoding.toUint8Array(encoder);
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
  await waitUntil(async () => {
    try {
      return predicate(await readFile(filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }, () => `Timed out waiting for disk content at ${filePath}`);
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  errorMessage: () => string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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
