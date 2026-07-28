import { EventEmitter } from 'node:events';
import { TUNNEL_FEATURES, encodeTunnelMessage } from '@kb-1/tunnel-protocol';

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly instances: MockWebSocket[] = [];

  readyState = 0;
  readonly sent: unknown[] = [];
  terminated = false;

  constructor(readonly url: URL) {
    super();
    MockWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close', 1006, Buffer.from(''));
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open');
  }

  message(data: string): void {
    this.emit('message', Buffer.from(data));
  }
}

function sentText(socket: MockWebSocket, index: number): string {
  const data = socket.sent[index];
  return Buffer.isBuffer(data) ? data.toString() : String(data);
}

vi.mock('ws', () => ({ WebSocket: MockWebSocket }));

describe('TunnelClient control heartbeat', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('terminates a missed-pong control socket to trip the existing reconnect path', async () => {
    const {
      CONTROL_DURABLE_LIVENESS_INTERVAL_MS,
      CONTROL_HEARTBEAT_INTERVAL_MS,
      CONTROL_HEARTBEAT_TIMEOUT_MS,
      TunnelClient,
    } = await import('./index.js');
    const logger = { log: vi.fn() };
    const client = new TunnelClient({
      relayUrl: new URL('http://relay.example/t/dev1'),
      daemonUrl: new URL('http://127.0.0.1:9891'),
      token: 'token-1',
      logger,
      random: () => 0,
    });

    client.start();
    const firstControl = MockWebSocket.instances[0];
    firstControl.open();

    expect(sentText(firstControl, 0)).toBe(encodeTunnelMessage({
      type: 'control.hello',
      version: 2,
      token: 'token-1',
      features: [TUNNEL_FEATURES.RELAY_FRAMES_V1],
    }));

    await vi.advanceTimersByTimeAsync(CONTROL_HEARTBEAT_INTERVAL_MS);
    expect(sentText(firstControl, 1)).toBe(encodeTunnelMessage({ type: 'control.ping' }));
    expect(typeof firstControl.sent[1]).toBe('string');
    expect(firstControl.sent).toHaveLength(2);

    firstControl.message(encodeTunnelMessage({ type: 'control.pong' }));
    await vi.advanceTimersByTimeAsync(CONTROL_HEARTBEAT_TIMEOUT_MS);
    expect(firstControl.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(CONTROL_HEARTBEAT_INTERVAL_MS);
    expect(CONTROL_DURABLE_LIVENESS_INTERVAL_MS).toBe(2 * CONTROL_HEARTBEAT_INTERVAL_MS);
    expect(sentText(firstControl, 2)).toBe(encodeTunnelMessage({ type: 'control.ping' }));
    expect(typeof firstControl.sent[2]).toBe('string');
    expect(Buffer.isBuffer(firstControl.sent[3])).toBe(true);
    expect(sentText(firstControl, 3)).toBe(encodeTunnelMessage({ type: 'control.ping' }));

    await vi.advanceTimersByTimeAsync(CONTROL_HEARTBEAT_TIMEOUT_MS);
    expect(firstControl.terminated).toBe(true);
    expect(logger.log).toHaveBeenCalledWith('warn', 'relay control heartbeat missed; terminating socket to reconnect');

    await vi.advanceTimersByTimeAsync(250);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('advertises optional daemon version metadata on control hello', async () => {
    const { TunnelClient } = await import('./index.js');
    const client = new TunnelClient({
      relayUrl: new URL('http://relay.example/t/dev1'),
      daemonUrl: new URL('http://127.0.0.1:9891'),
      token: 'token-1',
      daemonVersion: '0.1.0',
      daemonBuild: 'registry.fly.io/kb1@sha256:abc123',
      logger: { log: vi.fn() },
    });

    client.start();
    const firstControl = MockWebSocket.instances[0];
    firstControl.open();

    expect(sentText(firstControl, 0)).toBe(encodeTunnelMessage({
      type: 'control.hello',
      version: 2,
      token: 'token-1',
      daemonVersion: '0.1.0',
      daemonBuild: 'registry.fly.io/kb1@sha256:abc123',
      features: [TUNNEL_FEATURES.RELAY_FRAMES_V1],
    }));
  });

  it('keeps connect and disconnect idempotent for lifecycle callers', async () => {
    const { TunnelClient } = await import('./index.js');
    const client = new TunnelClient({
      relayUrl: new URL('http://relay.example/t/dev1'),
      daemonUrl: new URL('http://127.0.0.1:9891'),
      token: 'token-1',
      logger: { log: vi.fn() },
    });

    expect(client.status()).toEqual({
      started: false,
      controlConnected: false,
      reconnectScheduled: false,
    });

    client.start();
    client.start();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(client.status()).toEqual({
      started: true,
      controlConnected: false,
      reconnectScheduled: false,
    });

    MockWebSocket.instances[0].open();
    expect(client.status()).toEqual({
      started: true,
      controlConnected: true,
      reconnectScheduled: false,
    });

    client.stop();
    client.stop();
    expect(client.status()).toEqual({
      started: false,
      controlConnected: false,
      reconnectScheduled: false,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
