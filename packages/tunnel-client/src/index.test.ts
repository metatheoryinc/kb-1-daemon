import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import {
  RELAY_ERROR_CODES,
  RELAY_PENDING_REQUEST_LIMIT,
  RELAY_TRANSPORT_PROTOCOL_VERSION,
  TUNNEL_CLOSE_CODES,
  TUNNEL_FEATURES,
  TUNNEL_PENDING_STREAM_FRAME_LIMIT,
  TUNNEL_WS_FRAME_BYTE_LIMIT,
  encodeTunnelMessage,
  type TunnelHttpResponseEnvelope,
  type RelayFrame,
} from '@kb-1/tunnel-protocol';
import {
  ChunkedHttpRequestAssembler,
  DialbackBridge,
  DialbackPool,
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
  onSend: ((data: unknown) => void) | undefined;

  send(data: unknown, options?: { binary?: boolean }): void {
    if (this.sendError) throw this.sendError;
    this.sent.push({ data, options });
    this.onSend?.(data);
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

function acknowledgeHttpResponseChunks(
  client: TunnelClient,
  control: FakeSocket,
): void {
  control.onSend = (data) => {
    const message = JSON.parse(Buffer.from(data as Uint8Array).toString('utf8')) as {
      type: string;
      id?: string;
      sequence?: number;
    };
    if (
      message.type !== 'http.response.chunk' ||
      message.id === undefined ||
      message.sequence === undefined
    ) {
      return;
    }
    void (
      client as unknown as {
        handleControlMessage(control: FakeSocket, data: Buffer): Promise<void>;
      }
    ).handleControlMessage(
      control,
      Buffer.from(
        JSON.stringify({
          type: 'http.response.chunk.ack',
          id: message.id,
          sequence: message.sequence,
        }),
      ),
    );
  };
}

async function advertiseHttpResponseChunkAcks(
  client: TunnelClient,
  control: FakeSocket,
): Promise<void> {
  await (
    client as unknown as {
      handleControlMessage(control: FakeSocket, data: Buffer): Promise<void>;
    }
  ).handleControlMessage(
    control,
    Buffer.from(
      JSON.stringify({
        type: 'control.ready',
        version: 2,
        features: [TUNNEL_FEATURES.HTTP_RESPONSE_CHUNK_ACKS_V1],
      }),
    ),
  );
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
    expect(sendableCloseCode(1004)).toBe(1011);
    expect(sendableCloseCode(1015)).toBe(1011);
    expect(sendableCloseCode(2999)).toBe(1011);
    expect(sendableCloseCode(3000)).toBe(3000);
    expect(sendableCloseCode(999)).toBe(1011);
    expect(sendableCloseCode(5000)).toBe(1011);
  });

  it('preserves the stable tunnel path when building internal relay URLs', () => {
    expect(relayInternalUrl(new URL('https://relay.example/t/dev1?token=nope'), '/__kb1_tunnel/control').href).toBe(
      'wss://relay.example/t/dev1/__kb1_tunnel/control',
    );
    expect(relayInternalUrl(new URL('http://127.0.0.1:9920/t/dev1/'), '/__kb1_tunnel/dialback').href).toBe(
      'ws://127.0.0.1:9920/t/dev1/__kb1_tunnel/dialback',
    );
    expect(relayInternalUrl(new URL('http://127.0.0.1:9920/t/dev1'), '__kb1_tunnel/control').href).toBe(
      'ws://127.0.0.1:9920/t/dev1/__kb1_tunnel/control',
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
    const body = await materializedResponseBody(new Response(
      new Uint8Array(gzipSync(Buffer.from('{"ok":true}'))),
      {
      headers: { 'content-encoding': 'gzip' },
      },
    ));

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
  it('keeps multi-megabyte HTTP response chunks below the websocket frame cap', async () => {
    const control = new FakeSocket();
    control.open();
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
    });
    await advertiseHttpResponseChunkAcks(client, control);
    acknowledgeHttpResponseChunks(client, control);
    const body = Buffer.alloc(3 * 1024 * 1024 + 17, 0xa5);

    await (
      client as unknown as {
        sendHttpResponse(
          control: FakeSocket,
          envelope: TunnelHttpResponseEnvelope,
        ): Promise<void>;
      }
    ).sendHttpResponse(control, {
      type: 'http.response',
      id: `response-${'x'.repeat(2048)}`,
      status: 200,
      headers: { 'content-type': 'image/png' },
      bodyB64: body.toString('base64'),
    });

    const encodedFrames = control.sent.map(({ data }) => Buffer.from(data as Uint8Array));
    expect(encodedFrames.every((frame) => frame.byteLength <= TUNNEL_WS_FRAME_BYTE_LIMIT)).toBe(true);

    const frames = encodedFrames.map((frame) => JSON.parse(frame.toString('utf8')) as {
      type: string;
      totalBytes?: number;
      sequence?: number;
      bodyB64?: string;
      chunks?: number;
    });
    expect(frames[0]).toMatchObject({
      type: 'http.response.start',
      totalBytes: body.byteLength,
    });
    expect(frames.at(-1)).toMatchObject({
      type: 'http.response.end',
      chunks: frames.length - 2,
    });

    const chunks = frames.slice(1, -1).map((frame, sequence) => {
      expect(frame).toMatchObject({ type: 'http.response.chunk', sequence });
      const chunk = Buffer.from(frame.bodyB64 ?? '', 'base64');
      return chunk;
    });
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
  });

  it('chunks a response when its encoded headers push it over the websocket frame cap', async () => {
    const control = new FakeSocket();
    control.open();
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
    });
    await advertiseHttpResponseChunkAcks(client, control);
    acknowledgeHttpResponseChunks(client, control);

    await (
      client as unknown as {
        sendHttpResponse(
          control: FakeSocket,
          envelope: TunnelHttpResponseEnvelope,
        ): Promise<void>;
      }
    ).sendHttpResponse(control, {
      type: 'http.response',
      id: '00000000-0000-4000-8000-000000000000',
      status: 200,
      headers: { 'x-padding': 'x'.repeat(1024) },
      bodyB64: Buffer.alloc(196 * 1024, 0xa5).toString('base64'),
    });

    const encodedFrames = control.sent.map(({ data }) => Buffer.from(data as Uint8Array));
    expect(encodedFrames.every((frame) => frame.byteLength <= TUNNEL_WS_FRAME_BYTE_LIMIT)).toBe(true);
    expect(JSON.parse(encodedFrames[0].toString('utf8'))).toMatchObject({
      type: 'http.response.start',
      totalBytes: 196 * 1024,
    });
  });

  it('waits for each large HTTP response chunk to be acknowledged', async () => {
    const control = new FakeSocket();
    control.open();
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
    });
    await advertiseHttpResponseChunkAcks(client, control);
    const sending = (
      client as unknown as {
        sendHttpResponse(
          control: FakeSocket,
          envelope: TunnelHttpResponseEnvelope,
        ): Promise<void>;
      }
    ).sendHttpResponse(control, {
      type: 'http.response',
      id: 'backpressured-response',
      status: 200,
      headers: { 'content-type': 'image/png' },
      bodyB64: Buffer.alloc(384 * 1024, 0xa5).toString('base64'),
    });

    await vi.waitFor(() => expect(control.sent).toHaveLength(2));
    for (let sequence = 0; sequence < 3; sequence += 1) {
      const chunk = JSON.parse(
        Buffer.from(control.sent.at(-1)?.data as Uint8Array).toString('utf8'),
      ) as { type: string; id: string; sequence: number };
      expect(chunk).toMatchObject({
        type: 'http.response.chunk',
        id: 'backpressured-response',
        sequence,
      });
      await (
        client as unknown as {
          handleControlMessage(control: FakeSocket, data: Buffer): Promise<void>;
        }
      ).handleControlMessage(
        control,
        Buffer.from(
          JSON.stringify({
            type: 'http.response.chunk.ack',
            id: chunk.id,
            sequence,
          }),
        ),
      );
      await vi.waitFor(() =>
        expect(control.sent).toHaveLength(sequence + 3),
      );
    }

    await sending;
    const frames = control.sent.map(({ data }) =>
      JSON.parse(Buffer.from(data as Uint8Array).toString('utf8')) as {
        type: string;
      },
    );
    expect(frames.map(({ type }) => type)).toEqual([
      'http.response.start',
      'http.response.chunk',
      'http.response.chunk',
      'http.response.chunk',
      'http.response.end',
    ]);
  });

  it('retains chunked response compatibility when the relay does not advertise acknowledgements', async () => {
    const control = new FakeSocket();
    control.open();
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
    });

    await (
      client as unknown as {
        handleControlMessage(control: FakeSocket, data: Buffer): Promise<void>;
      }
    ).handleControlMessage(
      control,
      Buffer.from(JSON.stringify({ type: 'control.ready', version: 2 })),
    );
    await (
      client as unknown as {
        sendHttpResponse(
          control: FakeSocket,
          envelope: TunnelHttpResponseEnvelope,
        ): Promise<void>;
      }
    ).sendHttpResponse(control, {
      type: 'http.response',
      id: 'legacy-relay-response',
      status: 200,
      headers: { 'content-type': 'image/png' },
      bodyB64: Buffer.alloc(384 * 1024, 0xa5).toString('base64'),
    });

    const frameTypes = control.sent.map(({ data }) =>
      (JSON.parse(Buffer.from(data as Uint8Array).toString('utf8')) as {
        type: string;
      }).type,
    );
    expect(frameTypes).toEqual([
      'http.response.start',
      'http.response.chunk',
      'http.response.chunk',
      'http.response.chunk',
      'http.response.end',
    ]);
  });

  it('stops a chunked response when cancellation races the next chunk after an acknowledgement', async () => {
    const control = new FakeSocket();
    control.open();
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
    });
    await advertiseHttpResponseChunkAcks(client, control);
    (
      client as unknown as {
        pendingHttpRequests: Map<
          string,
          { abort: AbortController; canceled: boolean }
        >;
      }
    ).pendingHttpRequests.set('cancelled-response', {
      abort: new AbortController(),
      canceled: false,
    });

    const sending = (
      client as unknown as {
        sendHttpResponse(
          control: FakeSocket,
          envelope: TunnelHttpResponseEnvelope,
        ): Promise<void>;
      }
    ).sendHttpResponse(control, {
      type: 'http.response',
      id: 'cancelled-response',
      status: 200,
      headers: { 'content-type': 'image/png' },
      bodyB64: Buffer.alloc(384 * 1024, 0xa5).toString('base64'),
    });
    await vi.waitFor(() => expect(control.sent).toHaveLength(2));

    const handleControlMessage = (
      client as unknown as {
        handleControlMessage(control: FakeSocket, data: Buffer): Promise<void>;
      }
    ).handleControlMessage.bind(client);
    const acknowledgement = handleControlMessage(
      control,
      Buffer.from(
        JSON.stringify({
          type: 'http.response.chunk.ack',
          id: 'cancelled-response',
          sequence: 0,
        }),
      ),
    );
    const cancellation = handleControlMessage(
      control,
      Buffer.from(
        JSON.stringify({
          type: 'http.cancel',
          id: 'cancelled-response',
          reason: 'browser disconnected',
        }),
      ),
    );
    await Promise.all([acknowledgement, cancellation, sending]);

    expect(
      control.sent.map(({ data }) =>
        (JSON.parse(Buffer.from(data as Uint8Array).toString('utf8')) as {
          type: string;
        }).type,
      ),
    ).toEqual(['http.response.start', 'http.response.chunk']);
  });

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
        resource: {
          vaultSlug: 'demo-vault',
          vaultMutationEpoch: '1',
        },
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

  it('handles mcp.tool.call in one relay RPC while preserving actor attribution', async () => {
    const observedMethods: string[] = [];
    const observedToolCalls: unknown[] = [];
    let toolResultText = '{"ok":true}';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      observedMethods.push(request.method);
      expect(request.url).toBe('http://daemon.test/mcp');
      expect(request.headers.get('x-kb1-actor')).toBe(JSON.stringify({
        kind: 'integration',
        id: 'integration-1',
        name: 'Codex',
        client: 'codex',
      }));

      if (request.method === 'GET') {
        return new Response(null, { status: 405 });
      }
      if (request.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      const message = await request.json() as {
        id?: string | number;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (message.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'kb-1-test-daemon', version: '0.0.0' },
          },
        }, {
          headers: { 'mcp-session-id': 'session-1' },
        });
      }
      if (message.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (message.method === 'tools/call') {
        observedToolCalls.push(message);
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: toolResultText }],
          },
        });
      }
      throw new Error(`Unexpected MCP request: ${JSON.stringify(message)}`);
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
          deadlineMs?: number;
          payload?: {
            encoding: 'json';
            value: Record<string, unknown>;
          };
          context?: Record<string, unknown>;
        }): Promise<unknown>;
      }
    ).handleRelayRpcRequest({
      type: 'rpc.request',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-mcp-1',
      capability: 'mcp.tool.call',
      deadlineMs: 1_000,
      payload: {
        encoding: 'json',
        value: {
          toolName: 'read_note',
          arguments: { vaultId: 'ledger', path: 'README.md' },
          clientName: 'codex',
        },
      },
      context: {
        actor: {
          kind: 'integration',
          id: 'integration-1',
          name: 'Codex',
          client: 'codex',
        },
      },
    });

    expect(response).toEqual({
      type: 'rpc.response',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-mcp-1',
      ok: true,
      payload: {
        encoding: 'json',
        value: {
          content: [{ type: 'text', text: '{"ok":true}' }],
        },
      },
    });
    expect(observedToolCalls).toHaveLength(1);
    expect(observedMethods.filter((method) => method === 'POST').length).toBe(3);
    expect(observedMethods).toContain('DELETE');

    toolResultText = 'x'.repeat(192 * 1024);
    const oversizedResponse = await (
      client as unknown as {
        handleRelayRpcRequest(request: {
          type: 'rpc.request';
          version: typeof RELAY_TRANSPORT_PROTOCOL_VERSION;
          id: string;
          capability: string;
          deadlineMs?: number;
          payload?: {
            encoding: 'json';
            value: Record<string, unknown>;
          };
          context?: Record<string, unknown>;
        }): Promise<unknown>;
      }
    ).handleRelayRpcRequest({
      type: 'rpc.request',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-mcp-large',
      capability: 'mcp.tool.call',
      payload: {
        encoding: 'json',
        value: { toolName: 'read_note', arguments: {} },
      },
      context: {
        actor: {
          kind: 'integration',
          id: 'integration-1',
          name: 'Codex',
          client: 'codex',
        },
      },
    });
    expect(oversizedResponse).toMatchObject({
      ok: false,
      error: { code: RELAY_ERROR_CODES.PAYLOAD_TOO_LARGE },
    });

    const oversizedMutationResponse = await (
      client as unknown as {
        handleRelayRpcRequest(request: {
          type: 'rpc.request';
          version: typeof RELAY_TRANSPORT_PROTOCOL_VERSION;
          id: string;
          capability: string;
          payload: {
            encoding: 'json';
            value: Record<string, unknown>;
          };
          context: Record<string, unknown>;
        }): Promise<unknown>;
      }
    ).handleRelayRpcRequest({
      type: 'rpc.request',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-mcp-large-mutation-result',
      capability: 'mcp.tool.call',
      payload: {
        encoding: 'json',
        value: { toolName: 'append_note', arguments: {} },
      },
      context: {
        actor: {
          kind: 'integration',
          id: 'integration-1',
          name: 'Codex',
          client: 'codex',
        },
      },
    });
    expect(oversizedMutationResponse).toMatchObject({
      ok: true,
      payload: {
        value: {
          content: [{
            type: 'text',
            text: expect.stringContaining('"resultOmitted":true'),
          }],
        },
      },
    });
  });

  it('rejects malformed mcp.tool.call payloads before reaching the daemon', async () => {
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
          payload?: { encoding: 'json'; value: Record<string, unknown> };
          context?: Record<string, unknown>;
        }): Promise<unknown>;
      }
    ).handleRelayRpcRequest({
      type: 'rpc.request',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-mcp-bad',
      capability: 'mcp.tool.call',
      payload: {
        encoding: 'json',
        value: { toolName: '', arguments: [] },
      },
      context: {
        actor: { kind: 'integration', client: 'codex' },
      },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      type: 'rpc.response',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-mcp-bad',
      ok: false,
      error: { code: RELAY_ERROR_CODES.BAD_MESSAGE },
    });
  });

  it.each([
    {
      label: 'non-object arguments',
      payload: { toolName: 'read_note', arguments: [] },
      context: { actor: { kind: 'integration', client: 'codex' } },
    },
    {
      label: 'missing actor',
      payload: { toolName: 'read_note', arguments: {} },
      context: {},
    },
    {
      label: 'non-string actor fields',
      payload: { toolName: 'read_note', arguments: {} },
      context: { actor: { kind: 'integration', id: 42 } },
    },
  ])('rejects $label for mcp.tool.call without a daemon fetch', async ({ payload, context }) => {
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
          payload?: { encoding: 'json'; value: Record<string, unknown> };
          context?: Record<string, unknown>;
        }): Promise<unknown>;
      }
    ).handleRelayRpcRequest({
      type: 'rpc.request',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-mcp-invalid',
      capability: 'mcp.tool.call',
      payload: { encoding: 'json', value: payload },
      context,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      ok: false,
      error: { code: RELAY_ERROR_CODES.BAD_MESSAGE },
    });
  });

  it('returns a deadline error and independently terminates the initialized MCP session', async () => {
    const observedMethods: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      observedMethods.push(request.method);
      if (request.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      const message = await request.json() as {
        id?: string | number;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (message.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'kb-1-test-daemon', version: '0.0.0' },
          },
        }, {
          headers: { 'mcp-session-id': 'session-timeout' },
        });
      }
      if (message.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (message.method !== 'tools/call') {
        throw new Error(`Unexpected MCP request: ${JSON.stringify(message)}`);
      }

      const signal = init?.signal;
      if (!signal) throw new Error('Expected the relay deadline signal');
      if (signal.aborted) {
        throw signal.reason;
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(signal.reason),
          { once: true },
        );
      });
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
          deadlineMs: number;
          payload: { encoding: 'json'; value: Record<string, unknown> };
          context: Record<string, unknown>;
        }): Promise<unknown>;
      }
    ).handleRelayRpcRequest({
      type: 'rpc.request',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-mcp-timeout',
      capability: 'mcp.tool.call',
      deadlineMs: 5,
      payload: {
        encoding: 'json',
        value: { toolName: 'read_note', arguments: {} },
      },
      context: {
        actor: { kind: 'integration', client: 'codex' },
      },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: RELAY_ERROR_CODES.DEADLINE_EXCEEDED },
    });
    expect(observedMethods).toContain('DELETE');
  });

  it('returns a completed tool result without waiting for session cleanup', async () => {
    let markCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup: (() => void) | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'DELETE') {
        markCleanupStarted?.();
        return new Promise<Response>((resolve) => {
          releaseCleanup = () => resolve(new Response(null, { status: 200 }));
        });
      }

      const message = await request.json() as {
        id?: string | number;
        method?: string;
        params?: { protocolVersion?: string };
      };
      if (message.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'kb-1-test-daemon', version: '0.0.0' },
          },
        }, {
          headers: { 'mcp-session-id': 'session-slow-cleanup' },
        });
      }
      if (message.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (message.method === 'tools/call') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: '{"ok":true}' }],
          },
        });
      }
      throw new Error(`Unexpected MCP request: ${JSON.stringify(message)}`);
    });
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
      fetch: fetchImpl as typeof fetch,
    });

    const responsePromise = (
      client as unknown as {
        handleRelayRpcRequest(request: {
          type: 'rpc.request';
          version: typeof RELAY_TRANSPORT_PROTOCOL_VERSION;
          id: string;
          capability: string;
          deadlineMs: number;
          payload: { encoding: 'json'; value: Record<string, unknown> };
          context: Record<string, unknown>;
        }): Promise<unknown>;
      }
    ).handleRelayRpcRequest({
      type: 'rpc.request',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-mcp-slow-cleanup',
      capability: 'mcp.tool.call',
      deadlineMs: 1_000,
      payload: {
        encoding: 'json',
        value: { toolName: 'append_note', arguments: {} },
      },
      context: {
        actor: { kind: 'integration', client: 'codex' },
      },
    });

    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('Tool result waited for MCP cleanup')),
          100,
        );
      }),
    ]);
    expect(response).toMatchObject({
      ok: true,
      payload: {
        value: {
          content: [{ type: 'text', text: '{"ok":true}' }],
        },
      },
    });
    await cleanupStarted;
    releaseCleanup?.();
  });

  it('aborts an in-flight MCP tool and cleans up its session on relay cancellation', async () => {
    let toolCallStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      toolCallStarted = resolve;
    });
    const observedMethods: string[] = [];
    const observedJsonRpcMethods: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      observedMethods.push(request.method);
      if (request.method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      const message = await request.json() as {
        id?: string | number;
        method?: string;
        params?: { protocolVersion?: string };
      };
      observedJsonRpcMethods.push(message.method);
      if (message.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'kb-1-test-daemon', version: '0.0.0' },
          },
        }, {
          headers: { 'mcp-session-id': 'session-cancel' },
        });
      }
      if (message.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (message.method === 'notifications/cancelled') {
        expect(request.signal.aborted).toBe(false);
        return new Response(null, { status: 202 });
      }
      if (message.method !== 'tools/call') {
        throw new Error(`Unexpected MCP request: ${JSON.stringify(message)}`);
      }

      toolCallStarted?.();
      const signal = init?.signal;
      if (!signal) throw new Error('Expected the relay cancellation signal');
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(signal.reason),
          { once: true },
        );
      });
    });
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
      fetch: fetchImpl as typeof fetch,
    });
    const control = new FakeSocket();
    control.open();
    const handleRelayFrame = (
      client as unknown as {
        handleRelayFrame(control: unknown, frame: RelayFrame): Promise<void>;
      }
    ).handleRelayFrame.bind(client);

    const request = handleRelayFrame(control, {
      type: 'rpc.request',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'rpc-mcp-cancel',
      capability: 'mcp.tool.call',
      deadlineMs: 1_000,
      payload: {
        encoding: 'json',
        value: { toolName: 'append_note', arguments: { content: 'new' } },
      },
      context: {
        actor: { kind: 'integration', client: 'codex' },
      },
    });
    await started;

    await handleRelayFrame(control, {
      type: 'cancel',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      target: { kind: 'rpc', id: 'rpc-mcp-cancel' },
      reason: 'Cloud caller disconnected',
    });
    await request;

    const sent = control.sent.map(({ data }) =>
      JSON.parse(Buffer.from(data as Uint8Array).toString('utf8')) as {
        frame?: { ok?: boolean; error?: { code?: string } };
      });
    expect(sent.at(-1)?.frame).toMatchObject({
      ok: false,
      error: {
        code: RELAY_ERROR_CODES.INDETERMINATE,
        message: expect.stringContaining('reconcile state before retrying'),
      },
    });
    expect(observedMethods).toContain('DELETE');
    await vi.waitFor(() => {
      expect(observedJsonRpcMethods).toContain('notifications/cancelled');
    });
  });

  it('advertises one-hop MCP tool support as a control feature', () => {
    expect(TUNNEL_FEATURES.MCP_TOOL_CALL_BOUNDED_RESULTS_V1).toBe(
      'relay.mcp-tool-call.bounded-results.v1',
    );
  });

  it('advertises vault content invalidation support as a control feature', () => {
    expect(TUNNEL_FEATURES.VAULT_CONTENT_EVENTS_V1).toBe(
      'relay.vault-content-events.v1',
    );
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

  it('applies relay RPC backpressure before creating another MCP session', async () => {
    const fetchImpl = vi.fn();
    const client = new TunnelClient({
      relayUrl: new URL('ws://relay.test/t/demo'),
      daemonUrl: new URL('http://daemon.test'),
      token: 'token',
      fetch: fetchImpl as typeof fetch,
    });
    const pending = (
      client as unknown as {
        pendingRelayRpcRequests: Map<string, AbortController>;
      }
    ).pendingRelayRpcRequests;
    for (let index = 0; index < RELAY_PENDING_REQUEST_LIMIT; index += 1) {
      pending.set(`existing-${index}`, new AbortController());
    }
    const control = new FakeSocket();
    control.open();

    await (
      client as unknown as {
        handleRelayFrame(control: unknown, frame: RelayFrame): Promise<void>;
      }
    ).handleRelayFrame(control, {
      type: 'rpc.request',
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: 'over-capacity',
      capability: 'mcp.tool.call',
      payload: {
        encoding: 'json',
        value: { toolName: 'read_note', arguments: {} },
      },
      context: {
        actor: { kind: 'integration', client: 'codex' },
      },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    const lastSent = control.sent.at(-1);
    if (!lastSent) throw new Error('Expected a backpressure response');
    const sent = JSON.parse(
      Buffer.from(lastSent.data as Uint8Array).toString('utf8'),
    ) as { frame?: { error?: { code?: string } } };
    expect(sent.frame?.error?.code).toBe(RELAY_ERROR_CODES.BACKPRESSURE);
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

describe("DialbackPool", () => {
  const OPEN = 1;

  function makePool(size: number) {
    const created: FakeSocket[] = [];
    const helloed: FakeSocket[] = [];
    const pool = new DialbackPool({
      size,
      createSocket: () => {
        const s = new FakeSocket();
        created.push(s);
        return s;
      },
      sendPoolHello: (s) => helloed.push(s as FakeSocket),
    });
    return { pool, created, helloed };
  }

  it("primes up to size and sends pool hello once each socket opens", () => {
    const { pool, created, helloed } = makePool(3);
    pool.prime();
    expect(created).toHaveLength(3);
    created.forEach((s) => s.open());
    expect(helloed).toHaveLength(3);
  });

  it("acquire returns an opened socket and refills back to size", () => {
    const { pool, created } = makePool(2);
    pool.prime();
    created.forEach((s) => s.open());
    const s = pool.acquire();
    expect(s).not.toBeNull();
    expect(s!.readyState).toBe(OPEN);
    // one consumed; pool opened a replacement
    expect(created).toHaveLength(3);
  });

  it("acquire returns null when the pool is empty", () => {
    const { pool } = makePool(1);
    // prime() called, socket still CONNECTING (never opened)
    pool.prime();
    expect(pool.acquire()).toBeNull();
  });

  it("acquire skips a dead ready socket and returns null", () => {
    const { pool, created } = makePool(1);
    pool.prime();
    created[0].open();
    created[0].readyState = 3; // CLOSED under the socket without emitting close
    expect(pool.acquire()).toBeNull();
  });

  it("size 0 opens nothing and always returns null", () => {
    const { pool, created } = makePool(0);
    pool.prime();
    expect(created).toHaveLength(0);
    expect(pool.acquire()).toBeNull();
  });
});
