import {
  PendingFrameBuffer,
  RELAY_DEFAULT_REQUEST_TIMEOUT_MS,
  RELAY_ERROR_CODES,
  RELAY_FRAME_BYTE_LIMIT,
  RELAY_PENDING_REQUEST_LIMIT,
  RELAY_STREAM_CLOSE_CODES,
  RELAY_TRANSPORT_PROTOCOL_VERSION,
  RelayPendingRequestTable,
  assertRelayFrameSize,
  parseRelayFrame,
  relayFrameByteLength,
  TUNNEL_CLOSE_CODES,
  TUNNEL_FEATURES,
  TUNNEL_PENDING_STREAM_BYTE_LIMIT,
  TUNNEL_PENDING_STREAM_FRAME_LIMIT,
  TUNNEL_PROTOCOL_VERSION,
  decodeRelayFrame,
  decodeTunnelMessage,
  encodeRelayFrame,
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

it("round-trips control hello feature advertisement", () => {
  const hello = {
    type: "control.hello",
    version: TUNNEL_PROTOCOL_VERSION,
    token: "test-token",
    daemonVersion: "0.1.0",
    daemonBuild: "registry.example/kb1d@sha256:abc123",
    daemonInstanceId: "instance-1",
    vaultMutationEpoch: 7,
    features: [
      TUNNEL_FEATURES.RELAY_FRAMES_V1,
      TUNNEL_FEATURES.VAULT_CONTENT_EVENTS_V1,
      TUNNEL_FEATURES.VAULT_CONTENT_EVENTS_V2,
      TUNNEL_FEATURES.MCP_TOOL_CALL_BOUNDED_RESULTS_V1
    ]
  } as const;

  expect(decodeTunnelMessage(encodeTunnelMessage(hello))).toEqual(hello);
});

it("round-trips dialback pool hello", () => {
  const hello = {
    type: "ws.dialback.pool.hello",
    version: TUNNEL_PROTOCOL_VERSION,
    token: "test-token"
  } as const;

  expect(decodeTunnelMessage(encodeTunnelMessage(hello))).toEqual(hello);
});

it("round-trips typed relay frames over the tunnel control socket", () => {
  const message = {
    type: "relay.frame",
    frame: {
      type: "rpc.request",
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: "rpc-1",
      capability: "vault.list",
      deadlineMs: 1_000
    }
  } as const;

  expect(decodeTunnelMessage(encodeTunnelMessage(message))).toEqual(message);
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

it("round-trips HTTP cancellation envelopes", () => {
  const cancel = {
    type: "http.cancel",
    id: "req-1",
    reason: "browser timeout"
  } as const;

  expect(decodeTunnelMessage(encodeTunnelMessage(cancel))).toEqual(cancel);
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

it("defines an explicit indeterminate mutation outcome", () => {
  expect(RELAY_ERROR_CODES.INDETERMINATE).toBe("indeterminate");
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

it("round-trips relay rpc request and response frames", () => {
  const request = {
    type: "rpc.request",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    id: "req-1",
    capability: "vault.file.read",
    deadlineMs: 5000,
    payload: {
      encoding: "json",
      value: { vaultSlug: "demo-vault", path: "README.md" }
    },
    context: {
      actorId: "user-1",
      orgId: "org-1"
    }
  } as const;
  const success = {
    type: "rpc.response",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    id: "req-1",
    ok: true,
    payload: {
      encoding: "base64",
      dataB64: "b2s="
    }
  } as const;
  const failure = {
    type: "rpc.response",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    id: "req-2",
    ok: false,
    error: {
      code: RELAY_ERROR_CODES.DEADLINE_EXCEEDED,
      message: "Request timed out",
      data: { deadlineMs: 5000 }
    }
  } as const;

  expect(decodeRelayFrame(encodeRelayFrame(request))).toEqual(request);
  expect(decodeRelayFrame(encodeRelayFrame(success))).toEqual(success);
  expect(decodeRelayFrame(encodeRelayFrame(failure))).toEqual(failure);
});

it("round-trips relay stream, event, cancel, and error frames", () => {
  const open = {
    type: "stream.open",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    streamId: "stream-1",
    capability: "doc.sync",
    payload: {
      encoding: "json",
      value: { path: "README.md" }
    }
  } as const;
  const data = {
    type: "stream.data",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    streamId: "stream-1",
    sequence: 0,
    payload: {
      encoding: "base64",
      dataB64: "AQI="
    }
  } as const;
  const close = {
    type: "stream.close",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    streamId: "stream-1",
    code: RELAY_STREAM_CLOSE_CODES.NORMAL,
    reason: "done"
  } as const;
  const event = {
    type: "event",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    id: "event-1",
    topic: "vault.tree.changed",
    resource: { vaultSlug: "demo-vault" },
    payload: {
      encoding: "json",
      value: { cursor: "cursor-1" }
    }
  } as const;
  const cancel = {
    type: "cancel",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    target: { kind: "stream", streamId: "stream-1" },
    reason: "navigated away"
  } as const;
  const error = {
    type: "error",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    target: { kind: "rpc", id: "req-1" },
    error: {
      code: RELAY_ERROR_CODES.UNAUTHORIZED,
      message: "Not authorized"
    }
  } as const;

  for (const frame of [open, data, close, event, cancel, error]) {
    expect(decodeRelayFrame(encodeRelayFrame(frame))).toEqual(frame);
  }
});

it("rejects malformed relay frames", () => {
  expect(() => decodeRelayFrame("null")).toThrow(
    "Relay frame must be an object"
  );
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "rpc.request",
        version: 999,
        id: "req-1",
        capability: "vault.file.read"
      })
    )
  ).toThrow("Unsupported relay protocol version");
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "unknown",
        version: RELAY_TRANSPORT_PROTOCOL_VERSION
      })
    )
  ).toThrow("Unsupported relay frame type: unknown");
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "rpc.request",
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        id: "",
        capability: "vault.file.read"
      })
    )
  ).toThrow("Relay id must not be empty");
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "rpc.request",
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        id: "req-1",
        capability: "vault.file.read",
        payload: { encoding: "xml", value: "<nope />" }
      })
    )
  ).toThrow("Relay payload.encoding must be json or base64");
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "stream.data",
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        streamId: "stream-1",
        sequence: -1,
        payload: { encoding: "base64", dataB64: "AQI=" }
      })
    )
  ).toThrow("Relay sequence must be a non-negative integer");
});

it("rejects relay frames above the configured byte limit", () => {
  const frame = encodeRelayFrame({
    type: "event",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    topic: "large",
    payload: {
      encoding: "json",
      value: { text: "hello" }
    }
  });

  expect(relayFrameByteLength(frame)).toBeLessThan(RELAY_FRAME_BYTE_LIMIT);
  expect(() => decodeRelayFrame(frame, { maxBytes: 10 })).toThrow(
    "Relay frame exceeds byte limit"
  );
  expect(() => assertRelayFrameSize(frame, { maxBytes: 10 })).toThrow(
    "Relay frame exceeds byte limit"
  );
});

it("counts relay frame bytes as UTF-8, not string code units", () => {
  expect(relayFrameByteLength("é")).toBe(2);
});

it("rejects malformed relay error, target, and payload details", () => {
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "rpc.response",
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        id: "req-1",
        ok: "yes"
      })
    )
  ).toThrow("Relay rpc.response ok must be boolean");
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "rpc.response",
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        id: "req-1",
        ok: false,
        error: { code: "made-up", message: "Bad" }
      })
    )
  ).toThrow("Relay error.code is not a known error code");
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "stream.close",
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        streamId: "stream-1",
        code: "made-up"
      })
    )
  ).toThrow("Relay code is not a known stream close code");
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "cancel",
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        target: { kind: "other", id: "req-1" }
      })
    )
  ).toThrow("Relay target.kind must be rpc or stream");
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "stream.data",
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        streamId: "stream-1",
        sequence: 0,
        payload: { encoding: "base64", dataB64: "not base64" }
      })
    )
  ).toThrow("Relay payload.dataB64 must be base64");
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: 1,
        version: RELAY_TRANSPORT_PROTOCOL_VERSION
      })
    )
  ).toThrow("Relay type must be a string");
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "rpc.request",
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        id: "req-1",
        capability: "vault.file.read",
        deadlineMs: 0
      })
    )
  ).toThrow("Relay deadlineMs must be a positive integer");
  expect(() =>
    decodeRelayFrame(
      JSON.stringify({
        type: "rpc.request",
        version: RELAY_TRANSPORT_PROTOCOL_VERSION,
        id: "req-1",
        capability: "vault.file.read",
        context: []
      })
    )
  ).toThrow("Relay context must be a JSON object");
});

it("validates relay JSON payload edges before serialization", () => {
  expect(
    parseRelayFrame({
      type: "event",
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      topic: "array.payload",
      payload: {
        encoding: "json",
        value: ["ok", 1, null, { nested: true }]
      }
    })
  ).toEqual({
    type: "event",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    topic: "array.payload",
    payload: {
      encoding: "json",
      value: ["ok", 1, null, { nested: true }]
    }
  });

  expect(() =>
    parseRelayFrame({
      type: "event",
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      topic: "bad.array",
      payload: {
        encoding: "json",
        value: ["ok", undefined]
      }
    })
  ).toThrow("Relay payload.value must be JSON-compatible");
  expect(() =>
    parseRelayFrame({
      type: "event",
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      topic: "bad.symbol",
      payload: {
        encoding: "json",
        value: Symbol("nope")
      }
    })
  ).toThrow("Relay payload.value must be JSON-compatible");
  expect(() =>
    parseRelayFrame({
      type: "event",
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      topic: "bad.date",
      payload: {
        encoding: "json",
        value: new Date("2026-06-25T00:00:00.000Z")
      }
    })
  ).toThrow("Relay payload.value must be JSON-compatible");
  expect(() =>
    parseRelayFrame({
      type: "event",
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      topic: "bad.map",
      resource: new Map([["vaultSlug", "demo-vault"]])
    })
  ).toThrow("Relay resource must be a JSON object");
  expect(
    parseRelayFrame({
      type: "event",
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      topic: "null.prototype",
      resource: Object.assign(Object.create(null), {
        vaultSlug: "demo-vault"
      })
    })
  ).toEqual({
    type: "event",
    version: RELAY_TRANSPORT_PROTOCOL_VERSION,
    topic: "null.prototype",
    resource: { vaultSlug: "demo-vault" }
  });
  expect(() =>
    parseRelayFrame({
      type: "rpc.response",
      version: RELAY_TRANSPORT_PROTOCOL_VERSION,
      id: "req-1",
      ok: false,
      error: {
        code: RELAY_ERROR_CODES.INTERNAL,
        message: "Internal",
        data: { value: Number.NaN }
      }
    })
  ).toThrow("Relay error.data must be JSON-compatible");
});

it("tracks relay pending rpc requests with deadlines", () => {
  let now = 1000;
  const pending = new RelayPendingRequestTable({
    maxPending: 2,
    defaultTimeoutMs: 100,
    now: () => now
  });

  expect(pending.add("req-1")).toEqual({
    ok: true,
    pending: 1,
    deadlineAt: 1100
  });
  expect(pending.add("req-2", { timeoutMs: 250 })).toEqual({
    ok: true,
    pending: 2,
    deadlineAt: 1250
  });
  expect(pending.size).toBe(2);
  expect(pending.has("req-1")).toBe(true);
  expect(pending.deadlineFor("req-2")).toBe(1250);
  expect(pending.add("req-1")).toEqual({
    ok: false,
    reason: "duplicate",
    pending: 2
  });
  expect(pending.add("req-3")).toEqual({
    ok: false,
    reason: "limit",
    pending: 2
  });
  expect(pending.resolve("req-2")).toBe(true);
  expect(pending.add("req-3")).toEqual({
    ok: true,
    pending: 2,
    deadlineAt: 1100
  });

  now = 1100;
  expect(pending.expire()).toEqual(["req-1", "req-3"]);
  expect(pending.has("req-1")).toBe(false);
  expect(pending.resolve("req-2")).toBe(false);
  expect(pending.size).toBe(0);
});

it("cancels and clears relay pending rpc requests", () => {
  const pending = new RelayPendingRequestTable();

  expect(pending.maxPending).toBe(RELAY_PENDING_REQUEST_LIMIT);
  expect(pending.defaultTimeoutMs).toBe(RELAY_DEFAULT_REQUEST_TIMEOUT_MS);
  expect(pending.add("req-1", { deadlineAt: 123 })).toEqual({
    ok: true,
    pending: 1,
    deadlineAt: 123
  });
  expect(pending.deadlineFor("missing")).toBeNull();
  expect(pending.cancel("missing")).toBe(false);
  expect(pending.cancel("req-1")).toBe(true);
  expect(pending.add("req-2")).toMatchObject({ ok: true, pending: 1 });
  pending.clear();
  expect(pending.size).toBe(0);
});
