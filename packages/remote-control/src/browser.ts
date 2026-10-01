/** Browser-only entry: no Node crypto, Electron, fake client, mock service or relay implementation. */
export * from "./browser-client.js";
export * from "./browser-security.js";
export * from "./http-wire.js";
export * from "./protocol.js";
export type { PairingChallenge, PairingGrant, PairingProof, RelayChannelKey } from "./pairing-security.js";
