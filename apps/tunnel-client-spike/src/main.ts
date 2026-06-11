#!/usr/bin/env node
import {
  TUNNEL_PROTOCOL_VERSION,
  decodeTunnelMessage,
  encodeTunnelMessage,
  type TunnelControlServerMessage,
  type TunnelHttpRequestEnvelope,
  type TunnelHttpResponseEnvelope,
  type TunnelWebSocketOpenEnvelope
} from "@kb-2/tunnel-protocol";
import { WebSocket } from "ws";

type PendingHttp = {
  request: TunnelHttpRequestEnvelope;
};

type Config = {
  relayUrl: URL;
  daemonUrl: URL;
  token: string;
};

const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

async function main(): Promise<void> {
  const config = readConfig();
  const controlUrl = new URL("/__kb2_tunnel/control", config.relayUrl);
  controlUrl.protocol = controlUrl.protocol === "https:" ? "wss:" : "ws:";

  const control = new WebSocket(controlUrl);
  const pendingHttp = new Map<string, PendingHttp>();

  control.on("open", () => {
    control.send(encodeJsonBytes({
      type: "control.hello",
      version: TUNNEL_PROTOCOL_VERSION,
      token: config.token
    }));
    console.log(`[tunnel-client-spike] control connected ${controlUrl.href}`);
  });

  control.on("message", (data) => {
    void handleControlMessage(config, control, pendingHttp, data).catch((error: unknown) => {
      console.error("[tunnel-client-spike] control message failed", error);
    });
  });

  control.on("close", (code, reason) => {
    console.log(`[tunnel-client-spike] control closed ${code} ${reason.toString()}`);
    process.exitCode = code === 1000 ? 0 : 1;
  });

  control.on("error", (error) => {
    console.error("[tunnel-client-spike] control error", error);
    process.exitCode = 1;
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      control.close(1001, signal);
    });
  }
}

async function handleControlMessage(
  config: Config,
  control: WebSocket,
  pendingHttp: Map<string, PendingHttp>,
  data: WebSocket.RawData
): Promise<void> {
  if (typeof data !== "string" && !Buffer.isBuffer(data)) {
    return;
  }

  const message = decodeTunnelMessage(data.toString()) as TunnelControlServerMessage;
  switch (message.type) {
    case "control.ready":
      console.log("[tunnel-client-spike] relay accepted control channel");
      return;
    case "control.error":
      console.error(`[tunnel-client-spike] relay error ${message.code}: ${message.message}`);
      return;
    case "http.request":
      pendingHttp.set(message.id, { request: message });
      control.send(encodeJsonBytes(await proxyHttp(config.daemonUrl, message)));
      pendingHttp.delete(message.id);
      return;
    case "ws.open":
      openDialback(config, message);
      return;
  }
}

async function proxyHttp(
  daemonUrl: URL,
  envelope: TunnelHttpRequestEnvelope
): Promise<TunnelHttpResponseEnvelope> {
  const upstreamUrl = new URL(envelope.path, daemonUrl);
  const headers = new Headers();
  for (const [name, value] of Object.entries(envelope.headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }

  try {
    const response = await fetch(upstreamUrl, {
      method: envelope.method,
      headers,
      body: envelope.bodyB64 ? Buffer.from(envelope.bodyB64, "base64") : undefined
    });

    return {
      type: "http.response",
      id: envelope.id,
      status: response.status,
      headers: serializableHeaders(response.headers),
      bodyB64: Buffer.from(await response.arrayBuffer()).toString("base64")
    };
  } catch (error) {
    return {
      type: "http.response",
      id: envelope.id,
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
      bodyB64: Buffer.from(`Tunnel client failed to reach daemon: ${String(error)}\n`).toString("base64")
    };
  }
}

function openDialback(config: Config, envelope: TunnelWebSocketOpenEnvelope): void {
  const dialbackUrl = new URL("/__kb2_tunnel/dialback", config.relayUrl);
  dialbackUrl.protocol = dialbackUrl.protocol === "https:" ? "wss:" : "ws:";
  dialbackUrl.searchParams.set("streamId", envelope.streamId);

  const daemonWsUrl = new URL(envelope.path, config.daemonUrl);
  daemonWsUrl.protocol = daemonWsUrl.protocol === "https:" ? "wss:" : "ws:";

  const relaySocket = new WebSocket(dialbackUrl);
  const daemonSocket = new WebSocket(daemonWsUrl, {
    headers: withoutHopByHop(envelope.headers)
  });

  relaySocket.on("open", () => {
    relaySocket.send(encodeJsonBytes({
      type: "ws.dialback.hello",
      version: TUNNEL_PROTOCOL_VERSION,
      token: config.token,
      streamId: envelope.streamId
    }));
  });

  relaySocket.on("message", (data, isBinary) => {
    if (daemonSocket.readyState === WebSocket.OPEN) {
      daemonSocket.send(data, { binary: isBinary });
    }
  });

  daemonSocket.on("message", (data, isBinary) => {
    if (relaySocket.readyState === WebSocket.OPEN) {
      relaySocket.send(data, { binary: isBinary });
    }
  });

  relaySocket.on("close", (code, reason) => {
    if (daemonSocket.readyState === WebSocket.OPEN || daemonSocket.readyState === WebSocket.CONNECTING) {
      daemonSocket.close(sendableCloseCode(code), reason.toString());
    }
  });

  daemonSocket.on("close", (code, reason) => {
    if (relaySocket.readyState === WebSocket.OPEN || relaySocket.readyState === WebSocket.CONNECTING) {
      relaySocket.close(sendableCloseCode(code), reason.toString());
    }
  });

  relaySocket.on("error", (error) => {
    console.error(`[tunnel-client-spike] relay dialback ${envelope.streamId} error`, error);
    daemonSocket.close(1011, "Relay dialback failed");
  });

  daemonSocket.on("error", (error) => {
    console.error(`[tunnel-client-spike] daemon ws ${envelope.path} error`, error);
    relaySocket.close(1011, "Daemon websocket failed");
  });
}

function serializableHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (!hopByHopHeaders.has(name.toLowerCase())) {
      output[name] = value;
    }
  }
  return output;
}

function withoutHopByHop(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase())) {
      output[name] = value;
    }
  }
  return output;
}

function readConfig(): Config {
  const relayUrl = requiredUrl("RELAY_URL");
  const daemonUrl = requiredUrl("DAEMON_URL");
  const token = process.env.RELAY_SPIKE_TOKEN?.trim();

  if (!token) {
    throw new Error("RELAY_SPIKE_TOKEN is required");
  }

  return { relayUrl, daemonUrl, token };
}

function encodeJsonBytes(message: Parameters<typeof encodeTunnelMessage>[0]): Buffer {
  return Buffer.from(encodeTunnelMessage(message));
}

function requiredUrl(name: string): URL {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return new URL(value);
}

function sendableCloseCode(code: number): number {
  return code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006
    ? code
    : 1011;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
