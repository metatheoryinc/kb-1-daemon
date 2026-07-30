import {
  PendingFrameBuffer,
  RELAY_ERROR_CODES,
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
  type TunnelHttpResponseEnvelope,
  type TunnelWebSocketCloseEnvelope,
  type TunnelWebSocketOpenEnvelope,
} from '@kb-1/tunnel-protocol';
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
  private stopped = true;
  private reconnectAttempt = 0;

  constructor(private readonly config: TunnelClientConfig) {
    this.logger = config.logger ?? consoleLogger;
    this.fetchImpl = config.fetch ?? fetch;
    this.random = config.random ?? Math.random;
  }

  start(): void {
    if (!this.stopped) return;

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
          ...(event.resource !== undefined ? { resource: event.resource } : {}),
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
        features: [TUNNEL_FEATURES.RELAY_FRAMES_V1],
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
        this.logger.log('info', 'relay control ready', { protocolVersion: message.version });
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
        {
          const response = await this.proxyHttp(message);
          if (response) this.sendHttpResponse(control, response);
        }
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
          const response = await this.proxyHttp(assembled);
          if (response) this.sendHttpResponse(control, response);
        }
        return;
      }
      case 'http.cancel':
        this.cancelHttpRequest(message);
        return;
      case 'ws.open':
        this.openDialback(message);
        return;
    }
  }

  private async handleRelayFrame(control: WebSocket, frame: RelayFrame): Promise<void> {
    if (frame.type !== 'rpc.request') {
      this.logger.log('warn', 'relay frame type is not handled by tunnel client', { frameType: frame.type });
      return;
    }

    control.send(encodeJsonBytes({
      type: 'relay.frame',
      frame: await this.handleRelayRpcRequest(frame),
    }));
  }

  private async handleRelayRpcRequest(request: RelayRpcRequestFrame): Promise<RelayRpcResponseFrame> {
    switch (request.capability) {
      case 'vault.list':
        return this.handleVaultListRpc(request);
      default:
        return relayRpcError(request.id, RELAY_ERROR_CODES.UNKNOWN_CAPABILITY, `Unknown relay capability: ${request.capability}`);
    }
  }

  private async handleVaultListRpc(request: RelayRpcRequestFrame): Promise<RelayRpcResponseFrame> {
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(),
      request.deadlineMs ?? TUNNEL_HTTP_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await this.fetchImpl(new URL('/api/vaults', this.config.daemonUrl), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: abort.signal,
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
        abort.signal.aborted ? RELAY_ERROR_CODES.DEADLINE_EXCEEDED : RELAY_ERROR_CODES.INTERNAL,
        `Daemon vault list RPC failed: ${String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
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
      this.pendingHttpRequests.delete(envelope.id);
    }
  }

  private cancelHttpRequest(message: TunnelHttpCancelEnvelope): void {
    this.httpAssembler.cancel(message.id);
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

  private sendHttpResponse(control: WebSocket, envelope: TunnelHttpResponseEnvelope): void {
    if (!envelope.bodyB64) {
      control.send(encodeJsonBytes(envelope));
      return;
    }

    const body = Buffer.from(envelope.bodyB64, 'base64');
    if (body.byteLength <= TUNNEL_HTTP_BODY_CHUNK_BYTES) {
      control.send(encodeJsonBytes(envelope));
      return;
    }

    control.send(encodeJsonBytes({
      type: 'http.response.start',
      id: envelope.id,
      status: envelope.status,
      headers: envelope.headers,
      totalBytes: body.byteLength,
    }));

    let sequence = 0;
    for (let offset = 0; offset < body.byteLength; offset += TUNNEL_HTTP_BODY_CHUNK_BYTES) {
      control.send(encodeJsonBytes({
        type: 'http.response.chunk',
        id: envelope.id,
        sequence,
        bodyB64: body.subarray(offset, offset + TUNNEL_HTTP_BODY_CHUNK_BYTES).toString('base64'),
      }));
      sequence += 1;
    }

    control.send(encodeJsonBytes({
      type: 'http.response.end',
      id: envelope.id,
      chunks: sequence,
    }));
  }

  private openDialback(envelope: TunnelWebSocketOpenEnvelope): void {
    // Coordinated relay wire path; see the control URL comment above.
    const dialbackUrl = relayInternalUrl(this.config.relayUrl, '/__kb1_tunnel/dialback');
    dialbackUrl.searchParams.set('streamId', envelope.streamId);

    const daemonWsUrl = new URL(envelope.path, this.config.daemonUrl);
    daemonWsUrl.protocol = daemonWsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    const relaySocket = new WebSocket(dialbackUrl, {
      headers: { authorization: `Bearer ${this.config.token}` },
    });
    const daemonSocket = new WebSocket(daemonWsUrl, {
      headers: withoutHopByHop(envelope.headers),
    });
    const bridge = new DialbackBridge({
      streamId: envelope.streamId,
      relaySocket,
      daemonSocket,
      logger: this.logger,
      onRetrySafeClose: (message) => this.sendControlStreamClose(message),
    });

    relaySocket.on('open', () => {
      relaySocket.send(encodeJsonBytes({
        type: 'ws.dialback.hello',
        version: TUNNEL_PROTOCOL_VERSION,
        token: this.config.token,
        streamId: envelope.streamId,
      }));
    });

    bridge.start();
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
  return code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006
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
