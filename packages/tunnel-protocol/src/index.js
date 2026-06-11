export const TUNNEL_PROTOCOL_VERSION = 1;
export function encodeTunnelMessage(message) {
    return JSON.stringify(message);
}
export function decodeTunnelMessage(data) {
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
        throw new Error("Tunnel message must be an object with a type");
    }
    return parsed;
}
