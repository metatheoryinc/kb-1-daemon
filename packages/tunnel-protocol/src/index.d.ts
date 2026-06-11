export declare const TUNNEL_PROTOCOL_VERSION: 1;
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
export type TunnelControlClientMessage = TunnelControlClientHello | TunnelHttpResponseEnvelope;
export type TunnelControlServerMessage = TunnelControlServerReady | TunnelControlServerError | TunnelHttpRequestEnvelope | TunnelWebSocketOpenEnvelope;
export type TunnelDialbackClientMessage = TunnelWebSocketDialbackHello;
export type TunnelJsonMessage = TunnelControlClientMessage | TunnelControlServerMessage | TunnelDialbackClientMessage;
export declare function encodeTunnelMessage(message: TunnelJsonMessage): string;
export declare function decodeTunnelMessage(data: string): TunnelJsonMessage;
//# sourceMappingURL=index.d.ts.map