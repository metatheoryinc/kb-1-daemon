import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import {
  RELAY_ERROR_CODES,
  RELAY_TRANSPORT_PROTOCOL_VERSION,
  TUNNEL_CLOSE_CODES,
  TUNNEL_PENDING_STREAM_FRAME_LIMIT,
  TUNNEL_WS_FRAME_BYTE_LIMIT,
  encodeTunnelMessage,
} from '@kb-2/tunnel-protocol';
import {
  ChunkedHttpRequestAssembler,
  DialbackBridge,
  TunnelClient,
  createBackoffDelay,
  materializedResponseBody,
  relayInternalUrl,
  serializableResponseHeaders,
  sendableCloseCode,
  withoutHopByHop,
  type BridgeSocket,
} from './index.js';

class FakeSocket extends EventEmitter implements BridgeSocket {
  readyState = 0;
  readonly sent: Array<{ data: unknown; options?: { binary?: boolean } }> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  sendError: Error | undefined;

  send(data: unknown, options?: { binary?: boolean }): void {
    if (this.sendError) throw this.sendError;
    this.sent.push({ data, options });
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(data: Buffer, isBinary = true): void {
    this.emit('message', data, isBinary);
  }
}

describe('tunnel-client helpers', () => {
  it('computes exponential backoff with deterministic jitter and cap', () => {
    expect(createBackoffDelay(0, { baseMs: 100, maxMs: 1_000, jitterRatio: 0.5 }, () => 0)).toBe(100);
    expect(createBackoffDelay(2, { baseMs: 100, maxMs: 1_000, jitterRatio: 0.5 }, () => 1)).toBe(600);
    expect(createBackoffDelay(10, { baseMs: 100, maxMs: 1_000, jitterRatio: 0.5 }, () => 1)).toBe(1_000);
    expect(createBackoffDelay(-1, {}, () => 0)).toBe(250);
  });

  it('sanitizes non-sendable close codes', () => {
    expect(sendableCloseCode(1000)).toBe(1000);
    expect(sendableCloseCode(TUNNEL_CLOSE_CODES.CONTROL_REPLACED)).toBe(TUNNEL_CLOSE_CODES.CONTROL_REPLACED);
    expect(sendableCloseCode(1005)).toBe(1011);
    expect(sendableCloseCode(1006)).toBe(1011);
    expect(sendableCloseCode(999)).toBe(1011);
    expect(sendableCloseCode(5000)).toBe(1011);
  });

  it('preserves the stable tunnel path when building internal relay URLs', () => {
    expect(relayInternalUrl(new URL('https://relay.example/t/dev1?token=nope'), '/__kb2_tunnel/control').href).toBe(
      'wss://relay.example/t/dev1/__kb2_tunnel/control',
    );
    expect(relayInternalUrl(new URL('http://127.0.0.1:9920/t/dev1/'), '/__kb2_tunnel/dialback').href).toBe(
      'ws://127.0.0.1:9920/t/dev1/__kb2_tunnel/dialback',
    );
    expect(relayInternalUrl(new URL('http://127.0.0.1:9920/t/dev1'), '__kb2_tunnel/control').href).toBe(
      'ws://127.0.0.1:9920/t/dev1/__kb2_tunnel/control',
    );
  });

  it('strips hop-by-hop headers before proxying to daemon endpoints', () => {
    expect(withoutHopByHop({
      'accept-encoding': 'gzip, deflate',
      connection: 'keep-alive',
      Expect: '100-continue',
      host: 'relay.example',
      'x-request-id': 'req-1',
    })).toEqual({
      'accept-encoding': 'identity',
      'x-request-id': 'req-1',
    });
  });

  it('strips response transform headers after fetch materializes body bytes', () => {
    expect(serializableResponseHeaders(new Headers({
      'content-encoding': 'gzip',
      'content-type': 'application/json',
      'x-request-id': 'req-1',
    }))).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'req-1',
    });
  });

  it('normalizes gzipped materialized response bodies before serializing them over the tunnel', async () => {
    const body = await materializedResponseBody(new Response(gzipSync(Buffer.from('{"ok":true}')), {
      headers: { 'content-encoding': 'gzip' },
    }));

    expect(body.toString('utf8')).toBe('{"ok":true}');
  });
});

describe('ChunkedHttpRequestAssembler', () => {
  it('assembles chunked HTTP request bodies in sequence order', () => {
    const assembler = new ChunkedHttpRequestAssembler();
    assembler.start({
      type: 'http.request.start',
      id: 'req-1',
      method: 'POST',
      path: '/upload',
      headers: { 'content-type': 'application/octet-stream' },
      totalBytes: 5,
    });
    assembler.chunk({ type: 'http.request.chunk', id: 'req-1', sequence: 1, bodyB64: Buffer.from([3, 4]).toString('base64') });
    assembler.chunk({ type: 'http.request.chunk', id: 'req-1', sequence: 0, bodyB64: Buffer.from([1, 2, 3]).toString('base64') });

    expect(assembler.end({ type: 'http.request.end', id: 'req-1', chunks: 2 })).toEqual({
      type: 'http.request',
      id: 'req-1',
      method: 'POST',
      path: '/upload',
      headers: { 'content-type': 'application/octet-stream' },
      bodyB64: Buffer.from([1, 2, 3, 3, 4]).toString('base64'),
    });
  });

  it('drops incomplete or oversized chunked HTTP requests', () => {
    const assembler = new ChunkedHttpRequestAssembler();
    assembler.start({
      type: 'http.request.start',
      id: 'req-1',
      method: 'POST',
      path: '/upload',
      headers: {},
      totalBytes: 1,
    });
    assembler.chunk({ type: 'http.request.chunk', id: 'req-1', sequence: 0, bodyB64: Buffer.from([1, 2]).toString('base64') });
    expect(assembler.end({ type: 'http.request.end', id: 'req-1', chunks: 1 })).toBeUndefined();

    assembler.start({
      type: 'http.request.start',
      id: 'req-2',
      method: 'POST',
      path: '/upload',
      headers: {},
      totalBytes: 2,
    });
    assembler.chunk({ type: 'http.request.chunk', id: 'req-2', sequence: 0, bodyB64: Buffer.from([1]).toString('base64') });
    expect(assembler.end({ type: 'http.request.end', id: 'req-2', chunks: 2 })).toBeUndefined();
  });
});

describe('TunnelClient typed relay RPC', () => {
  it('sends daemon-origin relay event frames over the control socket', () => {
    const control = new FakeSocket();
    control.open();
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
    });
    (client as unknown as { control: FakeSocket }).control = control;

    expect(client.sendRelayEvent({
      topic: 'vault.tree.changed',
      resource: { vaultSlug: 'demo-vault' },
    })).toBe(true);

    expect(control.sent).toHaveLength(1);
    expect(JSON.parse(Buffer.from(control.sent[0].data as Uint8Array).toString('utf8'))).toEqual({
      type: 'relay.frame',
      frame: {
        type: 'event',
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        topic: 'vault.tree.changed',
        resource: { vaultSlug: 'demo-vault' },
      },
    });
  });

  it('handles the vault.list capability through the daemon vault API', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://daemon.test/api/vaults');
      expect(init?.method).toBe('GET');
      return Response.json({ ok: true, vaults: [{ id: 'ledger', displayName: 'Ledger' }] });
    });
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
      fetch: fetchImpl as typeof fetch,
    });

    const response = await (
      client as unknown as {
        handleRelayRpcRequest(request: {
          type: 'rpc.request';
          version: typeof RELAY_TRANSPORT_PROTOCOL_VERSION;
          id: string;
          capability: string;
        }): Promise<unknown>;
      }
    ).handleRelayRpcRequest({
      type: 'rpc.request',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-1',
      capability: 'vault.list',
    });

    expect(response).toEqual({
      type: 'rpc.response',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-1',
      ok: true,
      payload: {
        encoding: 'json',
        value: { ok: true, vaults: [{ id: 'ledger', displayName: 'Ledger' }] },
      },
    });
  });

  it('rejects unknown typed relay RPC capabilities without proxying arbitrary paths', async () => {
    const fetchImpl = vi.fn();
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
      fetch: fetchImpl as typeof fetch,
    });

    const response = await (
      client as unknown as {
        handleRelayRpcRequest(request: {
          type: 'rpc.request';
          version: typeof RELAY_TRANSPORT_PROTOCOL_VERSION;
          id: string;
          capability: string;
        }): Promise<unknown>;
      }
    ).handleRelayRpcRequest({
      type: 'rpc.request',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-2',
      capability: 'admin.disconnect',
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      type: 'rpc.response',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-2',
      ok: false,
      error: { code: RELAY_ERROR_CODES.UNKNOWN_CAPABILITY },
    });
  });
});

describe('TunnelClient HTTP proxy cancellation', () => {
  it('aborts an in-flight daemon HTTP fetch when the relay sends http.cancel', async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal | undefined;
      await new Promise((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return new Response('late');
    });
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
      fetch: fetchImpl as typeof fetch,
    });
    const control = new FakeSocket();
    const handleControlMessage = (
      client as unknown as {
        handleControlMessage(control: unknown, data: Buffer): Promise<void>;
      }
    ).handleControlMessage.bind(client);

    const request = handleControlMessage(
      control,
      Buffer.from(encodeTunnelMessage({
        type: 'http.request',
        id: 'req-1',
        method: 'POST',
        path: '/api/vaults/ledger/tree',
        headers: {},
        bodyB64: null,
      })),
    );
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    await handleControlMessage(
      control,
      Buffer.from(encodeTunnelMessage({
        type: 'http.cancel',
        id: 'req-1',
        reason: 'browser timeout',
      })),
    );

    await request;
    expect(observedSignal?.aborted).toBe(true);
    expect(control.sent).toEqual([]);
  });
});

describe('DialbackBridge', () => {
  it('buffers relay frames until the daemon websocket opens, then flushes in order', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket }).start();

    relaySocket.open();
    relaySocket.message(Buffer.from([1, 2]));
    relaySocket.message(Buffer.from([3]));
    expect(daemonSocket.sent).toEqual([]);

    daemonSocket.open();

    expect(daemonSocket.sent).toEqual([
      { data: Buffer.from([1, 2]), options: { binary: true } },
      { data: Buffer.from([3]), options: { binary: true } },
    ]);
  });

  it('closes both sockets when flushing pending relay frames to the daemon fails', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    const logger = { log: vi.fn() };
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket, logger }).start();

    relaySocket.open();
    relaySocket.message(Buffer.from([1, 2]));
    daemonSocket.sendError = new Error('daemon send failed');
    daemonSocket.open();

    expect(relaySocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Daemon websocket send failed; reconnect required',
    });
    expect(daemonSocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Daemon websocket send failed; reconnect required',
    });
    expect(logger.log).toHaveBeenCalledWith('warn', 'daemon websocket send failed', {
      streamId: 'stream-1',
      error: 'Error: daemon send failed',
    });
  });

  it('closes both sockets when the dial-back pending frame cap overflows', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    const logger = { log: vi.fn() };
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket, logger }).start();

    relaySocket.open();
    for (let index = 0; index < TUNNEL_PENDING_STREAM_FRAME_LIMIT; index++) {
      relaySocket.message(Buffer.from([index]));
    }
    relaySocket.message(Buffer.from([255]));

    expect(relaySocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.PENDING_STREAM_OVERFLOW,
      reason: 'Pending dial-back buffer exceeded frames cap',
    });
    expect(daemonSocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.PENDING_STREAM_OVERFLOW,
      reason: 'Pending dial-back buffer exceeded frames cap',
    });
    expect(logger.log).toHaveBeenCalledWith('warn', 'dial-back pending buffer overflow', {
      streamId: 'stream-1',
      reason: 'frames',
      queuedFrames: TUNNEL_PENDING_STREAM_FRAME_LIMIT,
      queuedBytes: TUNNEL_PENDING_STREAM_FRAME_LIMIT,
    });
  });

  it('closes both sockets when the daemon websocket never opens', () => {
    vi.useFakeTimers();
    try {
      const relaySocket = new FakeSocket();
      const daemonSocket = new FakeSocket();
      new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket }).start();

      vi.runOnlyPendingTimers();

      expect(relaySocket.closes[0]).toEqual({
        code: TUNNEL_CLOSE_CODES.PENDING_STREAM_TIMEOUT,
        reason: 'Timed out waiting for daemon websocket',
      });
      expect(daemonSocket.closes[0]).toEqual({
        code: TUNNEL_CLOSE_CODES.PENDING_STREAM_TIMEOUT,
        reason: 'Timed out waiting for daemon websocket',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards relay frames immediately after daemon websocket opens', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket }).start();

    relaySocket.open();
    daemonSocket.open();
    relaySocket.message(Buffer.from([9]));

    expect(daemonSocket.sent).toEqual([{ data: Buffer.from([9]), options: { binary: true } }]);
  });

  it.each([2, 3])('closes both sockets when relay frames arrive while the daemon websocket state is %i', (readyState) => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    const logger = { log: vi.fn() };
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket, logger }).start();

    relaySocket.open();
    daemonSocket.readyState = readyState;
    relaySocket.message(Buffer.from([9]));

    expect(daemonSocket.sent).toEqual([]);
    expect(relaySocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Daemon websocket was not open for relay frame',
    });
    expect(daemonSocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Daemon websocket was not open for relay frame',
    });
    expect(logger.log).toHaveBeenCalledWith('warn', 'relay frame arrived while daemon websocket was not open', {
      streamId: 'stream-1',
      daemonReadyState: readyState,
    });
  });

  it('closes both sockets when sending relay frames to the daemon fails', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    const logger = { log: vi.fn() };
    daemonSocket.sendError = new Error('daemon send failed');
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket, logger }).start();

    relaySocket.open();
    daemonSocket.open();
    relaySocket.message(Buffer.from([9]));

    expect(relaySocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Daemon websocket send failed; reconnect required',
    });
    expect(daemonSocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Daemon websocket send failed; reconnect required',
    });
    expect(logger.log).toHaveBeenCalledWith('warn', 'daemon websocket send failed', {
      streamId: 'stream-1',
      error: 'Error: daemon send failed',
    });
  });

  it('closes both sockets when a relay websocket frame exceeds the tunnel cap', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket }).start();

    relaySocket.message(Buffer.alloc(TUNNEL_WS_FRAME_BYTE_LIMIT + 1));

    expect(relaySocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.OVERSIZED_WS_FRAME,
      reason: 'Relay websocket frame exceeded tunnel cap',
    });
    expect(daemonSocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.OVERSIZED_WS_FRAME,
      reason: 'Relay websocket frame exceeded tunnel cap',
    });
  });

  it('forwards daemon frames back to the relay socket', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket }).start();

    relaySocket.open();
    daemonSocket.open();
    daemonSocket.message(Buffer.from([4]), true);

    expect(relaySocket.sent).toEqual([{ data: Buffer.from([4]), options: { binary: true } }]);
  });

  it('buffers daemon frames until the relay dial-back opens, then flushes in order', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket }).start();

    daemonSocket.open();
    daemonSocket.message(Buffer.from([4]), true);
    daemonSocket.message(Buffer.from([5, 6]), true);
    expect(relaySocket.sent).toEqual([]);
    expect(relaySocket.closes).toEqual([]);
    expect(daemonSocket.closes).toEqual([]);

    relaySocket.open();

    expect(relaySocket.sent).toEqual([
      { data: Buffer.from([4]), options: { binary: true } },
      { data: Buffer.from([5, 6]), options: { binary: true } },
    ]);
  });

  it('closes both sockets when the daemon-to-relay pending frame cap overflows', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    const logger = { log: vi.fn() };
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket, logger }).start();

    daemonSocket.open();
    for (let index = 0; index < TUNNEL_PENDING_STREAM_FRAME_LIMIT; index++) {
      daemonSocket.message(Buffer.from([index]), true);
    }
    daemonSocket.message(Buffer.from([255]), true);

    expect(relaySocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.PENDING_STREAM_OVERFLOW,
      reason: 'Pending daemon-to-relay buffer exceeded frames cap',
    });
    expect(daemonSocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.PENDING_STREAM_OVERFLOW,
      reason: 'Pending daemon-to-relay buffer exceeded frames cap',
    });
    expect(logger.log).toHaveBeenCalledWith('warn', 'dial-back pending daemon buffer overflow', {
      streamId: 'stream-1',
      reason: 'frames',
      queuedFrames: TUNNEL_PENDING_STREAM_FRAME_LIMIT,
      queuedBytes: TUNNEL_PENDING_STREAM_FRAME_LIMIT,
    });
  });

  it('closes both sockets when a daemon websocket frame exceeds the tunnel cap', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    relaySocket.open();
    daemonSocket.open();
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket }).start();

    daemonSocket.message(Buffer.alloc(TUNNEL_WS_FRAME_BYTE_LIMIT + 1));

    expect(relaySocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.OVERSIZED_WS_FRAME,
      reason: 'Daemon websocket frame exceeded tunnel cap',
    });
    expect(daemonSocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.OVERSIZED_WS_FRAME,
      reason: 'Daemon websocket frame exceeded tunnel cap',
    });
  });

  it.each([2, 3])('closes both sockets when daemon frames arrive after the relay socket state is %i', (readyState) => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    const logger = { log: vi.fn() };
    const onRetrySafeClose = vi.fn();
    new DialbackBridge({
      streamId: 'stream-1',
      relaySocket,
      daemonSocket,
      logger,
      onRetrySafeClose,
    }).start();

    relaySocket.readyState = readyState;
    daemonSocket.open();
    daemonSocket.message(Buffer.from([4]), true);

    expect(relaySocket.sent).toEqual([]);
    expect(relaySocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Relay dial-back socket was not open for daemon frame',
    });
    expect(daemonSocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Relay dial-back socket was not open for daemon frame',
    });
    expect(logger.log).toHaveBeenCalledWith('warn', 'daemon frame arrived while relay dial-back was not open', {
      streamId: 'stream-1',
      relayReadyState: readyState,
    });
    expect(onRetrySafeClose).toHaveBeenCalledWith({
      type: 'ws.close',
      streamId: 'stream-1',
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Relay dial-back socket was not open for daemon frame',
    });
  });

  it('notifies relay control when daemon frames arrive after the relay socket is closed', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    const onRetrySafeClose = vi.fn();
    new DialbackBridge({
      streamId: 'stream-1',
      relaySocket,
      daemonSocket,
      onRetrySafeClose,
    }).start();

    relaySocket.readyState = 3;
    daemonSocket.open();
    daemonSocket.message(Buffer.from([4]), true);

    expect(relaySocket.sent).toEqual([]);
    expect(daemonSocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Relay dial-back socket was not open for daemon frame',
    });
    expect(onRetrySafeClose).toHaveBeenCalledWith({
      type: 'ws.close',
      streamId: 'stream-1',
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Relay dial-back socket was not open for daemon frame',
    });
  });

  it('closes both sockets when sending daemon frames to the relay fails', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    const logger = { log: vi.fn() };
    relaySocket.sendError = new Error('relay send failed');
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket, logger }).start();

    relaySocket.open();
    daemonSocket.open();
    daemonSocket.message(Buffer.from([4]), true);

    expect(relaySocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Relay dial-back send failed; reconnect required',
    });
    expect(daemonSocket.closes[0]).toEqual({
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: 'Relay dial-back send failed; reconnect required',
    });
    expect(logger.log).toHaveBeenCalledWith('warn', 'relay dial-back send failed', {
      streamId: 'stream-1',
      error: 'Error: relay send failed',
    });
  });

  it('accepts array-buffer, chunk-array, and string relay frames in the pending buffer', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket }).start();

    relaySocket.emit('message', new ArrayBuffer(2), true);
    relaySocket.emit('message', [Buffer.from([1]), Buffer.from([2])], true);
    relaySocket.emit('message', 'ok', false);
    daemonSocket.open();

    expect(daemonSocket.sent).toEqual([
      { data: Buffer.from([0, 0]), options: { binary: true } },
      { data: Buffer.from([1, 2]), options: { binary: true } },
      { data: Buffer.from('ok'), options: { binary: true } },
    ]);
  });

  it('propagates close codes between paired sockets with sendable sanitization', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    relaySocket.readyState = 1;
    daemonSocket.readyState = 1;
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket }).start();

    relaySocket.emit('close', 1006, Buffer.from('abnormal'));

    expect(daemonSocket.closes[0]).toEqual({ code: 1011, reason: 'abnormal' });
  });

  it('closes the daemon socket when the relay socket errors', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    const logger = { log: vi.fn() };
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket, logger }).start();

    relaySocket.emit('error', new Error('relay down'));

    expect(daemonSocket.closes[0]).toEqual({ code: 1011, reason: 'Relay dial-back failed' });
    expect(logger.log).toHaveBeenCalledWith('warn', 'relay dial-back socket error', {
      streamId: 'stream-1',
      error: 'Error: relay down',
    });
  });

  it('closes the relay socket when the daemon socket errors', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    const logger = { log: vi.fn() };
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket, logger }).start();

    daemonSocket.emit('error', new Error('daemon down'));

    expect(relaySocket.closes[0]).toEqual({ code: 1011, reason: 'Daemon websocket failed' });
    expect(logger.log).toHaveBeenCalledWith('warn', 'daemon websocket error', {
      streamId: 'stream-1',
      error: 'Error: daemon down',
    });
  });
});
