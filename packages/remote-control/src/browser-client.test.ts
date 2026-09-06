import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostBridge, type HostBridgeRelay, type RemoteControlService } from "./host-bridge.js";
import { decodeWireEnvelope, encodeWireEnvelope, type WireRelayEnvelope } from "./http-wire.js";
import { InMemoryPairingAuthority, createPairingProof, generateDeviceIdentity } from "./pairing-security.js";
import { REMOTE_CONTROL_LIMITS, type RemoteControlFrame, type OpaqueRelayEnvelope } from "./protocol.js";

let tlsDirectory: string;
let tlsCert: string;
let tlsKey: string;

beforeAll(() => {
  tlsDirectory = mkdtempSync(join(tmpdir(), "chili-browser-client-tls-"));
  tlsCert = join(tlsDirectory, "certificate.pem");
  tlsKey = join(tlsDirectory, "key.pem");
  const config = join(tlsDirectory, "openssl.cnf");
  writeFileSync(config, "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", config, "-keyout", tlsKey, "-out", tlsCert], { stdio: "ignore" });
});
afterAll(() => { if (tlsDirectory) rmSync(tlsDirectory, { recursive: true, force: true }); });

for (const scenario of [
  "normal", "lost_ack", "lost_result", "lost_ack_and_result", "before_admission", "parallel_results",
  "slow_http_ack", "unadmitted_behind_read", "side_effect_then_error", "late_unrelated_result",
  "reconnect_auth_before_ack", "reconnect_poll_auth_before_send",
  "held_send_dispose", "held_stop_dispose", "held_read_dispose",
  "held_send_revoke", "held_stop_revoke", "held_read_revoke",
  "unsent_behind_pending_dispose", "definite_unadmitted", "definite_refusal_after_pending",
] as const) {
  test(`production fetch/WebCrypto client over trusted isolated HTTPS: ${scenario}`, async () => {
    const identity = generateDeviceIdentity();
    const authority = new InMemoryPairingAuthority({ hostId: "browser_client_test", allowedCapabilities: ["sessions.read", "sessions.send", "sessions.stop"] });
    const challenge = authority.beginPairing({ ...identity, grantedCapabilities: ["sessions.read", "sessions.send", "sessions.stop"] });
    const pairing = authority.completePairing(createPairingProof(challenge, identity.privateKey));
    const calls: string[] = [];
    const received: { sequence: number; requestId: string; messageId: string }[] = [];
    const outgoing: WireRelayEnvelope[] = [];
    const service: RemoteControlService = {
      async invoke(request) {
        calls.push(request.operation);
        if (scenario === "side_effect_then_error" && request.operation === "session.send") throw new Error("Side effect committed but response failed");
        if (request.operation === "session.snapshot") await Bun.sleep(350);
        return { operation: request.operation, ok: true };
      },
    };
    const bridge = new HostBridge({ hostId: pairing.hostId, routeId: pairing.channel.routeId, controlService: service, credentials: authority, codec: authority });
    let relayConnected = true;
    const relay: HostBridgeRelay = {
      limits: { maxMessageBytes: REMOTE_CONTROL_LIMITS.maxCiphertextBytes, maxQueuedMessagesPerRoute: REMOTE_CONTROL_LIMITS.maxQueueMessages, maxQueuedBytesPerRoute: REMOTE_CONTROL_LIMITS.maxQueueBytes },
      connectHost() {
        return {
          routeId: pairing.channel.routeId,
          get connected() { return relayConnected; },
          disconnect() { relayConnected = false; },
          send(envelope: OpaqueRelayEnvelope) {
            const frame = authority.openRelayEnvelope<RemoteControlFrame>(envelope);
            const first = "sequence" in frame && frame.sequence === 1;
            if (first && frame.type === "ack" && ["lost_ack", "lost_ack_and_result", "unsent_behind_pending_dispose"].includes(scenario)) return;
            if (first && frame.type === "result" && (scenario.startsWith("held_") || ["lost_result", "lost_ack_and_result", "unadmitted_behind_read", "unsent_behind_pending_dispose", "definite_refusal_after_pending"].includes(scenario))) return;
            outgoing.push(encodeWireEnvelope(envelope));
          },
        };
      },
    };
    bridge.connect(relay);
    let discardedBeforeAdmission = false;
    let pollAuthenticationError: string | undefined;
    const server = createServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }, async (request, response) => {
      try {
        if (request.headers.authorization !== `Bearer ${pairing.credential}`) throw new Error("Authentication required");
        const parts: Buffer[] = [];
        for await (const chunk of request) parts.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
        if (body.deviceId !== pairing.deviceId || body.routeId !== pairing.channel.routeId) throw new Error("Wrong route");
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/control/send") {
          const envelope = decodeWireEnvelope(body.envelope);
          const frame = authority.openRelayEnvelope<RemoteControlFrame>(envelope);
          if (frame.type !== "request") throw new Error("Expected request");
          received.push({ sequence: frame.sequence, requestId: frame.requestId, messageId: envelope.messageId });
          if (scenario === "reconnect_auth_before_ack" || scenario === "reconnect_poll_auth_before_send") {
            if (received.length === 1) {
              response.writeHead(202).end(JSON.stringify({ accepted: true }));
              return;
            }
            if (scenario === "reconnect_poll_auth_before_send") {
              pollAuthenticationError = "authentication_failed";
              await Bun.sleep(100);
            }
            response.writeHead(401).end(JSON.stringify({ error: { code: "authentication_failed" } }));
            return;
          }
          if (scenario === "definite_unadmitted" || (scenario === "definite_refusal_after_pending" && frame.sequence === 2)) authority.revokeCredential(pairing.credential);
          if ((scenario === "before_admission" || (["unadmitted_behind_read", "late_unrelated_result"].includes(scenario) && frame.sequence === 2)) && !discardedBeforeAdmission) discardedBeforeAdmission = true;
          else if (scenario === "late_unrelated_result" && frame.sequence === 2) setTimeout(() => { void bridge.receive(envelope); }, 350);
          else void bridge.receive(envelope);
          if (scenario === "slow_http_ack" && frame.sequence === 1) await Bun.sleep(500);
          response.writeHead(202).end(JSON.stringify({ accepted: true }));
        } else if (request.url === "/api/control/poll") {
          if (pollAuthenticationError) response.writeHead(401).end(JSON.stringify({ error: { code: pollAuthenticationError } }));
          else response.end(JSON.stringify({ envelopes: outgoing.splice(0) }));
        } else if (request.url === "/test/revoke") {
          authority.revokeCredential(pairing.credential);
          pollAuthenticationError = "credential_revoked";
          response.end(JSON.stringify({ revoked: true }));
        } else response.writeHead(404).end("{}");
      } catch { response.writeHead(400).end(JSON.stringify({ error: { code: "invalid_request" } })); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    try {
      const child = Bun.spawn([process.execPath, new URL("./browser-client-test-worker.ts", import.meta.url).pathname, scenario], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: tlsCert, CHILI_BROWSER_TEST_ORIGIN: `https://127.0.0.1:${address.port}`, CHILI_BROWSER_TEST_PAIRING: JSON.stringify(pairing) },
        stdout: "pipe", stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr.trim()).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ ok: true, unhandledRejections: 0 });
      if (["reconnect_auth_before_ack", "reconnect_poll_auth_before_send", "definite_unadmitted"].includes(scenario)) expect(calls).toHaveLength(0);
      else if (scenario.startsWith("held_stop_")) expect(calls.filter((operation) => operation === "session.stop")).toHaveLength(1);
      else if (scenario.startsWith("held_read_")) expect(calls.filter((operation) => operation === "session.snapshot")).toHaveLength(1);
      else if (!["parallel_results", "slow_http_ack"].includes(scenario)) expect(calls.filter((operation) => operation === "session.send")).toHaveLength(1);
      if (scenario === "unsent_behind_pending_dispose" || scenario === "definite_unadmitted") expect(received.map((request) => request.sequence)).toEqual([1]);
      if (scenario === "definite_refusal_after_pending") expect(received.map((request) => request.sequence)).toEqual([1, 2]);
      if (["lost_result", "lost_ack_and_result", "before_admission"].includes(scenario)) {
        const attempts = received.filter((request) => request.sequence === 1);
        expect(attempts).toHaveLength(2);
        expect(attempts[0]!.requestId).toBe(attempts[1]!.requestId);
        expect(attempts[0]!.messageId).not.toBe(attempts[1]!.messageId);
      }
      if (scenario === "unadmitted_behind_read") {
        expect(received.map((request) => request.sequence)).toEqual([1, 2, 2, 1, 3]);
      }
    } finally {
      bridge.disconnect();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
}
