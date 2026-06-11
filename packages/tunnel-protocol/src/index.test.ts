import {
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

it("carries the spike protocol version", () => {
  expect(TUNNEL_PROTOCOL_VERSION).toBe(1);
});
