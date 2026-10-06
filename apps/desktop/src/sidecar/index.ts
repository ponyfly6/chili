#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { createReadStream, writeSync } from "node:fs";
import { realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createChiliHost, type ChiliHost } from "@chili/host";
import { startRuntimeHttpServer } from "@chili/server";
import {
  DeferredApprovalQueue,
  DeferredUserInputQueue,
  observeRunProcessLifecycle,
  runProcess,
} from "@chili/tools";
import { safeDesktopErrorMessage as safeErrorMessage } from "../shared/safe-error.js";
import {
  readSidecarCredentialStream,
  SIDECAR_CREDENTIAL_FD,
} from "../main/sidecar-control-stream.js";
import {
  forceKillOwnedProcessGroups,
  SIDECAR_GRACEFUL_SHUTDOWN_FRAME,
} from "./parent-loss-watchdog.js";
import {
  closeSidecarResources,
  createSidecarShutdownCoordinator,
} from "./shutdown-coordinator.js";

const READY_TYPE = "chili.sidecar.ready";
const PROCESS_TYPE = "chili.sidecar.process";
const PARENT_LOSS_EXIT_DEADLINE_MS = 5_000;
const workspaceInput = resolve(requireEnvironment("CHILI_DESKTOP_WORKSPACE"));
const parentPid = positiveIntegerEnvironment("CHILI_DESKTOP_PARENT_PID");
const model = process.env.CHILI_DESKTOP_MODEL?.trim();
const parentLossFixturePath = process.env.CHILI_DESKTOP_PARENT_LOSS_FIXTURE_PATH?.trim();
const smokeMode = process.env.CHILI_DESKTOP_SMOKE === "1";
for (const name of [
  "CHILI_DESKTOP_WORKSPACE",
  "CHILI_DESKTOP_PARENT_PID",
  "CHILI_DESKTOP_MODEL",
  "CHILI_DESKTOP_PARENT_LOSS_FIXTURE_PATH",
] as const) {
  delete process.env[name];
}

const activeToolProcessGroups = new Set<number>();
const approvalQueue = new DeferredApprovalQueue();
const userInputQueue = new DeferredUserInputQueue();
let host: ChiliHost | undefined;
let server: ReturnType<typeof startRuntimeHttpServer> | undefined;
let fixtureToolStart: {
  resolve(pid: number): void;
  reject(error: unknown): void;
} | undefined;
let closing: Promise<void> | undefined;
let teardownObservation = (): void => undefined;

const coordinator = createSidecarShutdownCoordinator({
  deadlineMs: PARENT_LOSS_EXIT_DEADLINE_MS,
  hardContain() {
    try {
      process.stderr.write("[sidecar] shutdown timed out or lost containment; forcing exit\n");
    } finally {
      forceKillOwnedProcessGroups(activeToolProcessGroups);
    }
  },
  exit(code) {
    process.exit(code);
  },
  onCloseError(error) {
    safeWriteStderr(`[sidecar] shutdown failed: ${safeErrorMessage(error)}\n`);
  },
  teardownObservation() {
    teardownObservation();
  },
  parentIsAlive() {
    return processExists(parentPid);
  },
});

let ownershipBuffer = "";
let gracefulFrameSeen = false;
const markParentGone = (): void => {
  coordinator.markParentGone("Desktop parent ownership pipe closed.");
};
const onOwnershipData = (chunk: string | Buffer): void => {
  if (gracefulFrameSeen) {
    markParentGone();
    return;
  }
  ownershipBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (
    ownershipBuffer.length > SIDECAR_GRACEFUL_SHUTDOWN_FRAME.length
    || !SIDECAR_GRACEFUL_SHUTDOWN_FRAME.startsWith(ownershipBuffer)
  ) {
    markParentGone();
    return;
  }
  if (ownershipBuffer === SIDECAR_GRACEFUL_SHUTDOWN_FRAME) {
    gracefulFrameSeen = true;
    coordinator.requestGraceful("Desktop sidecar graceful shutdown requested.", 0);
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", onOwnershipData);
process.stdin.once("end", markParentGone);
process.stdin.once("close", markParentGone);
process.stdin.once("error", markParentGone);
process.stdin.resume();

const parentWatch = setInterval(() => {
  if (!processExists(parentPid)) {
    coordinator.markParentGone("Desktop parent process exited.");
  }
}, 1_000);
parentWatch.unref();

const stopProcessReporting = observeRunProcessLifecycle((event) => {
  if (event.type === "started") {
    activeToolProcessGroups.add(event.pid);
    fixtureToolStart?.resolve(event.pid);
    fixtureToolStart = undefined;
  } else {
    activeToolProcessGroups.delete(event.pid);
  }
  writeControlFrame({ type: PROCESS_TYPE, action: event.type, pid: event.pid });
});
let observationTornDown = false;
teardownObservation = () => {
  if (observationTornDown) return;
  observationTornDown = true;
  clearInterval(parentWatch);
  process.stdin.off("data", onOwnershipData);
  process.stdin.off("end", markParentGone);
  process.stdin.off("close", markParentGone);
  process.stdin.off("error", markParentGone);
  stopProcessReporting();
};

const close = (reason: string): Promise<void> => {
  if (closing) return closing;
  closing = closeSidecarResources({
    denyPending() {
      approvalQueue.denyAll(reason);
      userInputQueue.denyAll(reason);
    },
    ...(server ? { closeServer: () => server?.close() ?? Promise.resolve() } : {}),
    ...(host ? { closeHost: () => host?.close() ?? Promise.resolve() } : {}),
  });
  return closing;
};
coordinator.installClose(close);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    coordinator.requestGraceful(`Desktop sidecar received ${signal}.`, 0);
  });
}

process.once("uncaughtException", (error) => {
  safeWriteStderr(`[sidecar] uncaught exception: ${safeErrorMessage(error)}\n`);
  coordinator.requestGraceful("Desktop sidecar crashed.", 1);
});
process.once("unhandledRejection", (error) => {
  safeWriteStderr(`[sidecar] unhandled rejection: ${safeErrorMessage(error)}\n`);
  coordinator.requestGraceful("Desktop sidecar crashed.", 1);
});

try {
  const token = await readSidecarCredentialStream(createReadStream("", {
    fd: SIDECAR_CREDENTIAL_FD,
    autoClose: true,
  }));
  const workspace = await realpath(workspaceInput);
  host = await createChiliHost({
    cwd: workspace,
    approvalQueue,
    userInputQueue,
    mcpConnectMode: "manual",
    staleTurnRecoveryMs: 0,
    staleTurnRecoveryIntervalMs: 5_000,
    sessionClaimLeaseMs: 15_000,
    sessionClaimHeartbeatMs: 3_000,
    onStaleTurnRecoveryError(error) {
      safeWriteStderr(`[sidecar] stale turn recovery failed: ${safeErrorMessage(error)}\n`);
    },
    ...(model ? { model } : {}),
  });

  server = startRuntimeHttpServer({
    service: host.service,
    store: host.events,
    agents: host.agents,
    approvals: approvalQueue,
    userInputs: userInputQueue,
    permissions: host.permissions,
    commands: host.commands,
    mcp: host.mcp,
    authToken: token,
    hostname: "127.0.0.1",
    port: 0,
    onBackgroundError(error) {
      safeWriteStderr(`[sidecar] background runtime error: ${safeErrorMessage(error)}\n`);
    },
  });

  if (parentLossFixturePath) {
    if (!smokeMode) throw new Error("Parent-loss fixture requires CHILI_DESKTOP_SMOKE=1");
    await startParentLossFixture(parentLossFixturePath, workspace);
  }

  const health = await fetch(new URL("health", server.url), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!health.ok) {
    throw new Error(`Desktop sidecar health check failed with status ${health.status}`);
  }

  writeControlFrame({ type: READY_TYPE, url: server.url, pid: process.pid });
} catch (error) {
  safeWriteStderr(`[sidecar] startup failed: ${safeErrorMessage(error)}\n`);
  fixtureToolStart?.reject(error);
  fixtureToolStart = undefined;
  coordinator.requestGraceful("Desktop sidecar startup failed.", 1);
}

async function startParentLossFixture(path: string, workspace: string): Promise<void> {
  if (process.platform === "win32") throw new Error("Parent-loss fixture requires process groups");
  if (!isAbsolute(path)) throw new Error("CHILI_DESKTOP_PARENT_LOSS_FIXTURE_PATH must be absolute");
  const inherited = spawn("/bin/sleep", ["60"], {
    stdio: "ignore",
  });
  const inheritedPid = inherited.pid;
  if (!inheritedPid) throw new Error("Parent-loss inherited fixture did not receive a PID");

  let resolveToolPid: ((pid: number) => void) | undefined;
  let rejectToolPid: ((error: unknown) => void) | undefined;
  const toolPidPromise = new Promise<number>((resolvePromise, rejectPromise) => {
    resolveToolPid = resolvePromise;
    rejectToolPid = rejectPromise;
  });
  fixtureToolStart = {
    resolve: (pid) => resolveToolPid?.(pid),
    reject: (error) => rejectToolPid?.(error),
  };
  const toolRun = runProcess("bash", ["-lc", "sleep 60"], { cwd: workspace, killGraceMs: 100 });
  void toolRun.catch((error) => {
    fixtureToolStart?.reject(error);
    fixtureToolStart = undefined;
  });
  const toolProcessGroupPid = await toolPidPromise;
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({
    sidecarPid: process.pid,
    toolProcessGroupPid,
    inheritedPid,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

function writeControlFrame(frame: Record<string, unknown>): void {
  try {
    writeSync(1, `${JSON.stringify(frame)}\n`);
  } catch {
    // The parent pipe may already be gone; stdin/PID ownership will close us.
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnvironment(name: string): number {
  const value = Number.parseInt(requireEnvironment(name), 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function safeWriteStderr(message: string): void {
  try {
    process.stderr.write(message);
  } catch {
    // The parent may already have closed all inherited output handles.
  }
}
