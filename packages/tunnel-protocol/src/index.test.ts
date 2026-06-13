import {
  PendingFrameBuffer,
  TUNNEL_CLOSE_CODES,
  TUNNEL_PENDING_STREAM_BYTE_LIMIT,
  TUNNEL_PENDING_STREAM_FRAME_LIMIT,
  TUNNEL_PROTOCOL_VERSION,
  decodeTunnelMessage,
  encodeTunnelMessage
} from "./index.js";

it("round-trips an HTTP response envelope", () => {
  const message = {
    type: "http.response",
    id: "req-1",
    status: 200,
    headers: { "content-type": "text/plain" },
    bodyB64: "b2s="
  } as const;

  expect(decodeTunnelMessage(encodeTunnelMessage(message))).toEqual(message);
});

it("round-trips control heartbeat envelopes", () => {
  const ping = { type: "control.ping" } as const;
  const pong = { type: "control.pong" } as const;

  expect(decodeTunnelMessage(encodeTunnelMessage(ping))).toEqual(ping);
  expect(decodeTunnelMessage(encodeTunnelMessage(pong))).toEqual(pong);
});

it("round-trips chunked HTTP request envelopes", () => {
  const start = {
    type: "http.request.start",
    id: "req-1",
    method: "POST",
    path: "/upload",
    headers: { "content-type": "application/octet-stream" },
    totalBytes: 262145
  } as const;
  const chunk = {
    type: "http.request.chunk",
    id: "req-1",
    sequence: 1,
    bodyB64: "AQI="
  } as const;
  const end = {
    type: "http.request.end",
    id: "req-1",
    chunks: 2
  } as const;

  expect(decodeTunnelMessage(encodeTunnelMessage(start))).toEqual(start);
  expect(decodeTunnelMessage(encodeTunnelMessage(chunk))).toEqual(chunk);
  expect(decodeTunnelMessage(encodeTunnelMessage(end))).toEqual(end);
});

it("round-trips chunked HTTP response envelopes", () => {
  const start = {
    type: "http.response.start",
    id: "req-1",
    status: 200,
    headers: { "content-type": "application/octet-stream" },
    totalBytes: 262145
  } as const;
  const chunk = {
    type: "http.response.chunk",
    id: "req-1",
    sequence: 1,
    bodyB64: "AQI="
  } as const;
  const end = {
    type: "http.response.end",
    id: "req-1",
    chunks: 2
  } as const;

  expect(decodeTunnelMessage(encodeTunnelMessage(start))).toEqual(start);
  expect(decodeTunnelMessage(encodeTunnelMessage(chunk))).toEqual(chunk);
  expect(decodeTunnelMessage(encodeTunnelMessage(end))).toEqual(end);
});

it("carries the relay prototype protocol version", () => {
  expect(TUNNEL_PROTOCOL_VERSION).toBe(2);
});

it("rejects malformed tunnel messages", () => {
  expect(() => decodeTunnelMessage("null")).toThrow(
    "Tunnel message must be an object with a type"
  );
  expect(() => decodeTunnelMessage("\"not-an-object\"")).toThrow(
    "Tunnel message must be an object with a type"
  );
  expect(() => decodeTunnelMessage("{}")).toThrow(
    "Tunnel message must be an object with a type"
  );
});

it("exports named pending stream caps and close codes", () => {
  expect(TUNNEL_PENDING_STREAM_FRAME_LIMIT).toBeGreaterThan(0);
  expect(TUNNEL_PENDING_STREAM_BYTE_LIMIT).toBeGreaterThan(0);
  expect(TUNNEL_CLOSE_CODES.PENDING_STREAM_TIMEOUT).not.toBe(
    TUNNEL_CLOSE_CODES.PENDING_STREAM_OVERFLOW
  );
});

it("uses named pending stream caps by default", () => {
  const buffer = new PendingFrameBuffer();

  expect(buffer.maxFrames).toBe(TUNNEL_PENDING_STREAM_FRAME_LIMIT);
  expect(buffer.maxBytes).toBe(TUNNEL_PENDING_STREAM_BYTE_LIMIT);
});

it("buffers and drains pending stream frames in order", () => {
  const buffer = new PendingFrameBuffer({ maxFrames: 3, maxBytes: 8 });
  const source = new Uint8Array([1, 2]);

  expect(buffer.push(source)).toMatchObject({
    ok: true,
    queuedFrames: 1,
    queuedBytes: 2
  });
  source[0] = 9;
  expect(buffer.push(new Uint8Array([3]))).toMatchObject({
    ok: true,
    queuedFrames: 2,
    queuedBytes: 3
  });

  expect(buffer.drain()).toEqual([
    new Uint8Array([1, 2]),
    new Uint8Array([3])
  ]);
  expect(buffer.frameCount).toBe(0);
  expect(buffer.byteCount).toBe(0);
});

it("rejects pending stream frames above frame and byte caps", () => {
  const frameLimited = new PendingFrameBuffer({ maxFrames: 1, maxBytes: 10 });
  expect(frameLimited.push(new Uint8Array([1]))).toMatchObject({ ok: true });
  expect(frameLimited.push(new Uint8Array([2]))).toEqual({
    ok: false,
    reason: "frames",
    queuedFrames: 1,
    queuedBytes: 1
  });

  const byteLimited = new PendingFrameBuffer({ maxFrames: 3, maxBytes: 2 });
  expect(byteLimited.push(new Uint8Array([1, 2, 3]))).toEqual({
    ok: false,
    reason: "bytes",
    queuedFrames: 0,
    queuedBytes: 0
  });

  expect(byteLimited.push(new Uint8Array([1]))).toMatchObject({
    ok: true,
    queuedFrames: 1,
    queuedBytes: 1
  });
  expect(byteLimited.push(new Uint8Array([2, 3]))).toEqual({
    ok: false,
    reason: "bytes",
    queuedFrames: 1,
    queuedBytes: 1
  });
});

it("clears pending stream frames without draining them", () => {
  const buffer = new PendingFrameBuffer({ maxFrames: 2, maxBytes: 4 });
  expect(buffer.push(new Uint8Array([1, 2]))).toMatchObject({
    ok: true,
    queuedFrames: 1,
    queuedBytes: 2
  });

  buffer.clear();

  expect(buffer.frameCount).toBe(0);
  expect(buffer.byteCount).toBe(0);
  expect(buffer.drain()).toEqual([]);
});
