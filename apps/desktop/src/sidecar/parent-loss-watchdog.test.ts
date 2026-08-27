import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { forceKillOwnedProcessGroups } from "./parent-loss-watchdog.js";

test("parent pipe EOF contains tool and inherited process groups when shutdown never settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-parent-loss-watchdog-"));
  const fixture = join(directory, "fixture.ts");
  const modulePath = resolve(import.meta.dirname, "parent-loss-watchdog.ts");
  await writeFile(fixture, `
import { spawn } from "node:child_process";
import { createParentLossWatchdog, forceKillOwnedProcessGroups } from ${JSON.stringify(modulePath)};
import { writeSync } from "node:fs";

const inherited = spawn("/bin/sleep", ["30"], {
  stdio: "ignore",
});
const tool = spawn("bash", ["-lc", "sleep 30 & wait"], {
  detached: true,
  stdio: "ignore",
});
const toolGroups = new Set([tool.pid]);

const watchdog = createParentLossWatchdog({
  deadlineMs: 100,
  onDeadline() {
    forceKillOwnedProcessGroups(toolGroups);
  },
});
process.stdin.resume();
process.stdin.once("end", () => {
  watchdog.arm();
  void new Promise(() => undefined);
});
writeSync(1, JSON.stringify({ sidecar: process.pid, tool: tool.pid, inherited: inherited.pid }) + "\\n");
`, "utf8");

  const child = spawn(process.execPath, [fixture], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  let pids: { sidecar: number; tool: number; inherited: number } | undefined;
  try {
    const ready = await Promise.race([
      once(child.stdout, "data"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fixture did not become ready")), 1_000)),
    ]);
    pids = JSON.parse(String(ready[0]).trim()) as typeof pids;
    child.stdin.end();
    const [code, signal] = await Promise.race([
      exit,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("orphan watchdog did not exit")), 1_000)),
    ]);
    expect(code === 1 || signal === "SIGKILL").toBe(true);
    await waitUntil(() => pids !== undefined
      && !processGroupExists(pids.sidecar)
      && !processGroupExists(pids.tool)
      && !processExists(pids.inherited));
    expect(pids && [
      processGroupExists(pids.sidecar),
      processGroupExists(pids.tool),
      processExists(pids.inherited),
    ]).toEqual([false, false, false]);
  } finally {
    const cleanupPids = pids ? Object.values(pids) : [child.pid];
    for (const pid of cleanupPids) forceCleanup(pid);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a real parent SIGKILL contains the sidecar group, detached tool group, and inherited child", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "chili-parent-sigkill-"));
  const sidecarFixture = join(directory, "sidecar.ts");
  const parentFixture = join(directory, "parent.ts");
  const watchdogPath = resolve(import.meta.dirname, "parent-loss-watchdog.ts");
  const coordinatorPath = resolve(import.meta.dirname, "shutdown-coordinator.ts");
  await writeFile(sidecarFixture, `
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { forceKillOwnedProcessGroups } from ${JSON.stringify(watchdogPath)};
import { createSidecarShutdownCoordinator } from ${JSON.stringify(coordinatorPath)};

const inherited = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
const tool = spawn("bash", ["-lc", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
const toolGroups = new Set([tool.pid]);
const coordinator = createSidecarShutdownCoordinator({
  deadlineMs: 100,
  hardContain() { forceKillOwnedProcessGroups(toolGroups); },
  exit(code) { process.exit(code); },
  onCloseError() {},
  teardownObservation() {},
});
coordinator.installClose(() => new Promise(() => undefined));
const parentGone = () => coordinator.markParentGone("parent ownership lost");
process.stdin.once("end", parentGone);
process.stdin.once("close", parentGone);
process.stdin.resume();
writeSync(1, JSON.stringify({ sidecar: process.pid, tool: tool.pid, inherited: inherited.pid }) + "\\n");
`, "utf8");
  await writeFile(parentFixture, `
import { spawn } from "node:child_process";
const sidecar = spawn(process.execPath, [${JSON.stringify(sidecarFixture)}], {
  detached: true,
  stdio: ["pipe", "pipe", "ignore"],
});
sidecar.stdout.pipe(process.stdout);
setInterval(() => undefined, 1000);
`, "utf8");

  const parent = spawn(process.execPath, [parentFixture], { stdio: ["ignore", "pipe", "pipe"] });
  let pids: { sidecar: number; tool: number; inherited: number } | undefined;
  try {
    pids = JSON.parse(await readFirstLine(parent.stdout, 1_000)) as typeof pids;
    if (!pids) throw new Error("Parent-loss fixture omitted process IDs");
    expect(processGroupExists(pids.sidecar)).toBe(true);
    expect(processGroupExists(pids.tool)).toBe(true);
    expect(processExists(pids.inherited)).toBe(true);

    process.kill(parent.pid!, "SIGKILL");
    await Promise.race([
      once(parent, "exit"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("parent did not die")), 1_000)),
    ]);
    await waitUntil(() => pids !== undefined
      && !processGroupExists(pids.sidecar)
      && !processGroupExists(pids.tool)
      && !processExists(pids.inherited), 2_000);
  } finally {
    forceCleanup(parent.pid);
    if (pids) {
      forceCleanup(pids.tool);
      forceCleanup(pids.sidecar);
      forceCleanup(pids.inherited);
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 5_000);

test("force containment signals detached tool groups before the sidecar group", () => {
  const signals: Array<number | string> = [];
  expect(() => forceKillOwnedProcessGroups(new Set([41, 42]), 99, {
    platform: "darwin",
    kill(pid) {
      signals.push(pid);
    },
    exit(code) {
      signals.push(`exit:${code}`);
      throw new Error("exit sentinel");
    },
    writeError() {},
  })).toThrow("exit sentinel");
  expect(signals).toEqual([-41, -42, -99, "exit:1"]);
});

test("production parent-loss fixture uses a standalone-safe inherited helper", async () => {
  const source = await readFile(resolve(import.meta.dirname, "index.ts"), "utf8");
  const fixture = source.slice(source.indexOf("async function startParentLossFixture"));
  expect(fixture).toContain('spawn("/bin/sleep", ["60"]');
  expect(fixture).not.toContain("spawn(process.execPath");
});

test("periodic parent observation reuses the EPERM-aware liveness probe", async () => {
  const source = await readFile(resolve(import.meta.dirname, "index.ts"), "utf8");
  const periodicProbe = source.slice(
    source.indexOf("const parentWatch = setInterval"),
    source.indexOf("parentWatch.unref()"),
  );
  const processProbe = source.slice(source.indexOf("function processExists"));
  expect(periodicProbe).toContain("if (!processExists(parentPid))");
  expect(periodicProbe).not.toContain("process.kill(parentPid, 0)");
  expect(processProbe).toContain('code === "EPERM"');
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupExists(pid: number): boolean {
  if (process.platform === "win32") return processExists(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceCleanup(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group may already have exited or pid may not be its leader.
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

async function readFirstLine(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error("fixture did not become ready")), timeoutMs);
    const onData = (chunk: string | Buffer): void => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(undefined, buffer.slice(0, newline));
    };
    const onEnd = (): void => finish(new Error("fixture output ended before ready"));
    const finish = (error?: Error, line?: string): void => {
      clearTimeout(timeout);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      if (error) rejectPromise(error);
      else resolvePromise(line ?? "");
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("owned process survived parent-loss containment");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
