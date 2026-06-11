export const TUNNEL_PROTOCOL_VERSION = 1 as const;

export type TunnelProtocolVersion = typeof TUNNEL_PROTOCOL_VERSION;

export type TunnelRole = "control" | "dialback";

export type TunnelControlClientHello = {
  type: "control.hello";
  version: TunnelProtocolVersion;
  token: string;
};

export type TunnelControlServerReady = {
  type: "control.ready";
  version: TunnelProtocolVersion;
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

export type TunnelHttpResponseEnvelope = {
  type: "http.response";
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyB64: string | null;
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
  | TunnelHttpResponseEnvelope;

export type TunnelControlServerMessage =
  | TunnelControlServerReady
  | TunnelControlServerError
  | TunnelHttpRequestEnvelope
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
