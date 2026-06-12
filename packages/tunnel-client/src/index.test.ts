import { EventEmitter } from 'node:events';
import {
  TUNNEL_CLOSE_CODES,
  TUNNEL_PENDING_STREAM_FRAME_LIMIT,
  TUNNEL_WS_FRAME_BYTE_LIMIT,
} from '@kb-2/tunnel-protocol';
import {
  ChunkedHttpRequestAssembler,
  DialbackBridge,
  createBackoffDelay,
  relayInternalUrl,
  sendableCloseCode,
  type BridgeSocket,
} from './index.js';

class FakeSocket extends EventEmitter implements BridgeSocket {
  readyState = 0;
  readonly sent: Array<{ data: unknown; options?: { binary?: boolean } }> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(data: unknown, options?: { binary?: boolean }): void {
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

  it('drops daemon frames while the relay socket is not open', () => {
    const relaySocket = new FakeSocket();
    const daemonSocket = new FakeSocket();
    new DialbackBridge({ streamId: 'stream-1', relaySocket, daemonSocket }).start();

    daemonSocket.open();
    daemonSocket.message(Buffer.from([4]), true);

    expect(relaySocket.sent).toEqual([]);
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
