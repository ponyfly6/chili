#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DesktopSmokeOwnership, type SmokeProcess } from "./desktop-smoke-ownership.js";

// Bun owns process identities and all signals. The Node driver only operates
// Playwright's real Electron connection and asks this parent to inspect/kill.
if (process.platform !== "darwin") throw new Error("Desktop project process smoke requires macOS");
const repositoryRoot = resolve(import.meta.dirname, "..");
const desktopRoot = join(repositoryRoot, "apps/desktop");
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "chili-desktop-projects-")));
const bundleRoot = await mkdtemp(join(desktopRoot, "e2e/.projects-node-"));
const ownership = new DesktopSmokeOwnership();
const sentinelOwnership = new DesktopSmokeOwnership();
const sentinel = Bun.spawn({ cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"], detached: true, stdout: "ignore", stderr: "ignore" });
sentinelOwnership.registerSpawn(sentinel.pid);
let driver: ReturnType<typeof Bun.spawn> | undefined;
let observing: ReturnType<typeof setInterval> | undefined;
let driverDeadline: ReturnType<typeof setTimeout> | undefined;
let inspectionFailure: unknown;
let completed = false;
const launches = new Map<number, SmokeProcess>();
let cleanupPromise: Promise<void> | undefined;
let stopping = false;
observing = setInterval(() => {
  try { ownership.scan(); } catch (error) { inspectionFailure = error; }
}, 100);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup().then(() => process.exit(signal === "SIGINT" ? 130 : 143), (error) => {
      process.stderr.write(`Project smoke interruption cleanup failed: ${String(error)}\n`);
      process.exit(1);
    });
  });
}

try {
  await mkdir(join(temporaryRoot, "artifacts"));
  if (process.env.CHILI_DESKTOP_PROJECTS_SKIP_BUILD !== "1") {
    // This command uses this checkout's output directories. Concurrent callers
    // must use distinct worktrees, just as the multi-project task gate does.
    await checked([process.execPath, "run", "typecheck"]);
    await checked([process.execPath, "run", "desktop:build"]);
  }
  const build = await Bun.build({
    entrypoints: [join(desktopRoot, "e2e/projects-process-harness.ts")],
    outdir: bundleRoot,
    target: "node",
    packages: "external",
    sourcemap: "inline",
  });
  assertNotStopping();
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  driver = Bun.spawn({
    cmd: ["node", join(bundleRoot, "projects-process-harness.js")],
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CHILI_PROJECTS_REPOSITORY_ROOT: repositoryRoot,
      CHILI_PROJECTS_TEMPORARY_ROOT: temporaryRoot,
      CHILI_PROJECTS_BUN_PATH: process.execPath,
    },
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  ownership.registerSpawn(driver.pid);
  driverDeadline = setTimeout(() => {
    inspectionFailure = new Error("Desktop project driver exceeded its five-minute deadline");
    void cleanup().catch((error) => { inspectionFailure = new AggregateError([inspectionFailure, error]); });
  }, 300_000);
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of driver.stdout as ReadableStream<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    assert.ok(pending.length < 1_000_000, "Oversized driver output");
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.startsWith("CHILI_PROJECT_PROCESS_REQUEST ")) {
        process.stdout.write(`${line}\n`);
        continue;
      }
      const request = JSON.parse(line.slice("CHILI_PROJECT_PROCESS_REQUEST ".length)) as Request;
      try {
        const value = await inspect(request);
        (driver.stdin as { write(text: string): unknown }).write(`${JSON.stringify({ id: request.id, value })}\n`);
      } catch (error) {
        (driver.stdin as { write(text: string): unknown }).write(`${JSON.stringify({ id: request.id, error: String(error) })}\n`);
      }
    }
  }
  assert.equal(await driver.exited, 0, `Project process smoke failed; artifacts: ${temporaryRoot}/artifacts`);
  if (inspectionFailure) throw inspectionFailure;
  assert.deepEqual(ownership.scan(), [], "A successful driver must leave no owned processes");
  assertSentinel();
  completed = true;
  process.stdout.write(`desktop projects smoke passed; measurements and screenshots: ${temporaryRoot}/artifacts\n`);
} finally {
  await cleanup();
}

function cleanup(): Promise<void> {
  stopping = true;
  cleanupPromise ??= performCleanup();
  return cleanupPromise;
}

async function performCleanup(): Promise<void> {
  if (driverDeadline) clearTimeout(driverDeadline);
  const errors: unknown[] = [];
  const attempt = async (operation: () => unknown | Promise<unknown>): Promise<void> => {
    try { await operation(); } catch (error) { errors.push(error); }
  };
  // Never turn containment failure into success by cleaning leaked children.
  // Give each main's sidecar watchdog six seconds before fallback signals.
  for (const launch of launches.values()) await attempt(() => ownership.signalPid(launch.pid, "SIGTERM"));
  if (!completed) {
    await waitFor(() => ownedRuntimeRows().length === 0, 6_000).catch(() => undefined);
    for (const row of ownership.scan()) await attempt(() => ownership.signalPid(row.pid, "SIGKILL"));
    await attempt(() => waitFor(() => ownership.scan().length === 0, 5_000));
  }
  if (driver) await attempt(() => deadline(driver.exited, 5_000));
  await attempt(assertSentinel);
  await attempt(() => sentinelOwnership.signalPid(sentinel.pid, "SIGTERM"));
  await attempt(() => deadline(sentinel.exited, 5_000));
  await attempt(() => rm(bundleRoot, { recursive: true, force: true }));
  if (observing) clearInterval(observing);
  if (errors.length) throw new AggregateError(errors, "Project smoke cleanup failed");
}

interface Request {
  id: number;
  action: "observe" | "fixtures" | "kill" | "gone";
  electronPid: number;
  workspaces?: string[];
  toolPids?: number[];
}

async function inspect(request: Request): Promise<unknown> {
  assertNotStopping();
  if (inspectionFailure) throw inspectionFailure;
  assertSentinel();
  const rows = ownership.scan();
  if (request.action === "observe") {
    const main = rows.find((row) => row.pid === request.electronPid);
    assert.ok(main && main.parentPid === driver?.pid && main.command.includes("Electron.app/Contents/MacOS/Electron"), "Electron PID is not a direct, owned driver launch");
    launches.set(main.pid, main);
    const sidecars = rows.filter((row) => row.parentPid === main.pid
      && /apps\/desktop\/src\/sidecar\/(?:index|entry)\.ts(?:\s|$)/u.test(row.command)
      && !row.command.includes("--chili-git-supervisor-v1"));
    return {
      electronPid: main.pid,
      sidecarPids: sidecars.map((row) => row.pid).sort((a, b) => a - b),
      rssKiB: readRss([main.pid, ...sidecars.map((row) => row.pid)]),
      processCount: rows.filter((row) => row.pid !== driver?.pid).length,
    };
  }
  const launch = launches.get(request.electronPid);
  assert.ok(launch, "Unregistered Electron launch");
  if (request.action === "fixtures") {
    const toolPids = request.toolPids ?? [];
    assert.equal(toolPids.length, 6, "Expected a guarded shell and inherited child for each of three projects");
    const toolGroups: Array<{ sidecarPid: number; guardianPid: number; guardianStartedAt: string; shellPid: number; childPid: number }> = [];
    for (let index = 0; index < toolPids.length; index += 2) {
      const shell = rows.find((row) => row.pid === toolPids[index]);
      const child = rows.find((row) => row.pid === toolPids[index + 1]);
      assert.ok(shell && child, "Tool fixture PIDs must be observed under this run");
      const guardian = rows.find((row) => row.pid === shell.parentPid);
      assert.ok(guardian, "Tool shell must be a direct child of its observed guardian");
      assert.equal(guardian.pid, guardian.processGroupPid, "Tool guardian must lead its detached process group");
      assert.equal(shell.processGroupPid, guardian.pid, "Tool shell must inherit its guardian's process group");
      assert.equal(child.processGroupPid, guardian.pid, "Tool child must remain in the guarded process group");
      assert.equal(child.parentPid, shell.pid, "Tool child must be a direct child of the recorded shell");
      const sidecar = rows.find((row) => row.pid === guardian.parentPid);
      assert.ok(sidecar && sidecar.parentPid === launch.pid
        && /apps\/desktop\/src\/sidecar\/(?:index|entry)\.ts(?:\s|$)/u.test(sidecar.command)
        && !sidecar.command.includes("--chili-git-supervisor-v1"), "Tool guardian must descend from an owned project sidecar");
      toolGroups.push({ sidecarPid: sidecar.pid, guardianPid: guardian.pid, guardianStartedAt: guardian.startedAt,
        shellPid: shell.pid, childPid: child.pid });
    }
    assert.equal(new Set(toolGroups.map((group) => group.sidecarPid)).size, 3, "Each tool group must belong to a different project sidecar");
    assert.equal(new Set(toolGroups.map((group) => group.guardianPid)).size, 3, "Each project must own a separate guarded tool group");
    const git = (request.workspaces ?? []).map((workspace) => {
      const matches = rows.filter((row) => row.parentPid === launch.pid && row.command.includes(`--work-tree=${workspace}`));
      assert.equal(matches.length, 1, `Expected one blocked main-owned Git for ${workspace}`);
      const row = matches[0]!;
      assert.equal(row.processGroupPid, row.pid, "Git fixture must use the real detached command group");
      const supervised = row.command.includes("--chili-git-supervisor-v1");
      const command = supervised
        ? rows.filter((candidate) => candidate.parentPid === row.pid && candidate.command.includes(`--work-tree=${workspace}`))
        : [row];
      assert.equal(command.length, 1, "Expected the actual blocked Git child, not only its supervisor");
      const git = command[0]!;
      assert.equal(git.processGroupPid, row.pid, "Supervised Git must inherit the registered helper group");
      return {
        workspace, pid: git.pid, startedAt: git.startedAt,
        ...(supervised ? { supervisorPid: row.pid, supervisorStartedAt: row.startedAt } : {}),
      };
    });
    return { git, toolPids: request.toolPids, toolGroups };
  }
  if (request.action === "kill") {
    const current = rows.find((row) => row.pid === launch.pid);
    assert.equal(current?.startedAt, launch.startedAt, "Electron launch identity changed before hard kill");
    ownership.signalPid(launch.pid, "SIGKILL");
    return { killedExactElectronPid: launch.pid };
  }
  const startedAt = performance.now();
  await waitFor(() => ownedRuntimeRows().length === 0, 12_000);
  assertSentinel();
  return { containmentMs: Math.round(performance.now() - startedAt), sentinelAlive: true };
}

function ownedRuntimeRows(): SmokeProcess[] {
  return ownership.scan().filter((row) => row.pid !== driver?.pid);
}

function assertSentinel(): void {
  assert.ok(sentinelOwnership.scan().some((row) => row.pid === sentinel.pid), "Independent sentinel was affected");
  assert.ok(!ownership.scan().some((row) => row.pid === sentinel.pid), "Runtime ownership claimed independent sentinel");
}

function readRss(pids: number[]): Record<number, number> {
  const result = Bun.spawnSync({ cmd: ["/bin/ps", "-o", "pid=,rss=", "-p", pids.join(",")], stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, "RSS observation failed");
  return Object.fromEntries(result.stdout.toString().trim().split("\n").map((line) => line.trim().split(/\s+/u).map(Number)));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await Bun.sleep(40);
  }
  const survivors = ownedRuntimeRows().map(({ pid, parentPid, processGroupPid, command }) => ({ pid, parentPid, processGroupPid, command }));
  await writeFile(join(temporaryRoot, "artifacts/survivors.json"), JSON.stringify(survivors, null, 2));
  throw new Error(`Owned runtime processes survived containment: ${JSON.stringify(survivors)}`);
}

async function checked(command: string[]): Promise<void> {
  assertNotStopping();
  const child = Bun.spawn({ cmd: command, cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" });
  ownership.registerSpawn(child.pid);
  try {
    assert.equal(await deadline(child.exited, 300_000), 0, `Command failed: ${command[1]}`);
    assertNotStopping();
  }
  finally { if (child.exitCode === null) ownership.signalPid(child.pid, "SIGTERM"); }
}

function assertNotStopping(): void {
  if (stopping) throw new Error("Desktop project smoke is shutting down");
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Process deadline exceeded")), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
