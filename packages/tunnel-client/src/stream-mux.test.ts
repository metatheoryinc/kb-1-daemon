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
    throwOnSend: false,
    on(ev: string, cb: (...a: any[]) => void) {
      (handlers[ev] ??= []).push(cb);
    },
    emit(ev: string, ...a: any[]) {
      (handlers[ev] ?? []).forEach((cb) => cb(...a));
    },
    send(d: Uint8Array) {
      if (this.throwOnSend) throw new Error("write failed");
      this.sent.push(d);
    },
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

  it("ignores a second ws.open for an already-open stream", () => {
    const lb = fakeLoopback();
    const openLoopback = vi.fn(() => lb as any);
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback, send: vi.fn() });
    mux.handleOpen(OPEN);
    mux.handleOpen(OPEN);
    expect(openLoopback).toHaveBeenCalledTimes(1);
  });

  it("drops loopback 'message' events whose payload cannot be converted to bytes", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    lb.emit("message", 42); // not string/Buffer/ArrayBuffer/array/typed array
    expect(send).not.toHaveBeenCalled();
  });

  it("converts a string loopback message to bytes before chunking", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    lb.emit("message", "hi");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ws.data", streamId: "s1", bytesB64: Buffer.from("hi").toString("base64") }),
    );
  });

  it("converts an ArrayBuffer loopback message to bytes before chunking", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    lb.emit("message", new Uint8Array([9, 8, 7]).buffer);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ws.data", streamId: "s1", bytesB64: Buffer.from([9, 8, 7]).toString("base64") }),
    );
  });

  it("converts an array of mixed buffer/non-buffer chunks to bytes before chunking", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    lb.emit("message", [Buffer.from([1]), new Uint8Array([2])]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ws.data", streamId: "s1", bytesB64: Buffer.from([1, 2]).toString("base64") }),
    );
  });

  it("converts a plain typed-array loopback message to bytes before chunking", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    lb.emit("message", new Uint8Array([5, 6]));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ws.data", streamId: "s1", bytesB64: Buffer.from([5, 6]).toString("base64") }),
    );
  });

  it("falls back to STREAM_RETRY_SAFE and a string reason when the loopback ends without a close code", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    lb.emit("close", undefined, "server hangup");
    expect(send).toHaveBeenCalledWith({
      type: "ws.close",
      streamId: "s1",
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: "server hangup",
    });
  });

  it("uses an empty reason when the loopback close event carries no usable reason", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    lb.emit("close", 1000);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ws.close", streamId: "s1", reason: "" }),
    );
  });

  it("ignores a loopback close event for a stream already removed from the map", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    mux.handleClose({ type: "ws.close", streamId: "s1", code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE, reason: "browser closed" });
    send.mockClear();
    lb.emit("close", 1000, "late event");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not double-close the loopback when its readyState is already not open", () => {
    const lb = fakeLoopback();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    lb.readyState = 3; // e.g. CLOSED
    mux.handleClose({ type: "ws.close", streamId: "s1", code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE, reason: "tab closed" });
    expect(lb.closed).toBeNull();
  });

  it("disposeAll closes every open loopback and skips ones already not open", () => {
    const lbA = fakeLoopback();
    const lbB = fakeLoopback();
    const byStream: Record<string, any> = { a: lbA, b: lbB };
    const mux = new StreamMux({
      logger: { log: () => {} } as any,
      openLoopback: (open) => byStream[open.streamId],
      send: vi.fn(),
    });
    mux.handleOpen({ ...OPEN, streamId: "a" });
    mux.handleOpen({ ...OPEN, streamId: "b" });
    lbA.emit("open");
    lbB.emit("open");
    lbB.readyState = 3; // already closed some other way

    mux.disposeAll("shutting down");

    expect(lbA.closed).toEqual({ code: 1001 });
    expect(lbB.closed).toBeNull();
  });

  it("logs and does not throw when the loopback emits an error", () => {
    const lb = fakeLoopback();
    const log = vi.fn();
    const mux = new StreamMux({ logger: { log } as any, openLoopback: () => lb as any, send: vi.fn() });
    mux.handleOpen(OPEN);
    lb.emit("open");
    expect(() => lb.emit("error", new Error("boom"))).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      "warn",
      "stream loopback error",
      expect.objectContaining({ streamId: "s1" }),
    );
  });

  it("tears down the stream when loopback delivery of a reassembled frame fails", () => {
    const lb = fakeLoopback();
    const log = vi.fn();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    lb.emit("open");
    lb.throwOnSend = true;

    expect(() =>
      mux.handleData({ type: "ws.data", streamId: "s1", seq: 0, bytesB64: "AAAA", fin: true }),
    ).not.toThrow();

    expect(log).toHaveBeenCalledWith(
      "warn",
      "stream loopback send failed",
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ws.close", streamId: "s1" }),
    );

    // the stream is gone: further frames/close events for it are no-ops
    send.mockClear();
    expect(() =>
      mux.handleData({ type: "ws.data", streamId: "s1", seq: 1, bytesB64: "AAAA", fin: true }),
    ).not.toThrow();
    mux.handleClose({
      type: "ws.close",
      streamId: "s1",
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: "n/a",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("tears down the stream when flushing pendingInbound after loopback open fails", () => {
    const lb = fakeLoopback();
    const log = vi.fn();
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log } as any, openLoopback: () => lb as any, send });
    mux.handleOpen(OPEN);
    // buffered before the loopback is open
    mux.handleData({ type: "ws.data", streamId: "s1", seq: 0, bytesB64: "AAAA", fin: true });
    expect(lb.sent).toHaveLength(0);

    lb.throwOnSend = true;
    expect(() => lb.emit("open")).not.toThrow();

    expect(log).toHaveBeenCalledWith(
      "warn",
      "stream loopback send failed",
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ws.close", streamId: "s1" }),
    );

    send.mockClear();
    mux.handleClose({
      type: "ws.close",
      streamId: "s1",
      code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE,
      reason: "n/a",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("no-ops handleData, handleDataAck, and handleClose for an unknown stream id", () => {
    const send = vi.fn();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => fakeLoopback() as any, send });
    expect(() =>
      mux.handleData({ type: "ws.data", streamId: "ghost", seq: 0, bytesB64: "AAAA", fin: true }),
    ).not.toThrow();
    expect(() => mux.handleDataAck({ type: "ws.data.ack", streamId: "ghost", seq: 0 })).not.toThrow();
    expect(() =>
      mux.handleClose({ type: "ws.close", streamId: "ghost", code: TUNNEL_CLOSE_CODES.STREAM_RETRY_SAFE, reason: "n/a" }),
    ).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not resume the loopback on ack when it was never paused", () => {
    const lb = fakeLoopback();
    const mux = new StreamMux({ logger: { log: () => {} } as any, openLoopback: () => lb as any, send: vi.fn() });
    mux.handleOpen(OPEN);
    lb.emit("open");
    mux.handleDataAck({ type: "ws.data.ack", streamId: "s1", seq: 0 });
    expect(lb.paused).toBe(false);
  });
});
