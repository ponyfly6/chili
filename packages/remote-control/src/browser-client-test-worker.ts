/** Isolated test process: NODE_EXTRA_CA_CERTS is scoped to this child, never system trust. */
import { BrowserControlClient, BrowserControlClientError } from "./browser-client.js";
import type { PairingGrant } from "./pairing-security.js";

const origin = process.env.CHILI_BROWSER_TEST_ORIGIN;
const serializedPairing = process.env.CHILI_BROWSER_TEST_PAIRING;
if (!origin || !serializedPairing) throw new Error("Browser client test configuration missing");
const pairing = JSON.parse(serializedPairing) as PairingGrant;
const client = new BrowserControlClient({
  baseUrl: origin,
  pairing,
  pollIntervalMs: 20,
  requestTimeoutMs: 2_000,
});
const scenario = process.argv[2];
const observed: string[] = [];
const unhandledRejections: unknown[] = [];
const recordUnhandled = (reason: unknown) => { unhandledRejections.push(reason); };
process.on("unhandledRejection", recordUnhandled);
client.onState((state) => observed.push(state));
const payload = { sessionId: "existing_task", text: "execute exactly once", mode: "queue" } as const;
try {
  if (scenario?.startsWith("held_")) {
    const reading = scenario.startsWith("held_read_");
    const stopping = scenario.startsWith("held_stop_");
    const request = reading
      ? client.request("session.snapshot", { sessionId: "existing_task" })
      : stopping ? client.request("session.stop", { sessionId: "existing_task" }) : client.request("session.send", payload);
    const result = request.then(() => "succeeded", errorCode);
    // This second operation cannot transmit until request 1's ACK is handled.
    await client.request("sessions.list", {});
    const revoking = scenario.endsWith("_revoke");
    if (revoking) {
      const response = await fetch(`${origin}/test/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${pairing.credential}` },
        body: JSON.stringify({ deviceId: pairing.deviceId, routeId: pairing.channel.routeId }),
      });
      if (!response.ok) throw new Error("Host-side test revocation failed");
    } else client.dispose();
    const expected = reading ? revoking ? "credential_revoked" : "CLIENT_CLOSED" : "outcome_unknown";
    if (await result !== expected) throw new Error(`Lost terminal request outcome; expected ${expected}`);
  } else if (scenario === "unsent_behind_pending_dispose") {
    const sent = client.request("session.send", payload).then(() => "succeeded", errorCode);
    const unsent = client.request("session.stop", { sessionId: "existing_task" }).then(() => "succeeded", errorCode);
    await Bun.sleep(100);
    client.dispose();
    if (await sent !== "outcome_unknown" || await unsent !== "NOT_CONNECTED") {
      throw new Error("Transmitted uncertainty and never-transmitted queue rejection were conflated");
    }
  } else if (scenario === "definite_unadmitted") {
    const rejected = client.request("session.send", payload).then(() => "succeeded", errorCode);
    const unsent = client.request("session.stop", { sessionId: "existing_task" }).then(() => "succeeded", errorCode);
    if (await rejected !== "credential_revoked" || await unsent !== "NOT_CONNECTED") {
      throw new Error("Authenticated non-admission was incorrectly reported as unknown");
    }
  } else if (scenario === "definite_refusal_after_pending") {
    const earlier = client.request("session.send", payload).then(() => "succeeded", errorCode);
    const rejected = client.request("session.send", { ...payload, text: "must be denied before invocation" }).then(() => "succeeded", errorCode);
    const unsent = client.request("session.stop", { sessionId: "existing_task" }).then(() => "succeeded", errorCode);
    if (await earlier !== "outcome_unknown" || await rejected !== "credential_revoked" || await unsent !== "NOT_CONNECTED") {
      throw new Error("Exact non-admission rejection overwrote another transmitted command's unknown outcome");
    }
  } else if (scenario === "reconnect_auth_before_ack" || scenario === "reconnect_poll_auth_before_send") {
    const result = client.request("session.send", payload).then(
      () => "succeeded", (error: unknown) => error instanceof BrowserControlClientError ? error.code : "other_error",
    );
    await Bun.sleep(150);
    client.disconnect();
    const reconnectError = await client.reconnect().then(
      () => "succeeded", (error: unknown) => error instanceof BrowserControlClientError ? error.code : "other_error",
    );
    if (reconnectError !== "authentication_failed" || await result !== "outcome_unknown" || client.state !== "expired") {
      throw new Error("Revoked reconnect did not preserve the sent command's uncertainty and connection authentication failure");
    }
  } else if (scenario === "parallel_results" || scenario === "slow_http_ack") {
    let snapshotDone = false;
    const snapshot = client.request("session.snapshot", { sessionId: "existing_task" }).then(() => { snapshotDone = true; });
    await client.request("session.stop", { sessionId: "existing_task" });
    if (snapshotDone) throw new Error("Stop waited for the slow snapshot result");
    await snapshot;
  } else if (scenario === "late_unrelated_result") {
    const snapshot = client.request("session.snapshot", { sessionId: "existing_task" });
    await Bun.sleep(100);
    const send = client.request("session.send", payload);
    await Bun.sleep(150);
    client.disconnect();
    const start = Date.now();
    await client.reconnect();
    if (Date.now() - start < 250) throw new Error("Unrelated old result prematurely completed reconnect");
    await Promise.all([snapshot, send]);
  } else if (scenario === "unadmitted_behind_read") {
    const snapshot = client.request("session.snapshot", { sessionId: "existing_task" }).then(
      () => "succeeded", (error: unknown) => error instanceof BrowserControlClientError ? error.code : "other_error",
    );
    await Bun.sleep(100);
    const send = client.request("session.send", payload);
    await Bun.sleep(150);
    client.disconnect();
    await client.reconnect();
    await send;
    client.disconnect();
    await client.reconnect();
    if (await snapshot !== "outcome_unknown") throw new Error("Unrecovered lost read result");
    await client.request("sessions.list", {});
  } else if (scenario === "side_effect_then_error") {
    const code = await client.request("session.send", payload).then(
      () => "succeeded", (error: unknown) => error instanceof BrowserControlClientError ? error.code : "other_error",
    );
    if (code !== "outcome_unknown") throw new Error("Admitted runtime failure incorrectly reported definite non-execution");
    await client.request("sessions.list", {});
  } else if (scenario === "lost_result" || scenario === "lost_ack_and_result") {
    const result = client.request("session.send", payload).then(
      () => "succeeded",
      (error: unknown) => error instanceof BrowserControlClientError ? error.code : "other_error",
    );
    await Bun.sleep(200);
    client.disconnect();
    await client.reconnect();
    if (await result !== "outcome_unknown") throw new Error("Missing explicit unknown outcome after resync");
    await client.request("sessions.list", {});
    client.disconnect();
    await client.reconnect();
  } else if (scenario === "before_admission") {
    const result = client.request("session.send", payload);
    await Bun.sleep(200);
    client.disconnect();
    await client.reconnect();
    await result;
  } else {
    await client.request("session.send", payload);
    await client.request("sessions.list", {});
  }
} finally {
  client.dispose();
  // Check the rejection event after the failing send/poll and disposal stacks
  // have both unwound. Listening must not hide a leaked internal rejection.
  await Bun.sleep(50);
  process.removeListener("unhandledRejection", recordUnhandled);
  if (unhandledRejections.length > 0) throw new Error(`Unhandled internal rejections: ${unhandledRejections.length}`);
}
console.log(JSON.stringify({ ok: true, observed, unhandledRejections: unhandledRejections.length }));

function errorCode(error: unknown): string {
  return error instanceof BrowserControlClientError ? error.code : "other_error";
}
