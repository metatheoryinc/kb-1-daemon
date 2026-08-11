import {
  DocumentStreamCodec,
  TUNNEL_CLOSE_CODES,
  type TunnelWebSocketCloseEnvelope,
  type TunnelWebSocketDataAckEnvelope,
  type TunnelWebSocketDataEnvelope,
  type TunnelWebSocketOpenEnvelope,
} from "@kb-1/tunnel-protocol";

type LogFn = { log(level: string, message: string, fields?: unknown): void };

export type MuxLoopbackSocket = {
  on(event: string, cb: (...args: any[]) => void): void;
  send(data: Uint8Array): void;
  pause?(): void;
  resume?(): void;
  close(code?: number, reason?: string): void;
  readyState: number;
};

type MuxStream = {
  codec: DocumentStreamCodec;
  loopback: MuxLoopbackSocket;
  loopbackOpen: boolean;
  paused: boolean;
  pendingInbound: Uint8Array[];
};

const WS_OPEN = 1;

export class StreamMux {
  private readonly streams = new Map<string, MuxStream>();

  constructor(
    private readonly deps: {
      logger: LogFn;
      openLoopback: (open: TunnelWebSocketOpenEnvelope) => MuxLoopbackSocket;
      send: (
        msg:
          | TunnelWebSocketDataEnvelope
          | TunnelWebSocketDataAckEnvelope
          | TunnelWebSocketCloseEnvelope,
      ) => void;
      chunkBytes?: number;
      windowBytes?: number;
    },
  ) {}

  handleOpen(open: TunnelWebSocketOpenEnvelope): void {
    if (this.streams.has(open.streamId)) return;
    const loopback = this.deps.openLoopback(open);
    const stream: MuxStream = {
      codec: new DocumentStreamCodec(open.streamId, {
        chunkBytes: this.deps.chunkBytes,
        windowBytes: this.deps.windowBytes,
      }),
      loopback,
      loopbackOpen: false,
      paused: false,
      pendingInbound: [],
    };
    this.streams.set(open.streamId, stream);

    loopback.on("open", () => {
      stream.loopbackOpen = true;
      for (const bytes of stream.pendingInbound) this.writeLoopback(stream, bytes);
      stream.pendingInbound = [];
    });
    loopback.on("message", (data: unknown) => {
      const bytes = toBytes(data);
      if (!bytes) return;
      for (const frame of stream.codec.encode(bytes)) this.deps.send(frame);
      this.applyBackpressure(stream);
    });
    loopback.on("close", (code?: number, reason?: unknown) => {
      if (!this.streams.delete(open.streamId)) return;
      this.deps.send({
        type: "ws.close",
        streamId: open.streamId,
        code: (typeof code === "number" ? code : TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE) as never,
        reason: reasonText(reason),
      });
    });
    loopback.on("error", (error: unknown) => {
      this.deps.logger.log("warn", "stream loopback error", {
        streamId: open.streamId,
        error: String(error),
      });
    });
  }

  handleData(frame: TunnelWebSocketDataEnvelope): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    let message: Uint8Array | null;
    try {
      message = stream.codec.ingest(frame);
    } catch (error) {
      this.tearDown(frame.streamId, TUNNEL_CLOSE_CODES.OVERSIZED_WS_FRAME, String(error));
      return;
    }
    this.deps.send({ type: "ws.data.ack", streamId: frame.streamId, seq: frame.seq });
    if (message === null) return;
    if (stream.loopbackOpen) this.writeLoopback(stream, message);
    else stream.pendingInbound.push(message);
  }

  handleDataAck(ack: TunnelWebSocketDataAckEnvelope): void {
    const stream = this.streams.get(ack.streamId);
    if (!stream) return;
    stream.codec.onAck(ack.seq);
    if (stream.paused && stream.codec.canSend()) {
      stream.paused = false;
      stream.loopback.resume?.();
    }
  }

  handleClose(close: TunnelWebSocketCloseEnvelope): void {
    const stream = this.streams.get(close.streamId);
    if (!stream) return;
    this.streams.delete(close.streamId);
    if (stream.loopback.readyState === WS_OPEN) stream.loopback.close(1000, close.reason);
  }

  disposeAll(reason: string): void {
    for (const stream of this.streams.values()) {
      if (stream.loopback.readyState === WS_OPEN) stream.loopback.close(1001, reason);
    }
    this.streams.clear();
  }

  private writeLoopback(stream: MuxStream, bytes: Uint8Array): void {
    try {
      stream.loopback.send(bytes);
    } catch (error) {
      this.deps.logger.log("warn", "stream loopback send failed", { error: String(error) });
    }
  }

  private applyBackpressure(stream: MuxStream): void {
    if (!stream.codec.canSend() && !stream.paused) {
      stream.paused = true;
      stream.loopback.pause?.();
    }
  }

  private tearDown(streamId: string, code: number, reason: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    if (stream.loopback.readyState === WS_OPEN) stream.loopback.close(1002, reason);
    this.deps.send({ type: "ws.close", streamId, code: code as never, reason });
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (typeof data === "string") return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => (Buffer.isBuffer(d) ? d : Buffer.from(d))));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function reasonText(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (Buffer.isBuffer(reason)) return reason.toString();
  return "";
}
