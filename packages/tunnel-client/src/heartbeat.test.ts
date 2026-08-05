import { EventEmitter } from 'node:events';
import { TUNNEL_FEATURES, encodeTunnelMessage } from '@kb-1/tunnel-protocol';

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly instances: MockWebSocket[] = [];

  readyState = 0;
  readonly sent: unknown[] = [];
  terminated = false;

  constructor(
    readonly url: URL,
    readonly options?: { headers?: Record<string, string> },
  ) {
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

  it('tolerates one missed pong, resets on recovery, and reconnects after consecutive misses', async () => {
    const {
      CONTROL_DURABLE_LIVENESS_INTERVAL_MS,
      CONTROL_HEARTBEAT_INTERVAL_MS,
      CONTROL_HEARTBEAT_MISSES_BEFORE_RECONNECT,
      CONTROL_HEARTBEAT_TIMEOUT_MS,
      TunnelClient,
    } = await import('./index.js');
    const logger = { log: vi.fn() };
    const client = new TunnelClient({
      relayUrl: new URL('http://relay.example/t/dev1'),
      daemonUrl: new URL('http://127.0.0.1:9891'),
      token: 'token-1',
      daemonInstanceId: 'instance-1',
      logger,
      random: () => 0,
    });

    client.start();
    const firstControl = MockWebSocket.instances[0];
    expect(firstControl.options?.headers).toEqual({
      authorization: 'Bearer token-1',
    });
    firstControl.open();

    expect(sentText(firstControl, 0)).toBe(encodeTunnelMessage({
      type: 'control.hello',
      version: 2,
      token: 'token-1',
      daemonInstanceId: 'instance-1',
      vaultMutationEpoch: 0,
      features: [
        TUNNEL_FEATURES.RELAY_FRAMES_V1,
        TUNNEL_FEATURES.VAULT_CONTENT_EVENTS_V1,
        TUNNEL_FEATURES.VAULT_CONTENT_EVENTS_V2,
        TUNNEL_FEATURES.MCP_TOOL_CALL_BOUNDED_RESULTS_V1,
        TUNNEL_FEATURES.HTTP_RESPONSE_CHUNK_ACKS_V1,
      ],
    }));

    await vi.advanceTimersByTimeAsync(CONTROL_HEARTBEAT_INTERVAL_MS);
    expect(sentText(firstControl, 1)).toBe(encodeTunnelMessage({ type: 'control.ping' }));
    expect(typeof firstControl.sent[1]).toBe('string');
    expect(firstControl.sent).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(CONTROL_HEARTBEAT_TIMEOUT_MS);
    expect(firstControl.terminated).toBe(false);
    expect(logger.log).toHaveBeenCalledWith(
      'warn',
      'relay control heartbeat missed; waiting for next probe',
      {
        consecutiveMisses: 1,
        reconnectAfterMisses: CONTROL_HEARTBEAT_MISSES_BEFORE_RECONNECT,
      },
    );

    await vi.advanceTimersByTimeAsync(
      CONTROL_HEARTBEAT_INTERVAL_MS - CONTROL_HEARTBEAT_TIMEOUT_MS,
    );
    expect(CONTROL_DURABLE_LIVENESS_INTERVAL_MS).toBe(2 * CONTROL_HEARTBEAT_INTERVAL_MS);
    expect(sentText(firstControl, 2)).toBe(encodeTunnelMessage({ type: 'control.ping' }));
    expect(typeof firstControl.sent[2]).toBe('string');
    expect(Buffer.isBuffer(firstControl.sent[3])).toBe(true);
    expect(sentText(firstControl, 3)).toBe(encodeTunnelMessage({ type: 'control.ping' }));

    firstControl.message(encodeTunnelMessage({ type: 'control.pong' }));
    await vi.advanceTimersByTimeAsync(CONTROL_HEARTBEAT_TIMEOUT_MS);
    expect(firstControl.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(
      CONTROL_HEARTBEAT_INTERVAL_MS - CONTROL_HEARTBEAT_TIMEOUT_MS,
    );
    expect(sentText(firstControl, 4)).toBe(encodeTunnelMessage({ type: 'control.ping' }));

    await vi.advanceTimersByTimeAsync(CONTROL_HEARTBEAT_TIMEOUT_MS);
    expect(firstControl.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(
      CONTROL_HEARTBEAT_INTERVAL_MS - CONTROL_HEARTBEAT_TIMEOUT_MS,
    );
    expect(sentText(firstControl, 5)).toBe(encodeTunnelMessage({ type: 'control.ping' }));
    expect(Buffer.isBuffer(firstControl.sent[6])).toBe(true);

    await vi.advanceTimersByTimeAsync(CONTROL_HEARTBEAT_TIMEOUT_MS);
    expect(firstControl.terminated).toBe(true);
    expect(logger.log).toHaveBeenCalledWith(
      'warn',
      'relay control heartbeat missed; terminating socket to reconnect',
      {
        consecutiveMisses: CONTROL_HEARTBEAT_MISSES_BEFORE_RECONNECT,
        reconnectAfterMisses: CONTROL_HEARTBEAT_MISSES_BEFORE_RECONNECT,
      },
    );

    await vi.advanceTimersByTimeAsync(250);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('logs the relay close reason before scheduling reconnect', async () => {
    const { TunnelClient } = await import('./index.js');
    const logger = { log: vi.fn() };
    const client = new TunnelClient({
      relayUrl: new URL('http://relay.example/t/dev1'),
      daemonUrl: new URL('http://127.0.0.1:9891'),
      token: 'token-1',
      logger,
      random: () => 0,
    });

    client.start();
    const control = MockWebSocket.instances[0];
    control.open();
    control.close(4005, 'Tunnel handshake timed out');

    expect(logger.log).toHaveBeenCalledWith(
      'warn',
      'relay control closed; reconnect scheduled',
      {
        code: 4005,
        reason: 'Tunnel handshake timed out',
        delayMs: 250,
      },
    );
  });

  it('advertises optional daemon version metadata on control hello', async () => {
    const { TunnelClient } = await import('./index.js');
    const client = new TunnelClient({
      relayUrl: new URL('http://relay.example/t/dev1'),
      daemonUrl: new URL('http://127.0.0.1:9891'),
      token: 'token-1',
      daemonVersion: '0.1.0',
      daemonBuild: 'registry.fly.io/kb1@sha256:abc123',
      daemonInstanceId: 'instance-1',
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
      daemonInstanceId: 'instance-1',
      vaultMutationEpoch: 0,
      features: [
        TUNNEL_FEATURES.RELAY_FRAMES_V1,
        TUNNEL_FEATURES.VAULT_CONTENT_EVENTS_V1,
        TUNNEL_FEATURES.VAULT_CONTENT_EVENTS_V2,
        TUNNEL_FEATURES.MCP_TOOL_CALL_BOUNDED_RESULTS_V1,
        TUNNEL_FEATURES.HTTP_RESPONSE_CHUNK_ACKS_V1,
      ],
    }));
  });

  it('carries vault mutations across a disconnected control as a new epoch', async () => {
    const { TunnelClient } = await import('./index.js');
    const client = new TunnelClient({
      relayUrl: new URL('http://relay.example/t/dev1'),
      daemonUrl: new URL('http://127.0.0.1:9891'),
      token: 'token-1',
      daemonInstanceId: 'instance-1',
      logger: { log: vi.fn() },
      random: () => 0,
    });

    client.start();
    const firstControl = MockWebSocket.instances[0];
    firstControl.open();
    firstControl.close(1006, 'network gap');

    expect(client.sendRelayEvent({
      topic: 'vault.tree.changed',
      resource: { vaultSlug: 'demo' },
    })).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    const secondControl = MockWebSocket.instances[1];
    secondControl.open();
    expect(JSON.parse(sentText(secondControl, 0))).toMatchObject({
      type: 'control.hello',
      daemonInstanceId: 'instance-1',
      vaultMutationEpoch: 1,
      features: expect.arrayContaining([
        TUNNEL_FEATURES.VAULT_CONTENT_EVENTS_V2,
      ]),
    });
  });

  it('attaches the mutation epoch to delivered events for reconnect acknowledgement', async () => {
    const { TunnelClient } = await import('./index.js');
    const client = new TunnelClient({
      relayUrl: new URL('http://relay.example/t/dev1'),
      daemonUrl: new URL('http://127.0.0.1:9891'),
      token: 'token-1',
      daemonInstanceId: 'instance-1',
      logger: { log: vi.fn() },
      random: () => 0,
    });

    client.start();
    const firstControl = MockWebSocket.instances[0];
    firstControl.open();
    expect(client.sendRelayEvent({
      topic: 'vault.content.changed',
      resource: { vaultSlug: 'demo', path: 'attachments/photo.png' },
    })).toBe(true);
    expect(JSON.parse(sentText(firstControl, 1))).toMatchObject({
      type: 'relay.frame',
      frame: {
        topic: 'vault.content.changed',
        resource: {
          vaultSlug: 'demo',
          path: 'attachments/photo.png',
          vaultMutationEpoch: '1',
        },
      },
    });

    firstControl.close(1006, 'network gap');
    await vi.advanceTimersByTimeAsync(250);
    const secondControl = MockWebSocket.instances[1];
    secondControl.open();
    expect(JSON.parse(sentText(secondControl, 0))).toMatchObject({
      type: 'control.hello',
      vaultMutationEpoch: 1,
    });
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

    client.start();
    const restartedControl = MockWebSocket.instances[1];
    restartedControl.open();
    expect(JSON.parse(sentText(restartedControl, 0))).toMatchObject({
      type: 'control.hello',
      vaultMutationEpoch: 1,
    });
  });
});
