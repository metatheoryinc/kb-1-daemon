import { describe, expect, it, vi } from "vitest";
import { TUNNEL_CLOSE_CODES } from "@kb-1/tunnel-protocol";
import { StreamMux } from "./stream-mux.js";

function fakeLoopback() {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  return {
    sent: [] as Uint8Array[],
    paused: false,
    closed: null as null | { code?: number },
    readyState: 1,
    on(ev: string, cb: (...a: any[]) => void) {
      (handlers[ev] ??= []).push(cb);
    },
    emit(ev: string, ...a: any[]) {
      (handlers[ev] ?? []).forEach((cb) => cb(...a));
    },
    send(d: Uint8Array) { this.sent.push(d); },
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    close(code?: number) { this.closed = { code }; },
  };
}

const OPEN = { type: "ws.open", streamId: "s1", path: "/doc", headers: {} } as const;

describe("StreamMux", () => {
  it("opens a loopback on ws.open and pumps loopback frames out as ws.data", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({
      logger: { log: () => {} } as any,
      openLoopback: () => lb as any,
      send,
    });
    mux.handleOpen(OPEN);
    lb.emit("open");
    lb.emit("message", Buffer.from([1, 2, 3]));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ws.data", streamId: "s1", seq: 0, fin: true }),
    );
  });

  it("buffers inbound ws.data until the loopback opens, then flushes", () => {
    const lb = fakeLoopback();
    const mux = new StreamMux({
      logger: { log: () => {} } as any,
      openLoopback: () => lb as any,
      send: vi.fn(),
    });
    mux.handleOpen(OPEN);
    mux.handleData({ type: "ws.data", streamId: "s1", seq: 0, bytesB64: Buffer.from([7]).toString("base64"), fin: true });
    expect(lb.sent).toHaveLength(0); // not open yet
    lb.emit("open");
    expect(lb.sent).toHaveLength(1);
    expect(Buffer.from(lb.sent[0])).toEqual(Buffer.from([7]));
  });

  it("acks each delivered inbound frame", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    mux.handleData({ type: "ws.data", streamId: "s1", seq: 0, bytesB64: "AAAA", fin: true });
    expect(send).toHaveBeenCalledWith({ type: "ws.data.ack", streamId: "s1", seq: 0 });
  });

  it("closes the loopback and emits ws.close when the browser closes", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    mux.handleClose({ type: "ws.close", streamId: "s1", code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE, reason: "tab closed" });
    expect(lb.closed).not.toBeNull();
  });

  it("emits ws.close to control when the loopback ends", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    lb.emit("close", 1000, Buffer.from("bye"));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ws.close", streamId: "s1" }),
    );
  });

  it("acks every seq of a multi-chunk inbound message, not just the final chunk", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    mux.handleData({ type: "ws.data", streamId: "s1", seq: 0, bytesB64: "AAAA", fin: false });
    mux.handleData({ type: "ws.data", streamId: "s1", seq: 1, bytesB64: "AQ==", fin: true });
    expect(send).toHaveBeenCalledWith({ type: "ws.data.ack", streamId: "s1", seq: 0 });
    expect(send).toHaveBeenCalledWith({ type: "ws.data.ack", streamId: "s1", seq: 1 });
  });

  it("pauses the loopback when outbound backpressure exceeds the window, then resumes once acked", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({
      logger: { log: () => {} } as any,
      openLoopback: () => lb as any,
      send,
      chunkBytes: 2,
      windowBytes: 4,
    });
    mux.handleOpen(OPEN);
    lb.emit("open");

    lb.emit("message", Buffer.from([1, 2, 3, 4, 5, 6])); // 3 chunks of 2 bytes = 6 unacked > window of 4
    expect(lb.paused).toBe(true);

    mux.handleDataAck({ type: "ws.data.ack", streamId: "s1", seq: 0 }); // unacked 4, still not < window
    expect(lb.paused).toBe(true);

    mux.handleDataAck({ type: "ws.data.ack", streamId: "s1", seq: 1 }); // unacked 2, < window
    expect(lb.paused).toBe(false);
  });
});
