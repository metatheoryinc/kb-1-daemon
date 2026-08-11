export const TUNNEL_PROTOCOL_VERSION = 3 as const;

export type TunnelProtocolVersion = typeof TUNNEL_PROTOCOL_VERSION;

export type TunnelRole = "control" | "dialback";

export const RELAY_TRANSPORT_PROTOCOL_VERSION = 1 as const;

export type RelayTransportProtocolVersion =
  typeof RELAY_TRANSPORT_PROTOCOL_VERSION;

export const TUNNEL_PENDING_STREAM_FRAME_LIMIT = 64 as const;
export const TUNNEL_PENDING_STREAM_BYTE_LIMIT = 1024 * 1024;
export const TUNNEL_PENDING_STREAM_PAIR_TIMEOUT_MS = 10_000 as const;
export const TUNNEL_HTTP_PENDING_REQUEST_LIMIT = 128 as const;
export const TUNNEL_HTTP_PENDING_BYTE_LIMIT = 8 * 1024 * 1024;
export const TUNNEL_HTTP_REQUEST_TIMEOUT_MS = 15_000 as const;
export const TUNNEL_HTTP_BODY_CHUNK_BYTES = 256 * 1024;
export const TUNNEL_WS_FRAME_BYTE_LIMIT = 256 * 1024;
// A ws.data chunk is base64-encoded (~4/3 inflation) and wrapped in a small
// JSON envelope; size the raw chunk so the encoded frame stays under the cap,
// mirroring how sendHttpResponse derives its chunk size from the frame limit.
export const TUNNEL_WS_DATA_CHUNK_BYTES =
  Math.floor((TUNNEL_WS_FRAME_BYTE_LIMIT - 1024) / 4) * 3;
// Bounded per-stream unacked-byte send window (backpressure).
export const TUNNEL_WS_DATA_WINDOW_BYTES = 4 * 1024 * 1024;
// Cap a single reassembled logical document message (missing `fin` guard).
export const TUNNEL_WS_DATA_MESSAGE_BYTE_LIMIT = 8 * 1024 * 1024;
export const RELAY_FRAME_BYTE_LIMIT = 256 * 1024;
export const RELAY_PENDING_REQUEST_LIMIT = 128 as const;
export const RELAY_DEFAULT_REQUEST_TIMEOUT_MS = 15_000 as const;

export const TUNNEL_FEATURES = {
  RELAY_FRAMES_V1: "relay.frame.v1",
  VAULT_CONTENT_EVENTS_V1: "relay.vault-content-events.v1",
  VAULT_CONTENT_EVENTS_V2: "relay.vault-content-events.v2",
  MCP_TOOL_CALL_BOUNDED_RESULTS_V1:
    "relay.mcp-tool-call.bounded-results.v1",
  HTTP_RESPONSE_CHUNK_ACKS_V1: "relay.http-response-chunk-acks.v1"
} as const;

export type TunnelFeature = (typeof TUNNEL_FEATURES)[keyof typeof TUNNEL_FEATURES];

export const RELAY_ERROR_CODES = {
  BAD_MESSAGE: "bad-message",
  UNSUPPORTED_VERSION: "unsupported-version",
  UNKNOWN_CAPABILITY: "unknown-capability",
  UNAUTHORIZED: "unauthorized",
  DEADLINE_EXCEEDED: "deadline-exceeded",
  CANCELLED: "cancelled",
  INDETERMINATE: "indeterminate",
  PAYLOAD_TOO_LARGE: "payload-too-large",
  BACKPRESSURE: "backpressure",
  INTERNAL: "internal"
} as const;

export type RelayErrorCode =
  (typeof RELAY_ERROR_CODES)[keyof typeof RELAY_ERROR_CODES];

export const RELAY_STREAM_CLOSE_CODES = {
  NORMAL: "normal",
  CANCELLED: "cancelled",
  DEADLINE_EXCEEDED: "deadline-exceeded",
  PAYLOAD_TOO_LARGE: "payload-too-large",
  BACKPRESSURE: "backpressure",
  BAD_MESSAGE: "bad-message",
  INTERNAL: "internal"
} as const;

export type RelayStreamCloseCode =
  (typeof RELAY_STREAM_CLOSE_CODES)[keyof typeof RELAY_STREAM_CLOSE_CODES];

export const TUNNEL_CLOSE_CODES = {
  CONTROL_REPLACED: 4000,
  STREAM_RETRY_SAFE: 4001,
  PENDING_STREAM_OVERFLOW: 4002,
  PENDING_STREAM_TIMEOUT: 4003,
  OVERSIZED_WS_FRAME: 4004,
  BAD_PROTOCOL: 4005,
  UNAUTHORIZED: 4006,
  UNKNOWN_STREAM: 4007
} as const;

export type TunnelCloseCode =
  (typeof TUNNEL_CLOSE_CODES)[keyof typeof TUNNEL_CLOSE_CODES];

export type RelayJsonPrimitive = string | number | boolean | null;

export type RelayJsonValue =
  | RelayJsonPrimitive
  | RelayJsonValue[]
  | { [key: string]: RelayJsonValue };

export type RelayJsonObject = { [key: string]: RelayJsonValue };

export type RelayJsonPayload = {
  encoding: "json";
  value: RelayJsonValue;
};

export type RelayBinaryPayload = {
  encoding: "base64";
  dataB64: string;
};

export type RelayPayload = RelayJsonPayload | RelayBinaryPayload;

export type RelayFrameError = {
  code: RelayErrorCode;
  message: string;
  data?: RelayJsonValue;
};

export type RelayRpcRequestFrame = {
  type: "rpc.request";
  version: RelayTransportProtocolVersion;
  id: string;
  capability: string;
  deadlineMs?: number;
  payload?: RelayPayload;
  context?: RelayJsonObject;
};

export type RelayRpcResponseFrame =
  | {
      type: "rpc.response";
      version: RelayTransportProtocolVersion;
      id: string;
      ok: true;
      payload: RelayPayload;
    }
  | {
      type: "rpc.response";
      version: RelayTransportProtocolVersion;
      id: string;
      ok: false;
      error: RelayFrameError;
    };

export type RelayStreamOpenFrame = {
  type: "stream.open";
  version: RelayTransportProtocolVersion;
  streamId: string;
  capability: string;
  payload?: RelayPayload;
  context?: RelayJsonObject;
};

export type RelayStreamDataFrame = {
  type: "stream.data";
  version: RelayTransportProtocolVersion;
  streamId: string;
  sequence: number;
  payload: RelayPayload;
};

export type RelayStreamCloseFrame = {
  type: "stream.close";
  version: RelayTransportProtocolVersion;
  streamId: string;
  code: RelayStreamCloseCode;
  reason?: string;
};

export type RelayEventFrame = {
  type: "event";
  version: RelayTransportProtocolVersion;
  topic: string;
  id?: string;
  payload?: RelayPayload;
  resource?: RelayJsonObject;
};

export type RelayCancelTarget =
  | { kind: "rpc"; id: string }
  | { kind: "stream"; streamId: string };

export type RelayCancelFrame = {
  type: "cancel";
  version: RelayTransportProtocolVersion;
  target: RelayCancelTarget;
  reason?: string;
};

export type RelayErrorFrame = {
  type: "error";
  version: RelayTransportProtocolVersion;
  error: RelayFrameError;
  target?: RelayCancelTarget;
};

export type RelayFrame =
  | RelayRpcRequestFrame
  | RelayRpcResponseFrame
  | RelayStreamOpenFrame
  | RelayStreamDataFrame
  | RelayStreamCloseFrame
  | RelayEventFrame
  | RelayCancelFrame
  | RelayErrorFrame;

export type RelayFrameCodecOptions = {
  maxBytes?: number;
};

export type PendingFrameBufferOverflowReason = "frames" | "bytes";

export type PendingFrameBufferPushResult =
  | { ok: true; queuedFrames: number; queuedBytes: number }
  | {
      ok: false;
      reason: PendingFrameBufferOverflowReason;
      queuedFrames: number;
      queuedBytes: number;
    };

export type PendingFrameBufferOptions = {
  maxFrames?: number;
  maxBytes?: number;
};

export class PendingFrameBuffer {
  readonly maxFrames: number;
  readonly maxBytes: number;
  private readonly frames: Uint8Array[] = [];
  private queuedBytes = 0;

  constructor(options: PendingFrameBufferOptions = {}) {
    this.maxFrames = options.maxFrames ?? TUNNEL_PENDING_STREAM_FRAME_LIMIT;
    this.maxBytes = options.maxBytes ?? TUNNEL_PENDING_STREAM_BYTE_LIMIT;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get byteCount(): number {
    return this.queuedBytes;
  }

  push(frame: Uint8Array): PendingFrameBufferPushResult {
    if (this.frames.length + 1 > this.maxFrames) {
      return {
        ok: false,
        reason: "frames",
        queuedFrames: this.frameCount,
        queuedBytes: this.byteCount
      };
    }

    if (this.queuedBytes + frame.byteLength > this.maxBytes) {
      return {
        ok: false,
        reason: "bytes",
        queuedFrames: this.frameCount,
        queuedBytes: this.byteCount
      };
    }

    const copy = new Uint8Array(frame.byteLength);
    copy.set(frame);
    this.frames.push(copy);
    this.queuedBytes += copy.byteLength;
    return {
      ok: true,
      queuedFrames: this.frameCount,
      queuedBytes: this.byteCount
    };
  }

  drain(): Uint8Array[] {
    const drained = this.frames.splice(0);
    this.queuedBytes = 0;
    return drained;
  }

  clear(): void {
    this.frames.length = 0;
    this.queuedBytes = 0;
  }
}

export type RelayPendingRequestAddResult =
  | { ok: true; pending: number; deadlineAt: number }
  | { ok: false; reason: "duplicate" | "limit"; pending: number };

export type RelayPendingRequestTableOptions = {
  maxPending?: number;
  defaultTimeoutMs?: number;
  now?: () => number;
};

export type RelayPendingRequestAddOptions = {
  timeoutMs?: number;
  deadlineAt?: number;
};

export class RelayPendingRequestTable {
  readonly maxPending: number;
  readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly deadlines = new Map<string, number>();

  constructor(options: RelayPendingRequestTableOptions = {}) {
    this.maxPending = options.maxPending ?? RELAY_PENDING_REQUEST_LIMIT;
    this.defaultTimeoutMs =
      options.defaultTimeoutMs ?? RELAY_DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.deadlines.size;
  }

  add(
    id: string,
    options: RelayPendingRequestAddOptions = {}
  ): RelayPendingRequestAddResult {
    if (this.deadlines.has(id)) {
      return { ok: false, reason: "duplicate", pending: this.size };
    }

    if (this.deadlines.size >= this.maxPending) {
      return { ok: false, reason: "limit", pending: this.size };
    }

    const deadlineAt =
      options.deadlineAt ?? this.now() + (options.timeoutMs ?? this.defaultTimeoutMs);
    this.deadlines.set(id, deadlineAt);
    return { ok: true, pending: this.size, deadlineAt };
  }

  has(id: string): boolean {
    return this.deadlines.has(id);
  }

  deadlineFor(id: string): number | null {
    return this.deadlines.get(id) ?? null;
  }

  resolve(id: string): boolean {
    return this.deadlines.delete(id);
  }

  cancel(id: string): boolean {
    return this.deadlines.delete(id);
  }

  expire(now = this.now()): string[] {
    const expired: string[] = [];
    for (const [id, deadlineAt] of this.deadlines) {
      if (deadlineAt <= now) {
        expired.push(id);
        this.deadlines.delete(id);
      }
    }
    return expired;
  }

  clear(): void {
    this.deadlines.clear();
  }
}

export type TunnelControlClientHello = {
  type: "control.hello";
  version: TunnelProtocolVersion;
  token: string;
  daemonVersion?: string;
  daemonBuild?: string;
  daemonInstanceId?: string;
  vaultMutationEpoch?: number;
  features?: readonly TunnelFeature[];
};

export type TunnelControlServerReady = {
  type: "control.ready";
  version: TunnelProtocolVersion;
  features?: readonly TunnelFeature[];
};

export type TunnelControlPing = {
  type: "control.ping";
};

export type TunnelControlPong = {
  type: "control.pong";
};

export type TunnelControlServerError = {
  type: "control.error";
  code: "unauthorized" | "unsupported-version" | "bad-message" | "relay-error";
  message: string;
};

export type TunnelHttpRequestEnvelope = {
  type: "http.request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyB64: string | null;
};

export type TunnelHttpRequestStartEnvelope = {
  type: "http.request.start";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  totalBytes: number;
};

export type TunnelHttpRequestChunkEnvelope = {
  type: "http.request.chunk";
  id: string;
  sequence: number;
  bodyB64: string;
};

export type TunnelHttpRequestEndEnvelope = {
  type: "http.request.end";
  id: string;
  chunks: number;
};

export type TunnelHttpCancelEnvelope = {
  type: "http.cancel";
  id: string;
  reason?: string;
};

export type TunnelHttpResponseEnvelope = {
  type: "http.response";
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyB64: string | null;
};

export type TunnelHttpResponseStartEnvelope = {
  type: "http.response.start";
  id: string;
  status: number;
  headers: Record<string, string>;
  totalBytes: number;
};

export type TunnelHttpResponseChunkEnvelope = {
  type: "http.response.chunk";
  id: string;
  sequence: number;
  bodyB64: string;
};

export type TunnelHttpResponseChunkAckEnvelope = {
  type: "http.response.chunk.ack";
  id: string;
  sequence: number;
};

export type TunnelHttpResponseEndEnvelope = {
  type: "http.response.end";
  id: string;
  chunks: number;
};

export type TunnelWebSocketOpenEnvelope = {
  type: "ws.open";
  streamId: string;
  path: string;
  headers: Record<string, string>;
};

export type TunnelWebSocketDialbackHello = {
  type: "ws.dialback.hello";
  version: TunnelProtocolVersion;
  token: string;
  streamId: string;
};

export type TunnelWebSocketDialbackPoolHello = {
  type: "ws.dialback.pool.hello";
  version: TunnelProtocolVersion;
  token: string;
};

export type TunnelWebSocketCloseEnvelope = {
  type: "ws.close";
  streamId: string;
  code: TunnelCloseCode;
  reason: string;
};

export type TunnelWebSocketDataEnvelope = {
  type: "ws.data";
  streamId: string;
  seq: number;
  bytesB64: string;
  fin: boolean;
};

export type TunnelWebSocketDataAckEnvelope = {
  type: "ws.data.ack";
  streamId: string;
  seq: number;
};

export type TunnelRelayFrameEnvelope = {
  type: "relay.frame";
  frame: RelayFrame;
};

export type TunnelControlClientMessage =
  | TunnelControlClientHello
  | TunnelControlPing
  | TunnelWebSocketCloseEnvelope
  | TunnelWebSocketDataEnvelope
  | TunnelWebSocketDataAckEnvelope
  | TunnelRelayFrameEnvelope
  | TunnelHttpResponseEnvelope
  | TunnelHttpResponseStartEnvelope
  | TunnelHttpResponseChunkEnvelope
  | TunnelHttpResponseEndEnvelope;

export type TunnelControlServerMessage =
  | TunnelControlServerReady
  | TunnelControlPong
  | TunnelControlServerError
  | TunnelRelayFrameEnvelope
  | TunnelHttpRequestEnvelope
  | TunnelHttpRequestStartEnvelope
  | TunnelHttpRequestChunkEnvelope
  | TunnelHttpRequestEndEnvelope
  | TunnelHttpCancelEnvelope
  | TunnelHttpResponseChunkAckEnvelope
  | TunnelWebSocketOpenEnvelope
  | TunnelWebSocketCloseEnvelope
  | TunnelWebSocketDataEnvelope
  | TunnelWebSocketDataAckEnvelope;

export type TunnelDialbackClientMessage =
  | TunnelWebSocketDialbackHello
  | TunnelWebSocketDialbackPoolHello;

export type TunnelJsonMessage =
  | TunnelControlClientMessage
  | TunnelControlServerMessage
  | TunnelDialbackClientMessage;

export function encodeTunnelMessage(message: TunnelJsonMessage): string {
  return JSON.stringify(message);
}

export function decodeTunnelMessage(data: string): TunnelJsonMessage {
  const parsed: unknown = JSON.parse(data);

  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    throw new Error("Tunnel message must be an object with a type");
  }

  return parsed as TunnelJsonMessage;
}

export function encodeRelayFrame(frame: RelayFrame): string {
  return JSON.stringify(frame);
}

export function decodeRelayFrame(
  data: string,
  options: RelayFrameCodecOptions = {}
): RelayFrame {
  assertRelayFrameSize(data, options);
  return parseRelayFrame(JSON.parse(data));
}

export function relayFrameByteLength(data: string): number {
  return new TextEncoder().encode(data).byteLength;
}

export function assertRelayFrameSize(
  data: string,
  options: RelayFrameCodecOptions = {}
): void {
  const maxBytes = options.maxBytes ?? RELAY_FRAME_BYTE_LIMIT;
  if (relayFrameByteLength(data) > maxBytes) {
    throw new Error("Relay frame exceeds byte limit");
  }
}

export function parseRelayFrame(frame: unknown): RelayFrame {
  if (!isRecord(frame)) {
    throw new Error("Relay frame must be an object");
  }

  const type = expectString(frame.type, "type");
  expectVersion(frame.version);

  switch (type) {
    case "rpc.request":
      return parseRelayRpcRequestFrame(frame);
    case "rpc.response":
      return parseRelayRpcResponseFrame(frame);
    case "stream.open":
      return parseRelayStreamOpenFrame(frame);
    case "stream.data":
      return parseRelayStreamDataFrame(frame);
    case "stream.close":
      return parseRelayStreamCloseFrame(frame);
    case "event":
      return parseRelayEventFrame(frame);
    case "cancel":
      return parseRelayCancelFrame(frame);
    case "error":
      return parseRelayErrorFrame(frame);
    default:
      throw new Error(`Unsupported relay frame type: ${type}`);
  }
}

function parseRelayRpcRequestFrame(
  frame: Record<string, unknown>
): RelayRpcRequestFrame {
  return {
    type: "rpc.request",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    id: expectNonEmptyString(frame.id, "id"),
    capability: expectNonEmptyString(frame.capability, "capability"),
    ...(frame.deadlineMs === undefined
      ? {}
      : { deadlineMs: expectPositiveInteger(frame.deadlineMs, "deadlineMs") }),
    ...(frame.payload === undefined
      ? {}
      : { payload: expectRelayPayload(frame.payload, "payload") }),
    ...(frame.context === undefined
      ? {}
      : { context: expectRelayJsonObject(frame.context, "context") })
  };
}

function parseRelayRpcResponseFrame(
  frame: Record<string, unknown>
): RelayRpcResponseFrame {
  const base = {
    type: "rpc.response" as const,
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    id: expectNonEmptyString(frame.id, "id")
  };

  if (frame.ok === true) {
    return {
      ...base,
      ok: true,
      payload: expectRelayPayload(frame.payload, "payload")
    };
  }

  if (frame.ok === false) {
    return {
      ...base,
      ok: false,
      error: expectRelayFrameError(frame.error, "error")
    };
  }

  throw new Error("Relay rpc.response ok must be boolean");
}

function parseRelayStreamOpenFrame(
  frame: Record<string, unknown>
): RelayStreamOpenFrame {
  return {
    type: "stream.open",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    streamId: expectNonEmptyString(frame.streamId, "streamId"),
    capability: expectNonEmptyString(frame.capability, "capability"),
    ...(frame.payload === undefined
      ? {}
      : { payload: expectRelayPayload(frame.payload, "payload") }),
    ...(frame.context === undefined
      ? {}
      : { context: expectRelayJsonObject(frame.context, "context") })
  };
}

function parseRelayStreamDataFrame(
  frame: Record<string, unknown>
): RelayStreamDataFrame {
  return {
    type: "stream.data",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    streamId: expectNonEmptyString(frame.streamId, "streamId"),
    sequence: expectNonNegativeInteger(frame.sequence, "sequence"),
    payload: expectRelayPayload(frame.payload, "payload")
  };
}

function parseRelayStreamCloseFrame(
  frame: Record<string, unknown>
): RelayStreamCloseFrame {
  return {
    type: "stream.close",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    streamId: expectNonEmptyString(frame.streamId, "streamId"),
    code: expectRelayStreamCloseCode(frame.code, "code"),
    ...(frame.reason === undefined
      ? {}
      : { reason: expectString(frame.reason, "reason") })
  };
}

function parseRelayEventFrame(frame: Record<string, unknown>): RelayEventFrame {
  return {
    type: "event",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    topic: expectNonEmptyString(frame.topic, "topic"),
    ...(frame.id === undefined ? {} : { id: expectNonEmptyString(frame.id, "id") }),
    ...(frame.payload === undefined
      ? {}
      : { payload: expectRelayPayload(frame.payload, "payload") }),
    ...(frame.resource === undefined
      ? {}
      : { resource: expectRelayJsonObject(frame.resource, "resource") })
  };
}

function parseRelayCancelFrame(
  frame: Record<string, unknown>
): RelayCancelFrame {
  return {
    type: "cancel",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    target: expectRelayCancelTarget(frame.target, "target"),
    ...(frame.reason === undefined
      ? {}
      : { reason: expectString(frame.reason, "reason") })
  };
}

function parseRelayErrorFrame(frame: Record<string, unknown>): RelayErrorFrame {
  return {
    type: "error",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    error: expectRelayFrameError(frame.error, "error"),
    ...(frame.target === undefined
      ? {}
      : { target: expectRelayCancelTarget(frame.target, "target") })
  };
}

function expectVersion(version: unknown): void {
  if (version !== RELAY_TRANSPORT_PROTOCOL_VERSION) {
    throw new Error("Unsupported relay protocol version");
  }
}

function expectRelayPayload(value: unknown, field: string): RelayPayload {
  if (!isRecord(value)) {
    throw new Error(`Relay ${field} must be an object`);
  }

  if (value.encoding === "json") {
    if (!("value" in value) || !isRelayJsonValue(value.value)) {
      throw new Error(`Relay ${field}.value must be JSON-compatible`);
    }
    return { encoding: "json", value: value.value };
  }

  if (value.encoding === "base64") {
    return {
      encoding: "base64",
      dataB64: expectBase64(value.dataB64, `${field}.dataB64`)
    };
  }

  throw new Error(`Relay ${field}.encoding must be json or base64`);
}

function expectRelayFrameError(value: unknown, field: string): RelayFrameError {
  if (!isRecord(value)) {
    throw new Error(`Relay ${field} must be an object`);
  }

  return {
    code: expectRelayErrorCode(value.code, `${field}.code`),
    message: expectNonEmptyString(value.message, `${field}.message`),
    ...(value.data === undefined
      ? {}
      : { data: expectRelayJsonValue(value.data, `${field}.data`) })
  };
}

function expectRelayCancelTarget(
  value: unknown,
  field: string
): RelayCancelTarget {
  if (!isRecord(value)) {
    throw new Error(`Relay ${field} must be an object`);
  }

  if (value.kind === "rpc") {
    return { kind: "rpc", id: expectNonEmptyString(value.id, `${field}.id`) };
  }

  if (value.kind === "stream") {
    return {
      kind: "stream",
      streamId: expectNonEmptyString(value.streamId, `${field}.streamId`)
    };
  }

  throw new Error(`Relay ${field}.kind must be rpc or stream`);
}

function expectRelayJsonObject(
  value: unknown,
  field: string
): RelayJsonObject {
  if (!isPlainRecord(value) || !isRelayJsonValue(value)) {
    throw new Error(`Relay ${field} must be a JSON object`);
  }
  return value as RelayJsonObject;
}

function expectRelayJsonValue(value: unknown, field: string): RelayJsonValue {
  if (!isRelayJsonValue(value)) {
    throw new Error(`Relay ${field} must be JSON-compatible`);
  }
  return value;
}

function expectRelayErrorCode(value: unknown, field: string): RelayErrorCode {
  if (
    typeof value === "string" &&
    Object.values(RELAY_ERROR_CODES).includes(value as RelayErrorCode)
  ) {
    return value as RelayErrorCode;
  }

  throw new Error(`Relay ${field} is not a known error code`);
}

function expectRelayStreamCloseCode(
  value: unknown,
  field: string
): RelayStreamCloseCode {
  if (
    typeof value === "string" &&
    Object.values(RELAY_STREAM_CLOSE_CODES).includes(value as RelayStreamCloseCode)
  ) {
    return value as RelayStreamCloseCode;
  }

  throw new Error(`Relay ${field} is not a known stream close code`);
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Relay ${field} must be a string`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, field: string): string {
  const stringValue = expectString(value, field);
  if (stringValue.length === 0) {
    throw new Error(`Relay ${field} must not be empty`);
  }
  return stringValue;
}

function expectNonNegativeInteger(value: unknown, field: string): number {
  if (Number.isInteger(value) && typeof value === "number" && value >= 0) {
    return value;
  }
  throw new Error(`Relay ${field} must be a non-negative integer`);
}

function expectPositiveInteger(value: unknown, field: string): number {
  if (Number.isInteger(value) && typeof value === "number" && value > 0) {
    return value;
  }
  throw new Error(`Relay ${field} must be a positive integer`);
}

function expectBase64(value: unknown, field: string): string {
  const stringValue = expectString(value, field);
  if (stringValue.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(stringValue)) {
    throw new Error(`Relay ${field} must be base64`);
  }
  return stringValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRelayJsonValue(value: unknown): value is RelayJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isRelayJsonValue);
  }

  if (isPlainRecord(value)) {
    return Object.values(value).every(isRelayJsonValue);
  }

  return false;
}
