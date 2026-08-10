import {
  PendingFrameBuffer,
  RELAY_ERROR_CODES,
  RELAY_PENDING_REQUEST_LIMIT,
  RELAY_TRANSPORT_PROTOCOL_VERSION,
  TUNNEL_CLOSE_CODES,
  TUNNEL_FEATURES,
  TUNNEL_HTTP_BODY_CHUNK_BYTES,
  TUNNEL_HTTP_PENDING_BYTE_LIMIT,
  TUNNEL_HTTP_REQUEST_TIMEOUT_MS,
  TUNNEL_WS_FRAME_BYTE_LIMIT,
  TUNNEL_PROTOCOL_VERSION,
  TUNNEL_PENDING_STREAM_PAIR_TIMEOUT_MS,
  decodeTunnelMessage,
  encodeTunnelMessage,
  parseRelayFrame,
  type RelayFrame,
  type RelayJsonObject,
  type RelayJsonValue,
  type RelayRpcRequestFrame,
  type RelayRpcResponseFrame,
  type TunnelControlServerMessage,
  type TunnelHttpCancelEnvelope,
  type TunnelHttpRequestChunkEnvelope,
  type TunnelHttpRequestEndEnvelope,
  type TunnelHttpRequestEnvelope,
  type TunnelHttpRequestStartEnvelope,
  type TunnelHttpResponseChunkAckEnvelope,
  type TunnelHttpResponseChunkEnvelope,
  type TunnelHttpResponseEnvelope,
  type TunnelWebSocketCloseEnvelope,
  type TunnelWebSocketOpenEnvelope,
} from '@kb-1/tunnel-protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { WebSocket } from 'ws';

export type TunnelClientLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type TunnelClientLogger = {
  log(level: TunnelClientLogLevel, message: string, fields?: Record<string, unknown>): void;
};

export type TunnelClientConfig = {
  relayUrl: URL;
  daemonUrl: URL;
  token: string;
  daemonVersion?: string;
  daemonBuild?: string;
  daemonInstanceId?: string;
  dialbackPoolSize?: number;
  logger?: TunnelClientLogger;
  fetch?: typeof fetch;
  random?: () => number;
};

export type TunnelClientStatus = {
  started: boolean;
  controlConnected: boolean;
  reconnectScheduled: boolean;
};

export type TunnelRelayEventInput = {
  topic: string;
  id?: string;
  payload?: RelayJsonValue;
  resource?: RelayJsonObject;
};

export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  jitterRatio?: number;
};

const DEFAULT_BACKOFF_BASE_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 10_000;
const DEFAULT_BACKOFF_JITTER_RATIO = 0.25;
const MCP_RELAY_CLIENT_NAME = 'kb-1-cloud-relay';
const MCP_RELAY_MAX_PAYLOAD_BYTES = 192 * 1024;
const MAX_MCP_TOOL_NAME_BYTES = 256;
const MAX_MCP_CLIENT_NAME_BYTES = 256;
const MAX_ACTOR_HEADER_BYTES = 1_024;
const MCP_SESSION_CLEANUP_TIMEOUT_MS = 1_000;
const MCP_READ_ONLY_TOOLS = new Set([
  'list_vaults',
  'vault_info',
  'list_files',
  'list_attachments',
  'read_attachment',
  'get_folder_metadata',
  'read_note',
  'search',
]);
export const CONTROL_HEARTBEAT_INTERVAL_MS = 15_000;
export const CONTROL_HEARTBEAT_TIMEOUT_MS = 12_000;
export const CONTROL_HEARTBEAT_MISSES_BEFORE_RECONNECT = 2;
export const CONTROL_DURABLE_LIVENESS_INTERVAL_MS = 30_000;

const hopByHopHeaders = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const responseBodyTransformHeaders = new Set([
  'content-encoding',
]);

type PendingDaemonHttpRequest = {
  abort: AbortController;
  canceled: boolean;
};

type PendingHttpResponseChunkAck = {
  sequence: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/* v8 ignore start -- Live relay socket orchestration is covered by Stage A wrangler/daemon/browser drills; unit tests cover the deterministic backoff, close-code, URL, and dial-back bridge logic below. */
export class TunnelClient {
  private readonly logger: TunnelClientLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private control: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private controlHeartbeatInterval: ReturnType<typeof setInterval> | undefined;
  private controlHeartbeatDeadline: ReturnType<typeof setTimeout> | undefined;
  private controlHeartbeatMisses = 0;
  private readonly httpAssembler = new ChunkedHttpRequestAssembler();
  private readonly pendingHttpRequests = new Map<string, PendingDaemonHttpRequest>();
  private readonly pendingHttpResponseChunkAcks = new Map<
    string,
    PendingHttpResponseChunkAck
  >();
  private readonly pendingRelayRpcRequests = new Map<string, AbortController>();
  private stopped = true;
  private hasStarted = false;
  private reconnectAttempt = 0;
  private relaySupportsHttpResponseChunkAcks = false;
  private readonly daemonInstanceId: string;
  private vaultMutationEpoch = 0;
  private readonly dialbackPool: DialbackPool | undefined;

  constructor(private readonly config: TunnelClientConfig) {
    this.logger = config.logger ?? consoleLogger;
    this.fetchImpl = config.fetch ?? fetch;
    this.random = config.random ?? Math.random;
    this.daemonInstanceId = config.daemonInstanceId ?? randomUUID();

    const poolSize = config.dialbackPoolSize ?? 3;
    this.dialbackPool =
      poolSize > 0
        ? new DialbackPool({
            size: poolSize,
            logger: this.logger,
            createSocket: () => this.openPoolRelaySocket(),
            sendPoolHello: (socket) => this.sendDialbackPoolHello(socket),
          })
        : undefined;
  }

  start(): void {
    if (!this.stopped) return;

    // A deliberate stop releases the vault-event subscription in the daemon.
    // Fence any cache retained across that unobserved interval before the
    // client registers again. Transport-level reconnects do not call start(),
    // so ordinary network churn can still retain cache when no mutation occurs.
    if (this.hasStarted) {
      this.vaultMutationEpoch += 1;
    } else {
      this.hasStarted = true;
    }
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.connectControl();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearControlHeartbeat();
    this.abortPendingHttpRequests();
    this.abortPendingHttpResponseChunkAcks('Tunnel client stopping');
    this.relaySupportsHttpResponseChunkAcks = false;
    this.abortPendingRelayRpcRequests('Tunnel client stopping');
    this.control?.close(1001, 'Tunnel client stopping');
    this.control = undefined;
  }

  status(): TunnelClientStatus {
    return {
      started: !this.stopped,
      controlConnected: this.control?.readyState === WebSocket.OPEN,
      reconnectScheduled: this.reconnectTimer !== undefined,
    };
  }

  sendRelayEvent(event: TunnelRelayEventInput): boolean {
    const isVaultMutation =
      event.topic === 'vault.tree.changed' || event.topic === 'vault.content.changed';
    if (isVaultMutation) {
      this.vaultMutationEpoch += 1;
    }
    const resource = isVaultMutation
      ? {
          ...event.resource,
          vaultMutationEpoch: String(this.vaultMutationEpoch),
        }
      : event.resource;
    const control = this.control;
    if (!control || control.readyState !== WebSocket.OPEN) {
      this.logger.log('debug', 'relay event skipped because control is not open', {
        topic: event.topic,
      });
      return false;
    }

    try {
      control.send(encodeJsonBytes({
        type: 'relay.frame',
        frame: {
          type: 'event',
          version: RELAY_TRANSPORT_PROTOCOL_VERSION,
          topic: event.topic,
          ...(event.id !== undefined ? { id: event.id } : {}),
          ...(event.payload !== undefined ? { payload: { encoding: 'json', value: event.payload } } : {}),
          ...(resource !== undefined ? { resource } : {}),
        },
      }));
      return true;
    } catch (error) {
      this.logger.log('warn', 'relay event send failed', {
        topic: event.topic,
        error: String(error),
      });
      return false;
    }
  }

  private connectControl(): void {
    if (this.stopped) return;

    this.relaySupportsHttpResponseChunkAcks = false;

    // Coordinated relay wire paths: keep `/__kb1_tunnel/*` stable until the
    // cloud relay and all clients migrate together.
    const controlUrl = relayInternalUrl(this.config.relayUrl, '/__kb1_tunnel/control');
    const control = new WebSocket(controlUrl, {
      headers: { authorization: `Bearer ${this.config.token}` },
    });
    this.control = control;

    control.on('open', () => {
      control.send(encodeJsonBytes({
        type: 'control.hello',
        version: TUNNEL_PROTOCOL_VERSION,
        token: this.config.token,
        ...(this.config.daemonVersion ? { daemonVersion: this.config.daemonVersion } : {}),
        ...(this.config.daemonBuild ? { daemonBuild: this.config.daemonBuild } : {}),
        daemonInstanceId: this.daemonInstanceId,
        vaultMutationEpoch: this.vaultMutationEpoch,
        features: [
          TUNNEL_FEATURES.RELAY_FRAMES_V1,
          TUNNEL_FEATURES.VAULT_CONTENT_EVENTS_V1,
          TUNNEL_FEATURES.VAULT_CONTENT_EVENTS_V2,
          TUNNEL_FEATURES.MCP_TOOL_CALL_BOUNDED_RESULTS_V1,
          TUNNEL_FEATURES.HTTP_RESPONSE_CHUNK_ACKS_V1,
        ],
      }));
      this.startControlHeartbeat(control);
      this.logger.log('info', 'relay control connected', {
        relayHost: controlUrl.host,
        protocolVersion: TUNNEL_PROTOCOL_VERSION,
      });
    });

    control.on('message', (data) => {
      void this.handleControlMessage(control, data).catch((error: unknown) => {
        this.logger.log('error', 'relay control message failed', { error: String(error) });
      });
    });

    control.on('close', (code, reason) => {
      if (this.control === control) {
        this.control = undefined;
        this.clearControlHeartbeat();
        this.abortPendingHttpRequests();
        this.abortPendingHttpResponseChunkAcks('Relay control disconnected');
        this.relaySupportsHttpResponseChunkAcks = false;
        this.abortPendingRelayRpcRequests('Relay control disconnected');
      }

      if (this.stopped) return;

      if (code === TUNNEL_CLOSE_CODES.CONTROL_REPLACED) {
        this.stopped = true;
        this.logger.log('warn', 'relay control replaced by a newer registration');
        return;
      }

      const delayMs = createBackoffDelay(this.reconnectAttempt, {}, this.random);
      this.reconnectAttempt += 1;
      this.logger.log('warn', 'relay control closed; reconnect scheduled', {
        code,
        reason: reason.toString(),
        delayMs,
      });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.connectControl();
      }, delayMs);
    });

    control.on('error', (error) => {
      this.logger.log('warn', 'relay control socket error', { error: String(error) });
    });
  }

  private async handleControlMessage(control: WebSocket, data: WebSocket.RawData): Promise<void> {
    if (typeof data !== 'string' && !Buffer.isBuffer(data)) {
      return;
    }

    const message = decodeTunnelMessage(data.toString()) as TunnelControlServerMessage;
    switch (message.type) {
      case 'control.ready':
        this.reconnectAttempt = 0;
        this.relaySupportsHttpResponseChunkAcks =
          message.features?.includes(
            TUNNEL_FEATURES.HTTP_RESPONSE_CHUNK_ACKS_V1,
          ) ?? false;
        this.logger.log('info', 'relay control ready', { protocolVersion: message.version });
        this.dialbackPool?.prime();
        return;
      case 'control.pong':
        this.clearControlHeartbeatDeadline();
        this.controlHeartbeatMisses = 0;
        return;
      case 'control.error':
        this.logger.log('error', 'relay control rejected message', {
          code: message.code,
          relayMessage: message.message,
        });
        return;
      case 'relay.frame':
        await this.handleRelayFrame(control, parseRelayFrame(message.frame));
        return;
      case 'http.request':
        await this.proxyAndSendHttpResponse(control, message);
        return;
      case 'http.request.start':
        this.httpAssembler.start(message);
        return;
      case 'http.request.chunk':
        this.httpAssembler.chunk(message);
        return;
      case 'http.request.end': {
        const assembled = this.httpAssembler.end(message);
        if (assembled) {
          await this.proxyAndSendHttpResponse(control, assembled);
        }
        return;
      }
      case 'http.cancel':
        this.cancelHttpRequest(message);
        return;
      case 'http.response.chunk.ack':
        this.resolveHttpResponseChunkAck(message);
        return;
      case 'ws.open':
        this.openDialback(message);
        return;
    }
  }

  private async handleRelayFrame(control: WebSocket, frame: RelayFrame): Promise<void> {
    if (frame.type === 'cancel' && frame.target.kind === 'rpc') {
      this.pendingRelayRpcRequests
        .get(frame.target.id)
        ?.abort(new Error(frame.reason ?? 'Relay cancelled RPC request'));
      return;
    }

    if (frame.type !== 'rpc.request') {
      this.logger.log('warn', 'relay frame type is not handled by tunnel client', { frameType: frame.type });
      return;
    }

    if (this.pendingRelayRpcRequests.has(frame.id)) {
      control.send(encodeJsonBytes({
        type: 'relay.frame',
        frame: relayRpcError(
          frame.id,
          RELAY_ERROR_CODES.BACKPRESSURE,
          `Relay RPC request ${frame.id} is already in flight`,
        ),
      }));
      return;
    }
    if (this.pendingRelayRpcRequests.size >= RELAY_PENDING_REQUEST_LIMIT) {
      control.send(encodeJsonBytes({
        type: 'relay.frame',
        frame: relayRpcError(
          frame.id,
          RELAY_ERROR_CODES.BACKPRESSURE,
          `Relay RPC concurrency limit of ${RELAY_PENDING_REQUEST_LIMIT} reached`,
        ),
      }));
      return;
    }

    const abort = new AbortController();
    this.pendingRelayRpcRequests.set(frame.id, abort);
    try {
      control.send(encodeJsonBytes({
        type: 'relay.frame',
        frame: await this.handleRelayRpcRequest(frame, abort.signal),
      }));
    } finally {
      if (this.pendingRelayRpcRequests.get(frame.id) === abort) {
        this.pendingRelayRpcRequests.delete(frame.id);
      }
    }
  }

  private async handleRelayRpcRequest(
    request: RelayRpcRequestFrame,
    relaySignal?: AbortSignal,
  ): Promise<RelayRpcResponseFrame> {
    switch (request.capability) {
      case 'vault.list':
        return this.handleVaultListRpc(request, relaySignal);
      case 'mcp.tool.call':
        return this.handleMcpToolCallRpc(request, relaySignal);
      default:
        return relayRpcError(request.id, RELAY_ERROR_CODES.UNKNOWN_CAPABILITY, `Unknown relay capability: ${request.capability}`);
    }
  }

  private async handleVaultListRpc(
    request: RelayRpcRequestFrame,
    relaySignal?: AbortSignal,
  ): Promise<RelayRpcResponseFrame> {
    const deadlineAbort = new AbortController();
    const timeout = setTimeout(
      () => deadlineAbort.abort(new Error('Vault list relay RPC deadline exceeded')),
      request.deadlineMs ?? TUNNEL_HTTP_REQUEST_TIMEOUT_MS,
    );
    const signal = relaySignal
      ? AbortSignal.any([deadlineAbort.signal, relaySignal])
      : deadlineAbort.signal;

    try {
      const response = await this.fetchImpl(new URL('/api/vaults', this.config.daemonUrl), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      });
      if (!response.ok) {
        return relayRpcError(request.id, RELAY_ERROR_CODES.INTERNAL, `Daemon vault list failed with status ${response.status}`);
      }

      return {
        type: 'rpc.response',
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        payload: { encoding: 'json', value: await response.json() as RelayJsonValue },
      };
    } catch (error) {
      return relayRpcError(
        request.id,
        deadlineAbort.signal.aborted
          ? RELAY_ERROR_CODES.DEADLINE_EXCEEDED
          : relaySignal?.aborted
            ? RELAY_ERROR_CODES.CANCELLED
            : RELAY_ERROR_CODES.INTERNAL,
        `Daemon vault list RPC failed: ${String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleMcpToolCallRpc(
    request: RelayRpcRequestFrame,
    relaySignal?: AbortSignal,
  ): Promise<RelayRpcResponseFrame> {
    const parsed = parseMcpToolCallRpcRequest(request);
    if (!parsed.ok) {
      return relayRpcError(request.id, RELAY_ERROR_CODES.BAD_MESSAGE, parsed.message);
    }

    const deadlineAbort = new AbortController();
    const timeout = setTimeout(
      () => deadlineAbort.abort(new Error('MCP relay RPC deadline exceeded')),
      request.deadlineMs ?? TUNNEL_HTTP_REQUEST_TIMEOUT_MS,
    );
    const operationSignal = relaySignal
      ? AbortSignal.any([deadlineAbort.signal, relaySignal])
      : deadlineAbort.signal;
    let toolCallDispatched = false;
    let cleaningUp = false;
    const transport = new StreamableHTTPClientTransport(
      new URL('/mcp', this.config.daemonUrl),
      {
        fetch: (input, init) => {
          if (cleaningUp) {
            const cleanupAbort = new AbortController();
            const cleanupTimeout = setTimeout(
              () => cleanupAbort.abort(new Error('MCP session cleanup timed out')),
              MCP_SESSION_CLEANUP_TIMEOUT_MS,
            );
            return this.fetchImpl(input, { ...init, signal: cleanupAbort.signal })
              .finally(() => clearTimeout(cleanupTimeout));
          }
          const transportSignal =
            input instanceof Request ? input.signal : init?.signal;
          if (operationSignal.aborted) {
            const cancellationAbort = new AbortController();
            const cancellationTimeout = setTimeout(
              () => cancellationAbort.abort(
                new Error('MCP cancellation notification timed out'),
              ),
              MCP_SESSION_CLEANUP_TIMEOUT_MS,
            );
            const cancellationSignal = transportSignal
              ? AbortSignal.any([
                cancellationAbort.signal,
                transportSignal,
              ])
              : cancellationAbort.signal;
            return this.fetchImpl(input, {
              ...init,
              signal: cancellationSignal,
            }).finally(() => clearTimeout(cancellationTimeout));
          }
          const signals = [
            operationSignal,
            ...(transportSignal ? [transportSignal] : []),
          ];
          const signal = signals.length === 1
            ? signals[0]
            : AbortSignal.any(signals);
          return this.fetchImpl(input, { ...init, signal });
        },
        requestInit: {
          headers: { 'x-kb1-actor': parsed.actorHeader },
        },
      },
    );
    const client = new Client({
      name: parsed.clientName,
      version: '0.0.1',
    });

    try {
      await client.connect(transport);
      toolCallDispatched = true;
      const result = await client.callTool(
        {
          name: parsed.toolName,
          arguments: parsed.arguments,
        },
        undefined,
        { signal: operationSignal },
      );
      if (
        Buffer.byteLength(JSON.stringify(result), 'utf8')
        > MCP_RELAY_MAX_PAYLOAD_BYTES
      ) {
        if (!MCP_READ_ONLY_TOOLS.has(parsed.toolName)) {
          const originalSucceeded = result.isError !== true;
          return {
            type: 'rpc.response',
            version: RELAY_TRANSPORT_PROTOCOL_VERSION,
            id: request.id,
            ok: true,
            payload: {
              encoding: 'json',
              value: {
                ...(originalSucceeded ? {} : { isError: true }),
                content: [{
                  type: 'text',
                  text: JSON.stringify(originalSucceeded
                    ? {
                      ok: true,
                      resultOmitted: true,
                      message:
                        'Mutation completed, but its full result exceeded the one-hop relay limit. Read current state before another mutation.',
                    }
                    : {
                      ok: false,
                      error: 'result_too_large',
                      resultOmitted: true,
                      message:
                        'Mutation rejection exceeded the one-hop relay limit. Reconcile current state before retrying.',
                    }),
                }],
              },
            },
          };
        }
        return relayRpcError(
          request.id,
          RELAY_ERROR_CODES.PAYLOAD_TOO_LARGE,
          'Daemon MCP tool result is too large for one-hop relay RPC',
        );
      }
      return {
        type: 'rpc.response',
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        payload: { encoding: 'json', value: result as RelayJsonValue },
      };
    } catch (error) {
      const aborted =
        deadlineAbort.signal.aborted || relaySignal?.aborted === true;
      const mutationOutcomeIsIndeterminate =
        aborted &&
        toolCallDispatched &&
        !MCP_READ_ONLY_TOOLS.has(parsed.toolName);
      return relayRpcError(
        request.id,
        mutationOutcomeIsIndeterminate
          ? RELAY_ERROR_CODES.INDETERMINATE
          : deadlineAbort.signal.aborted
            ? RELAY_ERROR_CODES.DEADLINE_EXCEEDED
            : relaySignal?.aborted
              ? RELAY_ERROR_CODES.CANCELLED
              : RELAY_ERROR_CODES.INTERNAL,
        mutationOutcomeIsIndeterminate
          ? `Daemon MCP mutation outcome is indeterminate after relay cancellation; reconcile state before retrying: ${String(error)}`
          : `Daemon MCP tool RPC failed: ${String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
      cleaningUp = true;
      void transport
        .terminateSession()
        .catch((error: unknown) => {
          this.logger.log('warn', 'daemon MCP relay session cleanup failed', {
            error: String(error),
          });
        })
        .finally(() => transport.close().catch(() => undefined));
    }
  }

  private abortPendingRelayRpcRequests(reason: string): void {
    for (const abort of this.pendingRelayRpcRequests.values()) {
      abort.abort(new Error(reason));
    }
    this.pendingRelayRpcRequests.clear();
  }

  private startControlHeartbeat(control: WebSocket): void {
    this.clearControlHeartbeat();
    this.controlHeartbeatMisses = 0;
    let durableLivenessElapsedMs = 0;
    this.controlHeartbeatInterval = setInterval(() => {
      if (this.control !== control || this.stopped || control.readyState !== WebSocket.OPEN) {
        return;
      }

      this.clearControlHeartbeatDeadline();
      durableLivenessElapsedMs += CONTROL_HEARTBEAT_INTERVAL_MS;
      // Keep the frequent text ping for the relay's non-waking auto-pong. A
      // bounded binary pulse lets OrgChannel durably record liveness when
      // Cloudflare does not expose that auto-response after hibernation,
      // without waking and rewriting the Durable Object on every heartbeat.
      control.send(encodeTunnelMessage({ type: 'control.ping' }));
      if (durableLivenessElapsedMs >= CONTROL_DURABLE_LIVENESS_INTERVAL_MS) {
        durableLivenessElapsedMs = 0;
        control.send(encodeJsonBytes({ type: 'control.ping' }));
      }
      this.controlHeartbeatDeadline = setTimeout(() => {
        if (this.control !== control || this.stopped) return;

        this.controlHeartbeatDeadline = undefined;
        this.controlHeartbeatMisses += 1;
        if (this.controlHeartbeatMisses < CONTROL_HEARTBEAT_MISSES_BEFORE_RECONNECT) {
          this.logger.log('warn', 'relay control heartbeat missed; waiting for next probe', {
            consecutiveMisses: this.controlHeartbeatMisses,
            reconnectAfterMisses: CONTROL_HEARTBEAT_MISSES_BEFORE_RECONNECT,
          });
          return;
        }

        this.logger.log('warn', 'relay control heartbeat missed; terminating socket to reconnect', {
          consecutiveMisses: this.controlHeartbeatMisses,
          reconnectAfterMisses: CONTROL_HEARTBEAT_MISSES_BEFORE_RECONNECT,
        });
        control.terminate();
      }, CONTROL_HEARTBEAT_TIMEOUT_MS);
    }, CONTROL_HEARTBEAT_INTERVAL_MS);
  }

  private clearControlHeartbeat(): void {
    if (this.controlHeartbeatInterval) {
      clearInterval(this.controlHeartbeatInterval);
      this.controlHeartbeatInterval = undefined;
    }
    this.clearControlHeartbeatDeadline();
    this.controlHeartbeatMisses = 0;
  }

  private clearControlHeartbeatDeadline(): void {
    if (this.controlHeartbeatDeadline) {
      clearTimeout(this.controlHeartbeatDeadline);
      this.controlHeartbeatDeadline = undefined;
    }
  }

  private async proxyHttp(envelope: TunnelHttpRequestEnvelope): Promise<TunnelHttpResponseEnvelope | null> {
    const upstreamUrl = new URL(envelope.path, this.config.daemonUrl);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), TUNNEL_HTTP_REQUEST_TIMEOUT_MS);
    const pending: PendingDaemonHttpRequest = { abort, canceled: false };
    this.pendingHttpRequests.set(envelope.id, pending);

    try {
      const response = await this.fetchImpl(upstreamUrl, {
        method: envelope.method,
        headers: withoutHopByHop(envelope.headers),
        body: envelope.bodyB64 ? Buffer.from(envelope.bodyB64, 'base64') : undefined,
        signal: abort.signal,
      });

      return {
        type: 'http.response',
        id: envelope.id,
        status: response.status,
        headers: serializableResponseHeaders(response.headers),
        bodyB64: (await materializedResponseBody(response)).toString('base64'),
      };
    } catch (error) {
      if (pending.canceled) {
        return null;
      }
      return {
        type: 'http.response',
        id: envelope.id,
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        bodyB64: Buffer.from(`Tunnel client failed to reach daemon: ${String(error)}\n`).toString('base64'),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async proxyAndSendHttpResponse(
    control: WebSocket,
    envelope: TunnelHttpRequestEnvelope,
  ): Promise<void> {
    let pending: PendingDaemonHttpRequest | undefined;
    try {
      const response = await this.proxyHttp(envelope);
      pending = this.pendingHttpRequests.get(envelope.id);
      if (response && !pending?.canceled) {
        try {
          await this.sendHttpResponse(control, response);
        } catch (error) {
          if (!pending?.canceled) throw error;
        }
      }
    } finally {
      if (!pending || this.pendingHttpRequests.get(envelope.id) === pending) {
        this.pendingHttpRequests.delete(envelope.id);
      }
    }
  }

  private cancelHttpRequest(message: TunnelHttpCancelEnvelope): void {
    this.httpAssembler.cancel(message.id);
    this.rejectPendingHttpResponseChunkAck(
      message.id,
      new Error(message.reason ?? 'relay cancelled HTTP response'),
    );
    const pending = this.pendingHttpRequests.get(message.id);
    if (!pending) return;

    pending.canceled = true;
    pending.abort.abort(message.reason ?? 'relay cancelled HTTP request');
  }

  private abortPendingHttpRequests(): void {
    for (const pending of this.pendingHttpRequests.values()) {
      pending.canceled = true;
      pending.abort.abort('relay control closed');
    }
    this.pendingHttpRequests.clear();
  }

  private resolveHttpResponseChunkAck(
    message: TunnelHttpResponseChunkAckEnvelope,
  ): void {
    const pending = this.pendingHttpResponseChunkAcks.get(message.id);
    if (!pending) return;
    if (pending.sequence !== message.sequence) {
      this.rejectPendingHttpResponseChunkAck(
        message.id,
        new Error('Relay acknowledged an unexpected HTTP response chunk'),
      );
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingHttpResponseChunkAcks.delete(message.id);
    pending.resolve();
  }

  private rejectPendingHttpResponseChunkAck(id: string, error: Error): void {
    const pending = this.pendingHttpResponseChunkAcks.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingHttpResponseChunkAcks.delete(id);
    pending.reject(error);
  }

  private abortPendingHttpResponseChunkAcks(reason: string): void {
    for (const id of this.pendingHttpResponseChunkAcks.keys()) {
      this.rejectPendingHttpResponseChunkAck(id, new Error(reason));
    }
  }

  private async sendHttpResponse(
    control: WebSocket,
    envelope: TunnelHttpResponseEnvelope,
  ): Promise<void> {
    if (!envelope.bodyB64) {
      control.send(encodeJsonBytes(envelope));
      return;
    }

    const envelopeWithoutBody = encodeJsonBytes({ ...envelope, bodyB64: '' });
    if (
      envelopeWithoutBody.byteLength + envelope.bodyB64.length <=
      TUNNEL_WS_FRAME_BYTE_LIMIT
    ) {
      control.send(encodeJsonBytes(envelope));
      return;
    }

    const body = Buffer.from(envelope.bodyB64, 'base64');
    if (this.pendingHttpRequests.get(envelope.id)?.canceled) return;
    control.send(encodeJsonBytes({
      type: 'http.response.start',
      id: envelope.id,
      status: envelope.status,
      headers: envelope.headers,
      totalBytes: body.byteLength,
    }));

    let sequence = 0;
    let offset = 0;
    while (offset < body.byteLength) {
      if (this.pendingHttpRequests.get(envelope.id)?.canceled) return;
      const emptyChunk = encodeJsonBytes({
        type: 'http.response.chunk',
        id: envelope.id,
        sequence,
        bodyB64: '',
      });
      const chunkBytes =
        Math.floor((TUNNEL_WS_FRAME_BYTE_LIMIT - emptyChunk.byteLength) / 4) * 3;
      if (chunkBytes <= 0) {
        throw new Error('HTTP response chunk metadata exceeded tunnel frame cap');
      }
      const chunk = body.subarray(offset, offset + chunkBytes);
      const responseChunk: TunnelHttpResponseChunkEnvelope = {
        type: 'http.response.chunk',
        id: envelope.id,
        sequence,
        bodyB64: chunk.toString('base64'),
      };
      if (this.relaySupportsHttpResponseChunkAcks) {
        await this.sendHttpResponseChunk(control, responseChunk);
      } else {
        control.send(encodeJsonBytes(responseChunk));
      }
      offset += chunk.byteLength;
      sequence += 1;
    }

    if (this.pendingHttpRequests.get(envelope.id)?.canceled) return;
    control.send(encodeJsonBytes({
      type: 'http.response.end',
      id: envelope.id,
      chunks: sequence,
    }));
  }

  private async sendHttpResponseChunk(
    control: WebSocket,
    message: TunnelHttpResponseChunkEnvelope,
  ): Promise<void> {
    if (this.pendingHttpResponseChunkAcks.has(message.id)) {
      throw new Error('HTTP response chunk acknowledgement is already pending');
    }

    const acknowledged = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rejectPendingHttpResponseChunkAck(
          message.id,
          new Error('Timed out waiting for HTTP response chunk acknowledgement'),
        );
      }, TUNNEL_HTTP_REQUEST_TIMEOUT_MS);
      this.pendingHttpResponseChunkAcks.set(message.id, {
        sequence: message.sequence,
        resolve,
        reject,
        timeout,
      });
    });

    try {
      control.send(encodeJsonBytes(message));
    } catch (error) {
      const sendError =
        error instanceof Error ? error : new Error(String(error));
      this.rejectPendingHttpResponseChunkAck(message.id, sendError);
      await acknowledged.catch(() => undefined);
      throw sendError;
    }
    await acknowledged;
  }

  private openDialback(envelope: TunnelWebSocketOpenEnvelope): void {
    // Coordinated relay wire path; see the control URL comment above.
    const daemonWsUrl = new URL(envelope.path, this.config.daemonUrl);
    daemonWsUrl.protocol = daemonWsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const daemonSocket = new WebSocket(daemonWsUrl, {
      headers: withoutHopByHop(envelope.headers),
    });

    const pooled = this.dialbackPool?.acquire() ?? null;
    const relaySocket = pooled ?? this.dialFreshRelaySocket(envelope.streamId);

    const bridge = new DialbackBridge({
      streamId: envelope.streamId,
      relaySocket,
      daemonSocket,
      logger: this.logger,
      onRetrySafeClose: (message) => this.sendControlStreamClose(message),
    });

    if (pooled) {
      // Already open + pool-hello'd: claim it for this stream now.
      this.sendDialbackClaimHello(pooled, envelope.streamId);
    } else {
      relaySocket.on('open', () =>
        this.sendDialbackClaimHello(relaySocket, envelope.streamId),
      );
    }

    bridge.start();
  }

  private dialFreshRelaySocket(streamId: string): WebSocket {
    const dialbackUrl = relayInternalUrl(this.config.relayUrl, '/__kb1_tunnel/dialback');
    dialbackUrl.searchParams.set('streamId', streamId);
    return new WebSocket(dialbackUrl, {
      headers: { authorization: `Bearer ${this.config.token}` },
    });
  }

  private openPoolRelaySocket(): WebSocket {
    const url = relayInternalUrl(this.config.relayUrl, '/__kb1_tunnel/dialback');
    url.searchParams.set('pool', '1');
    return new WebSocket(url, {
      headers: { authorization: `Bearer ${this.config.token}` },
    });
  }

  private sendDialbackPoolHello(socket: BridgeSocket): void {
    socket.send(
      encodeJsonBytes({
        type: 'ws.dialback.pool.hello',
        version: TUNNEL_PROTOCOL_VERSION,
        token: this.config.token,
      }),
    );
  }

  private sendDialbackClaimHello(socket: BridgeSocket, streamId: string): void {
    socket.send(
      encodeJsonBytes({
        type: 'ws.dialback.hello',
        version: TUNNEL_PROTOCOL_VERSION,
        token: this.config.token,
        streamId,
      }),
    );
  }

  private sendControlStreamClose(message: TunnelWebSocketCloseEnvelope): void {
    if (!this.control || this.control.readyState !== WebSocket.OPEN) {
      this.logger.log('warn', 'cannot notify relay about stale stream because control is not open', {
        streamId: message.streamId,
      });
      return;
    }

    this.control.send(encodeJsonBytes(message));
  }
}
/* v8 ignore stop */

export type BridgeSocket = {
  readonly readyState: number;
  send(data: WebSocket.RawData, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: WebSocket.RawData, isBinary: boolean) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
};

export type DialbackBridgeOptions = {
  streamId: string;
  relaySocket: BridgeSocket;
  daemonSocket: BridgeSocket;
  logger?: TunnelClientLogger;
  onRetrySafeClose?: (message: TunnelWebSocketCloseEnvelope) => void;
};

export class DialbackBridge {
  private readonly logger: TunnelClientLogger;
  private readonly pendingRelayFrames = new PendingFrameBuffer();
  private readonly pendingDaemonFrames = new PendingFrameBuffer();
  private readonly pairTimeout: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private readonly options: DialbackBridgeOptions) {
    this.logger = options.logger ?? consoleLogger;
    this.pairTimeout = setTimeout(() => {
      this.closeBoth(
        TUNNEL_CLOSE_CODES.PENDING_STREAM_TIMEOUT,
        'Timed out waiting for daemon websocket',
      );
    }, TUNNEL_PENDING_STREAM_PAIR_TIMEOUT_MS);
  }

  start(): void {
    this.options.relaySocket.on('open', () => {
      for (const frame of this.pendingDaemonFrames.drain()) {
        if (!this.sendToRelay(Buffer.from(frame), true)) return;
      }
    });

    this.options.daemonSocket.on('open', () => {
      clearTimeout(this.pairTimeout);
      for (const frame of this.pendingRelayFrames.drain()) {
        if (!this.sendToDaemon(Buffer.from(frame), true)) return;
      }
    });

    this.options.relaySocket.on('message', (data, isBinary) => {
      const frame = rawDataToBytes(data);
      if (frame.byteLength > TUNNEL_WS_FRAME_BYTE_LIMIT) {
        this.closeBoth(
          TUNNEL_CLOSE_CODES.OVERSIZED_WS_FRAME,
          'Relay websocket frame exceeded tunnel cap',
        );
        return;
      }

      if (this.options.daemonSocket.readyState === WebSocket.OPEN) {
        this.sendToDaemon(data, isBinary);
        return;
      }

      if (this.options.daemonSocket.readyState !== WebSocket.CONNECTING) {
        this.logger.log('warn', 'relay frame arrived while daemon websocket was not open', {
          streamId: this.options.streamId,
          daemonReadyState: this.options.daemonSocket.readyState,
        });
        this.closeBoth(
          TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
          'Daemon websocket was not open for relay frame',
        );
        return;
      }

      const queued = this.pendingRelayFrames.push(frame);
      if (!queued.ok) {
        this.logger.log('warn', 'dial-back pending buffer overflow', {
          streamId: this.options.streamId,
          reason: queued.reason,
          queuedFrames: queued.queuedFrames,
          queuedBytes: queued.queuedBytes,
        });
        this.closeBoth(
          TUNNEL_CLOSE_CODES.PENDING_STREAM_OVERFLOW,
          `Pending dial-back buffer exceeded ${queued.reason} cap`,
        );
      }
    });

    this.options.daemonSocket.on('message', (data, isBinary) => {
      const frame = rawDataToBytes(data);
      if (frame.byteLength > TUNNEL_WS_FRAME_BYTE_LIMIT) {
        this.closeBoth(
          TUNNEL_CLOSE_CODES.OVERSIZED_WS_FRAME,
          'Daemon websocket frame exceeded tunnel cap',
        );
        return;
      }

      if (this.options.relaySocket.readyState === WebSocket.OPEN) {
        this.sendToRelay(data, isBinary);
        return;
      }

      if (this.options.relaySocket.readyState === WebSocket.CONNECTING) {
        const queued = this.pendingDaemonFrames.push(frame);
        if (!queued.ok) {
          this.logger.log('warn', 'dial-back pending daemon buffer overflow', {
            streamId: this.options.streamId,
            reason: queued.reason,
            queuedFrames: queued.queuedFrames,
            queuedBytes: queued.queuedBytes,
          });
          this.closeBoth(
            TUNNEL_CLOSE_CODES.PENDING_STREAM_OVERFLOW,
            `Pending daemon-to-relay buffer exceeded ${queued.reason} cap`,
          );
        }
        return;
      }

      this.logger.log('warn', 'daemon frame arrived while relay dial-back was not open', {
        streamId: this.options.streamId,
        relayReadyState: this.options.relaySocket.readyState,
      });
      this.notifyRetrySafeClose('Relay dial-back socket was not open for daemon frame');
      this.closeBoth(
        TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
        'Relay dial-back socket was not open for daemon frame',
      );
    });

    this.options.relaySocket.on('close', (code, reason) => {
      clearTimeout(this.pairTimeout);
      if (this.options.daemonSocket.readyState === WebSocket.OPEN || this.options.daemonSocket.readyState === WebSocket.CONNECTING) {
        this.options.daemonSocket.close(sendableCloseCode(code), reason.toString());
      }
    });

    this.options.daemonSocket.on('close', (code, reason) => {
      clearTimeout(this.pairTimeout);
      if (this.options.relaySocket.readyState === WebSocket.OPEN || this.options.relaySocket.readyState === WebSocket.CONNECTING) {
        this.options.relaySocket.close(sendableCloseCode(code), reason.toString());
      }
    });

    this.options.relaySocket.on('error', (error) => {
      this.logger.log('warn', 'relay dial-back socket error', {
        streamId: this.options.streamId,
        error: String(error),
      });
      this.options.daemonSocket.close(1011, 'Relay dial-back failed');
    });

    this.options.daemonSocket.on('error', (error) => {
      this.logger.log('warn', 'daemon websocket error', {
        streamId: this.options.streamId,
        error: String(error),
      });
      this.options.relaySocket.close(1011, 'Daemon websocket failed');
    });
  }

  private sendToDaemon(data: WebSocket.RawData, isBinary: boolean): boolean {
    try {
      this.options.daemonSocket.send(data, { binary: isBinary });
      return true;
    } catch (error) {
      this.logger.log('warn', 'daemon websocket send failed', {
        streamId: this.options.streamId,
        error: String(error),
      });
      this.closeBoth(
        TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
        'Daemon websocket send failed; reconnect required',
      );
      return false;
    }
  }

  private sendToRelay(data: WebSocket.RawData, isBinary: boolean): boolean {
    try {
      this.options.relaySocket.send(data, { binary: isBinary });
      return true;
    } catch (error) {
      this.logger.log('warn', 'relay dial-back send failed', {
        streamId: this.options.streamId,
        error: String(error),
      });
      this.notifyRetrySafeClose('Relay dial-back send failed; reconnect required');
      this.closeBoth(
        TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
        'Relay dial-back send failed; reconnect required',
      );
      return false;
    }
  }

  private notifyRetrySafeClose(reason: string): void {
    this.options.onRetrySafeClose?.({
      type: 'ws.close',
      streamId: this.options.streamId,
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason,
    });
  }

  private closeBoth(code: number, reason: string): void {
    /* v8 ignore next -- Defensive against reciprocal close re-entry; socket close propagation covers the practical path. */
    if (this.closed) return;

    this.closed = true;
    clearTimeout(this.pairTimeout);
    this.pendingRelayFrames.clear();
    this.pendingDaemonFrames.clear();
    this.options.relaySocket.close(code, reason);
    this.options.daemonSocket.close(code, reason);
  }
}

export type PoolSocket = BridgeSocket;

export type DialbackPoolOptions = {
  size: number;
  createSocket: () => PoolSocket;
  sendPoolHello: (socket: PoolSocket) => void;
  logger?: TunnelClientLogger;
};

const WS_OPEN = 1;

export class DialbackPool {
  private readonly ready: PoolSocket[] = [];
  private warming = 0;

  constructor(private readonly options: DialbackPoolOptions) {}

  prime(): void {
    if (this.options.size <= 0) return;
    while (this.ready.length + this.warming < this.options.size) {
      this.open();
    }
  }

  acquire(): PoolSocket | null {
    let socket: PoolSocket | null = null;
    while (this.ready.length > 0) {
      const candidate = this.ready.shift() as PoolSocket;
      if (candidate.readyState === WS_OPEN) {
        socket = candidate;
        break;
      }
      // stale/dead: drop it silently
    }
    this.prime();
    return socket;
  }

  private open(): void {
    const socket = this.options.createSocket();
    this.warming += 1;
    let opened = false;
    socket.on('open', () => {
      opened = true;
      this.warming -= 1;
      this.options.sendPoolHello(socket);
      this.ready.push(socket);
    });
    const onGone = () => {
      if (!opened) {
        opened = true;
        this.warming -= 1;
      }
      const i = this.ready.indexOf(socket);
      if (i >= 0) this.ready.splice(i, 1);
      this.prime();
    };
    socket.on('close', onGone);
    socket.on('error', () => {
      /* a close event follows; cleanup happens there */
    });
  }
}

type ChunkedHttpRequestDraft = {
  start: TunnelHttpRequestStartEnvelope;
  chunks: Map<number, Buffer>;
  receivedBytes: number;
};

export class ChunkedHttpRequestAssembler {
  private readonly drafts = new Map<string, ChunkedHttpRequestDraft>();

  start(message: TunnelHttpRequestStartEnvelope): void {
    this.drafts.set(message.id, {
      start: message,
      chunks: new Map(),
      receivedBytes: 0,
    });
  }

  chunk(message: TunnelHttpRequestChunkEnvelope): void {
    const draft = this.drafts.get(message.id);
    if (!draft || draft.chunks.has(message.sequence)) return;

    const chunk = Buffer.from(message.bodyB64, 'base64');
    if (
      draft.receivedBytes + chunk.byteLength > draft.start.totalBytes ||
      draft.receivedBytes + chunk.byteLength > TUNNEL_HTTP_PENDING_BYTE_LIMIT
    ) {
      this.drafts.delete(message.id);
      return;
    }

    draft.chunks.set(message.sequence, chunk);
    draft.receivedBytes += chunk.byteLength;
  }

  end(message: TunnelHttpRequestEndEnvelope): TunnelHttpRequestEnvelope | undefined {
    const draft = this.drafts.get(message.id);
    this.drafts.delete(message.id);
    if (!draft || draft.chunks.size !== message.chunks || draft.receivedBytes !== draft.start.totalBytes) {
      return undefined;
    }

    const ordered: Buffer[] = [];
    for (let sequence = 0; sequence < message.chunks; sequence += 1) {
      const chunk = draft.chunks.get(sequence);
      if (!chunk) return undefined;
      ordered.push(chunk);
    }

    return {
      type: 'http.request',
      id: draft.start.id,
      method: draft.start.method,
      path: draft.start.path,
      headers: draft.start.headers,
      bodyB64: Buffer.concat(ordered).toString('base64'),
    };
  }

  cancel(id: string): void {
    this.drafts.delete(id);
  }
}

export function createBackoffDelay(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const baseMs = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const jitterRatio = options.jitterRatio ?? DEFAULT_BACKOFF_JITTER_RATIO;
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = exponential * jitterRatio * random();
  return Math.round(Math.min(maxMs, exponential + jitter));
}

export function sendableCloseCode(code: number): number {
  return ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999))
    ? code
    : 1011;
}

function relayRpcError(
  id: string,
  code: (typeof RELAY_ERROR_CODES)[keyof typeof RELAY_ERROR_CODES],
  message: string,
): RelayRpcResponseFrame {
  return {
    type: 'rpc.response',
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code, message },
  };
}

type ParsedMcpToolCallRpcRequest =
  | {
      ok: true;
      toolName: string;
      arguments: Record<string, unknown>;
      clientName: string;
      actorHeader: string;
    }
  | { ok: false; message: string };

function parseMcpToolCallRpcRequest(
  request: RelayRpcRequestFrame,
): ParsedMcpToolCallRpcRequest {
  if (request.payload?.encoding !== 'json' || !isRelayJsonObject(request.payload.value)) {
    return { ok: false, message: 'mcp.tool.call requires a JSON object payload' };
  }

  const toolName = request.payload.value.toolName;
  if (
    typeof toolName !== 'string'
    || toolName.length === 0
    || Buffer.byteLength(toolName, 'utf8') > MAX_MCP_TOOL_NAME_BYTES
  ) {
    return { ok: false, message: 'mcp.tool.call toolName must be a non-empty string no larger than 256 bytes' };
  }

  const args = request.payload.value.arguments;
  if (args !== undefined && !isRelayJsonObject(args)) {
    return { ok: false, message: 'mcp.tool.call arguments must be a JSON object when provided' };
  }

  const requestedClientName = request.payload.value.clientName;
  if (
    requestedClientName !== undefined
    && (
      typeof requestedClientName !== 'string'
      || requestedClientName.length === 0
      || Buffer.byteLength(requestedClientName, 'utf8') > MAX_MCP_CLIENT_NAME_BYTES
    )
  ) {
    return { ok: false, message: 'mcp.tool.call clientName must be a non-empty string no larger than 256 bytes when provided' };
  }

  const actor = request.context?.actor;
  if (!isRelayJsonObject(actor) || (actor.kind !== 'user' && actor.kind !== 'integration')) {
    return { ok: false, message: 'mcp.tool.call requires an attributed user or integration actor' };
  }
  for (const key of ['id', 'name', 'client'] as const) {
    if (actor[key] !== undefined && typeof actor[key] !== 'string') {
      return { ok: false, message: `mcp.tool.call actor.${key} must be a string when provided` };
    }
  }

  const actorHeader = JSON.stringify({
    kind: actor.kind,
    ...(typeof actor.id === 'string' ? { id: actor.id } : {}),
    ...(typeof actor.name === 'string' ? { name: actor.name } : {}),
    ...(typeof actor.client === 'string' ? { client: actor.client } : {}),
  });
  if (Buffer.byteLength(actorHeader, 'utf8') > MAX_ACTOR_HEADER_BYTES) {
    return { ok: false, message: 'mcp.tool.call actor must be no larger than 1 KiB' };
  }

  return {
    ok: true,
    toolName,
    arguments: (args ?? {}) as Record<string, unknown>,
    clientName: requestedClientName ?? MCP_RELAY_CLIENT_NAME,
    actorHeader,
  };
}

function isRelayJsonObject(value: unknown): value is RelayJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function relayInternalUrl(relayUrl: URL, internalPath: string): URL {
  const url = new URL(relayUrl.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const relayPrefix = url.pathname.replace(/\/$/, '');
  const suffix = internalPath.startsWith('/') ? internalPath : `/${internalPath}`;
  url.pathname = `${relayPrefix}${suffix}`;
  url.search = '';
  return url;
}

function rawDataToBytes(data: WebSocket.RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }

  return new TextEncoder().encode(String(data));
}

/* v8 ignore start -- Only used by the live TunnelClient HTTP response proxy path covered in Stage A drills. */
export function serializableResponseHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (
      !hopByHopHeaders.has(lowerName) &&
      !responseBodyTransformHeaders.has(lowerName)
    ) {
      output[name] = value;
    }
  }
  return output;
}
/* v8 ignore stop */

export async function materializedResponseBody(response: Response): Promise<Buffer> {
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    return gunzipSync(body);
  }
  return body;
}

export function withoutHopByHop(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase())) {
      output[name] = value;
    }
  }
  output['accept-encoding'] = 'identity';
  return output;
}

/* v8 ignore start -- Only used by the live TunnelClient control send path covered in Stage A drills. */
function encodeJsonBytes(message: Parameters<typeof encodeTunnelMessage>[0]): Buffer {
  return Buffer.from(encodeTunnelMessage(message));
}
/* v8 ignore stop */

/* v8 ignore start -- Console fallback is exercised manually through daemon opt-in logs; tests inject a logger for assertions. */
const consoleLogger: TunnelClientLogger = {
  log(level, message, fields) {
    const entry = fields ? { message, ...fields } : { message };
    if (level === 'error') {
      console.error('[tunnel-client]', entry);
      return;
    }
    if (level === 'warn') {
      console.warn('[tunnel-client]', entry);
      return;
    }
    console.log('[tunnel-client]', entry);
  },
};
/* v8 ignore stop */
