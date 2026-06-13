export const TUNNEL_PROTOCOL_VERSION = 2 as const;

export type TunnelProtocolVersion = typeof TUNNEL_PROTOCOL_VERSION;

export type TunnelRole = "control" | "dialback";

export const TUNNEL_PENDING_STREAM_FRAME_LIMIT = 64 as const;
export const TUNNEL_PENDING_STREAM_BYTE_LIMIT = 1024 * 1024;
export const TUNNEL_PENDING_STREAM_PAIR_TIMEOUT_MS = 10_000 as const;
export const TUNNEL_HTTP_PENDING_REQUEST_LIMIT = 128 as const;
export const TUNNEL_HTTP_PENDING_BYTE_LIMIT = 8 * 1024 * 1024;
export const TUNNEL_HTTP_REQUEST_TIMEOUT_MS = 15_000 as const;
export const TUNNEL_HTTP_BODY_CHUNK_BYTES = 256 * 1024;
export const TUNNEL_WS_FRAME_BYTE_LIMIT = 256 * 1024;

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

export type TunnelControlClientHello = {
  type: "control.hello";
  version: TunnelProtocolVersion;
  token: string;
};

export type TunnelControlServerReady = {
  type: "control.ready";
  version: TunnelProtocolVersion;
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

export type TunnelControlClientMessage =
  | TunnelControlClientHello
  | TunnelControlPing
  | TunnelHttpResponseEnvelope
  | TunnelHttpResponseStartEnvelope
  | TunnelHttpResponseChunkEnvelope
  | TunnelHttpResponseEndEnvelope;

export type TunnelControlServerMessage =
  | TunnelControlServerReady
  | TunnelControlPong
  | TunnelControlServerError
  | TunnelHttpRequestEnvelope
  | TunnelHttpRequestStartEnvelope
  | TunnelHttpRequestChunkEnvelope
  | TunnelHttpRequestEndEnvelope
  | TunnelWebSocketOpenEnvelope;

export type TunnelDialbackClientMessage = TunnelWebSocketDialbackHello;

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
