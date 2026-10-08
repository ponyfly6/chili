#!/usr/bin/env bun
/**
 * Disposable simulator fixture: real private HTTPS/pairing/encryption host, fake
 * task data only. This does not prove Electron/runtime integration. It never
 * installs a CA or modifies OS/device trust. Pairing is auto-approved here only.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createBrowserTestCertificate } from "../apps/desktop/e2e/remote-control-fixtures.js";
import { PrivateControlHttpsHost } from "../packages/remote-control/src/https-host.js";
import type { RemoteControlService } from "../packages/remote-control/src/host-bridge.js";
import type { RemoteControlOperation } from "../packages/remote-control/src/protocol.js";

const directory = await mkdtemp(join(tmpdir(), "chili-native-simulator-fixture-"));
const certificate = await createBrowserTestCertificate(join(directory, "certificate"));
const webRoot = join(directory, "web");
await mkdir(webRoot);
await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Chili simulator fixture</title><p>Fake tasks; real private HTTPS.</p>");
const counts: Partial<Record<RemoteControlOperation, number>> = {};
let answered = false;
let stopped = false;
let sent = 0;
let approved = 0;
const createdAt = Date.now();
const service: RemoteControlService = {
  invoke(request) {
    counts[request.operation] = (counts[request.operation] ?? 0) + 1;
    const session = { id: "native-fixture-task", title: "iOS 原生桥接测试", status: "active" as const, updatedAt: createdAt };
    switch (request.operation) {
      case "sessions.list": return { sessions: [session], truncated: false };
      case "session.snapshot": return {
        session: { ...session, runStatus: answered || stopped ? "idle" : "waiting_for_input", queuedCount: 0,
          deliveryUnknown: false, needsDesktop: { approval: false, input: false } },
        messages: [{ id: "fixture-message", role: "assistant", text: `这是模拟器验证任务。已发送 ${sent} 条指令，${answered ? "已收到回答" : "等待回答"}。`, createdAt }],
        inputRequests: answered || stopped ? [] : [{ id: "userinput_native_fixture", createdAt, questions: [{
          id: "continue", header: "测试", question: "要继续验证原生连接吗？", options: [
            { label: "继续", description: "记录这次原生答复。" }, { label: "稍后", description: "保留任务。" },
          ],
        }] }], truncated: false,
      };
      case "session.answerInput": answered = true; return { resolved: true };
      case "session.send": sent += 1; return { status: "queued", position: 1 };
      case "session.stop": stopped = true; return { interrupted: true };
    }
  },
};
const host = new PrivateControlHttpsHost({ controlService: service });
const state = await host.enable({ bindAddress: "127.0.0.1", port: 0, publicOrigin: "https://127.0.0.1:0",
  tlsCertPath: certificate.certificate, tlsKeyPath: certificate.key, webRoot });
let currentPairing: ReturnType<typeof host.createPairing>;
async function publishPairing(): Promise<void> {
  currentPairing = host.createPairing();
  const info = { fixture: true, mockRuntime: true, realHttpsHost: true, autoApprovesFixtureOnly: true,
    origin: state.origin, authorityPath: certificate.authority, pairingCode: currentPairing.code,
    pairingExpiresAt: currentPairing.expiresAt, outputDirectory: directory };
  await writeFile(join(directory, "connection.json"), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(info)}\n`);
}
await publishPairing();
const timer = setInterval(() => {
  for (const pending of host.snapshot().pendingPairings) { host.approvePairing(pending.pairingId); approved += 1; }
}, 100);
const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  void (async () => {
    if (line.trim() === "pair") await publishPairing();
    else if (line.trim() === "revoke") {
      for (const device of host.snapshot().devices) await host.revokeDevice(device.deviceId);
      process.stdout.write("fixture devices revoked\n");
    } else if (line.trim() === "quit") await stop();
    else {
      const result = { fixture: true, operationCounts: counts, localApprovals: approved,
        devices: host.snapshot().devices.length, answered, stopped, sent };
      await writeFile(join(directory, "evidence.json"), `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  })().catch((error: unknown) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`));
});
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return; stopping = true; clearInterval(timer); reader.close(); await host.disable(); process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
process.stdout.write("Commands: pair (new 2-minute invitation), status (redacted counts), revoke, quit. CA trust is not installed.\n");
