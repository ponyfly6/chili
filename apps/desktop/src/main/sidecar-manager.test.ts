import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChiliEvent } from "@chili/protocol";
import {
  EventCursorResyncRequiredError,
  EventTransportResyncRequiredError,
  type RuntimeClient,
  type StreamEventsRequest,
} from "@chili/sdk";
import { processGroupExists, terminateProcessGroup } from "./process-groups.js";
import { MAX_DESKTOP_ERROR_MESSAGE_BYTES } from "../shared/safe-error.js";
import { MAX_SIDECAR_CONTROL_LINE_BYTES } from "./sidecar-control-stream.js";
import { SidecarManager } from "./sidecar-manager.js";
import { retryShutdownContainment } from "./shutdown-containment.js";

describe("desktop sidecar security boundary", () => {
  test("keeps the safe startup cause after all restart attempts are exhausted", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-startup-cause-"));
    const states: ReturnType<SidecarManager["state"]>[] = [];
    const logs: string[] = [];
    const childPids: number[] = [];
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: ({ env }) => {
        const child = spawn(process.execPath, ["-e", String.raw`
const { createReadStream, writeSync } = require("node:fs");
const chunks = [];
const credentials = createReadStream("", { fd: 3, autoClose: true });
credentials.on("data", (chunk) => chunks.push(chunk));
credentials.on("error", (error) => {
  writeSync(2, "fixture credential read failed: " + error.code + "\n");
  process.exit(2);
});
credentials.on("end", () => {
  const credential = Buffer.concat(chunks);
  const token = credential.toString().trim().split(":").at(-1);
  credential.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  writeSync(2, "unstructured stderr must not become desktop state\n");
  writeSync(1, JSON.stringify({
    type: "chili.sidecar.startup_error",
    message: "no such column: parent_session_id api_key=private-key " + token,
  }) + "\n");
});
process.stdin.resume();
setInterval(() => undefined, 1000);
`], {
          cwd: workspace,
          env,
          detached: true,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        childPids.push(child.pid ?? 0);
        return child;
      },
      healthCheck: async () => {
        throw new Error("A failed sidecar must not reach its health check");
      },
      onState: (state) => states.push(state),
      onLog: (stream, text) => logs.push(`${stream}: ${text}`),
    });
    try {
      await expect(manager.switchWorkspace(workspace)).rejects.toThrow("no such column: parent_session_id");
      await waitUntil(() => {
        const { sidecar } = manager.state();
        return sidecar.phase === "error" && sidecar.attempt === 3
          && sidecar.error?.startsWith("Sidecar stopped after 3 restart attempts:") === true;
      }, 8_000);
      expect(manager.state().sidecar.error).toContain("Sidecar stopped after 3 restart attempts: no such column: parent_session_id");
      const reflected = JSON.stringify(states);
      expect(reflected).not.toContain("private-key");
      expect(reflected).not.toContain("unstructured stderr");
      expect(childPids).toHaveLength(4);
      expect(childPids.every((pid) => pid > 0 && !processGroupExists(pid))).toBe(true);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nFixture state: ${JSON.stringify(manager.state())}\nFixture logs:\n${logs.join("\n")}`, { cause: error });
    } finally {
      await manager.stop().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  }, 12_000);

  test("renderer contract never exposes endpoint, token, or pid", async () => {
    const contracts = await readFile(resolve(import.meta.dirname, "../shared/contracts.ts"), "utf8");
    const desktopState = contracts.slice(contracts.indexOf("export interface DesktopState"), contracts.indexOf("export interface RuntimeSnapshot"));
    expect(desktopState).not.toContain("token");
    expect(desktopState).not.toContain("url");
    expect(desktopState).not.toContain("pid");
  });

  test("sidecar credential is transported only by a private inherited pipe", async () => {
    const manager = await readFile(resolve(import.meta.dirname, "sidecar-manager.ts"), "utf8");
    const sidecar = await readFile(resolve(import.meta.dirname, "../sidecar/index.ts"), "utf8");
    expect(manager).not.toContain("CHILI_DESKTOP_TOKEN: token");
    expect(manager).not.toContain('"--token"');
    expect(manager).toContain("delete env.CHILI_DESKTOP_TOKEN");
    expect(manager).toContain('stdio: ["pipe", "pipe", "pipe", "pipe"]');
    expect(sidecar).not.toContain('requireEnvironment("CHILI_DESKTOP_TOKEN")');
    expect(sidecar).toContain("SIDECAR_CREDENTIAL_FD");
  });

  test("strips main-only smoke canaries from the sidecar environment", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-main-only-env-"));
    const environmentKeys = [
      "CHILI_DESKTOP_SMOKE_RENDERER_NEEDLES",
      "CHILI_DESKTOP_SMOKE_SECRET_CANARY",
      "CHILI_DESKTOP_SMOKE_PATH_CANARY",
      "CHILI_DESKTOP_SMOKE",
      "CHILI_HOME",
    ] as const;
    const previousEnvironment = new Map(
      environmentKeys.map((key) => [key, process.env[key]] as const),
    );
    let capturedEnvironment: NodeJS.ProcessEnv | undefined;
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: ({ env }) => {
        capturedEnvironment = env;
        throw new Error("environment fixture captured");
      },
    });

    try {
      process.env.CHILI_DESKTOP_SMOKE_RENDERER_NEEDLES = '[{"label":"token","value":"secret"}]';
      process.env.CHILI_DESKTOP_SMOKE_SECRET_CANARY = "main-only-secret";
      process.env.CHILI_DESKTOP_SMOKE_PATH_CANARY = "/main-only/path";
      process.env.CHILI_DESKTOP_SMOKE = "1";
      process.env.CHILI_HOME = workspace;

      await expect(manager.switchWorkspace(workspace)).rejects.toThrow("environment fixture captured");
      expect(capturedEnvironment).toMatchObject({
        CHILI_DESKTOP_SMOKE: "1",
        CHILI_HOME: workspace,
      });
      expect(capturedEnvironment?.CHILI_DESKTOP_SMOKE_RENDERER_NEEDLES).toBeUndefined();
      expect(capturedEnvironment?.CHILI_DESKTOP_SMOKE_SECRET_CANARY).toBeUndefined();
      expect(capturedEnvironment?.CHILI_DESKTOP_SMOKE_PATH_CANARY).toBeUndefined();
    } finally {
      await manager.stop().catch(() => undefined);
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("contains a child when the private credential pipe is unavailable", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-missing-credential-pipe-"));
    let childPid = 0;
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: ({ env }) => {
        const child = spawn(
          process.execPath,
          ["-e", "process.stdin.resume(); setInterval(() => undefined, 1000)"],
          {
            cwd: workspace,
            env,
            detached: true,
            // Deliberately omit fd 3 to exercise fail-closed containment.
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        childPid = child.pid ?? 0;
        return child;
      },
      healthCheck: async () => {
        throw new Error("A child without its credential pipe must not reach health");
      },
    });
    try {
      await expect(manager.switchWorkspace(workspace)).rejects.toThrow(
        "Sidecar credential channel is unavailable",
      );
      expect(childPid).toBeGreaterThan(0);
      expect(processGroupExists(childPid)).toBe(false);
    } finally {
      await manager.stop().catch(() => undefined);
      if (childPid > 0 && processGroupExists(childPid)) {
        await terminateProcessGroup(childPid, { termGraceMs: 50, killGraceMs: 500 }).catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true });
    }
  }, 5_000);

  test("contains a child when the credential pipe closes without an error or write callback", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-credential-close-"));
    let childPid = 0;
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: ({ env }) => {
        const child = spawn(
          process.execPath,
          ["-e", "process.stdin.resume(); setInterval(() => undefined, 1000)"],
          {
            cwd: workspace,
            env,
            detached: true,
            stdio: ["pipe", "pipe", "pipe", "pipe"],
          },
        );
        childPid = child.pid ?? 0;
        const credentialPipe = child.stdio[3];
        if (!credentialPipe) throw new Error("Credential close fixture did not receive fd 3");
        Object.defineProperty(credentialPipe, "end", {
          configurable: true,
          value: () => {
            credentialPipe.emit("close");
            return credentialPipe;
          },
        });
        return child;
      },
      healthCheck: async () => {
        throw new Error("A closed credential pipe must not reach health");
      },
    });
    try {
      await expect(manager.switchWorkspace(workspace)).rejects.toThrow(
        "Sidecar credential delivery failed",
      );
      expect(childPid).toBeGreaterThan(0);
      expect(processGroupExists(childPid)).toBe(false);
    } finally {
      await manager.stop().catch(() => undefined);
      if (childPid > 0 && processGroupExists(childPid)) {
        await terminateProcessGroup(childPid, { termGraceMs: 50, killGraceMs: 500 }).catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true });
    }
  }, 5_000);

  test("rejects hostile ready identity and endpoints before health and contains the child", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-ready-admission-"));
    const cases = [
      {
        label: "spawned-child PID mismatch",
        readyUrl: "http://127.0.0.1:4312/",
        pidOffset: 1,
        expectedError: "Sidecar ready PID did not match the spawned child",
      },
      {
        label: "non-loopback endpoint",
        readyUrl: "http://192.0.2.1:4312/",
        pidOffset: 0,
        expectedError: "Sidecar reported a non-loopback endpoint",
      },
      {
        label: "credentialed loopback endpoint",
        readyUrl: "http://user:password@127.0.0.1:4312/",
        pidOffset: 0,
        expectedError: "Sidecar reported a non-loopback endpoint",
      },
    ] as const;
    try {
      for (const fixture of cases) {
        let childPid = 0;
        let healthChecks = 0;
        const stateTransitions: ReturnType<SidecarManager["state"]>[] = [];
        const manager = new SidecarManager({
          repositoryRoot: resolve(import.meta.dirname, "../../../.."),
          spawnSidecar: ({ env }) => {
            const child = spawn(process.execPath, ["-e", readyAdmissionFixtureSource()], {
              cwd: workspace,
              env: {
                ...env,
                FIXTURE_READY_URL: fixture.readyUrl,
                FIXTURE_PID_OFFSET: String(fixture.pidOffset),
              },
              detached: true,
              stdio: ["pipe", "pipe", "pipe", "pipe"],
            });
            childPid = child.pid ?? 0;
            return child;
          },
          healthCheck: async () => {
            healthChecks += 1;
          },
          onState: (state) => stateTransitions.push(state),
        });
        try {
          await expect(manager.switchWorkspace(workspace)).rejects.toThrow(fixture.expectedError);
          expect(healthChecks, fixture.label).toBe(0);
          expect(manager.state().sidecar, fixture.label).toMatchObject({
            phase: "recovering",
            attempt: 1,
          });
          expect(stateTransitions, fixture.label).toContainEqual(expect.objectContaining({
            sidecar: expect.objectContaining({
              phase: "error",
              error: fixture.expectedError,
            }),
          }));
          expect(childPid, fixture.label).toBeGreaterThan(0);
          expect(processGroupExists(childPid), fixture.label).toBe(false);
        } finally {
          await manager.stop().catch(() => undefined);
          if (childPid > 0 && processGroupExists(childPid)) {
            await terminateProcessGroup(childPid, { termGraceMs: 50, killGraceMs: 500 }).catch(() => undefined);
          }
        }
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 8_000);

  test("hands the exact private-pipe token and exit identity to health without process-table exposure", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-health-identity-"));
    let childPid = 0;
    let spawnToken: string | undefined;
    let healthInput: Parameters<NonNullable<ConstructorParameters<typeof SidecarManager>[0]["healthCheck"]>>[0]
      | undefined;
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: ({ env, token }) => {
        spawnToken = token;
        expect(env.CHILI_DESKTOP_TOKEN).toBeUndefined();
        const child = spawn(process.execPath, ["-e", readyAdmissionFixtureSource()], {
          cwd: workspace,
          env: {
            ...env,
            FIXTURE_READY_URL: "http://127.0.0.1:4312/",
            FIXTURE_PID_OFFSET: "0",
          },
          detached: true,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        childPid = child.pid ?? 0;
        return child;
      },
      healthCheck: async (input) => {
        healthInput = input;
      },
    });
    try {
      await manager.switchWorkspace(workspace);

      expect(manager.state().sidecar.phase).toBe("healthy");
      expect(healthInput?.endpoint.href).toBe("http://127.0.0.1:4312/");
      expect(healthInput?.token).toBe(spawnToken);
      expect(spawnToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(childPid).toBeGreaterThan(0);
      expect(processGroupExists(childPid)).toBe(true);
      if (process.platform === "darwin") {
        const processSnapshot = spawnSync(
          "/bin/ps",
          ["-Eww", "-p", String(childPid), "-o", "command="],
          {
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        if (processSnapshot.error) {
          const code = (processSnapshot.error as NodeJS.ErrnoException).code ?? "unknown";
          throw new Error(`macOS process-table credential audit could not launch ps (${code})`);
        }
        if (processSnapshot.status !== 0) {
          throw new Error(
            `macOS process-table credential audit failed (status=${processSnapshot.status ?? "null"}, `
            + `signal=${processSnapshot.signal ?? "null"})`,
          );
        }
        expect(processSnapshot.stdout).not.toContain(spawnToken);
        expect(processSnapshot.stdout).not.toContain("CHILI_DESKTOP_TOKEN=");
      }

      const exit = healthInput?.exit;
      if (!exit) throw new Error("Health fixture did not receive the sidecar exit identity");
      await manager.stop();
      expect(await exit).toEqual({ code: 0, signal: null });
      expect(processGroupExists(childPid)).toBe(false);
    } finally {
      await manager.stop().catch(() => undefined);
      if (childPid > 0 && processGroupExists(childPid)) {
        await terminateProcessGroup(childPid, { termGraceMs: 50, killGraceMs: 500 }).catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("cleans registered tool groups before restarting a crashed sidecar", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-supervisor-"));
    const fixturePath = join(workspace, "sidecar-fixture.cjs");
    const counterPath = join(workspace, "launch-count");
    const toolPidPath = join(workspace, "tool-pid");
    const violationPath = join(workspace, "overlap-detected");
    await writeFile(fixturePath, sidecarFixtureSource(), "utf8");
    let healthyCount = 0;
    const logs: string[] = [];
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: ({ env }) => spawn(process.execPath, [fixturePath], {
        cwd: workspace,
        env: {
          ...env,
          FIXTURE_COUNTER: counterPath,
          FIXTURE_TOOL_PID: toolPidPath,
          FIXTURE_VIOLATION: violationPath,
        },
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      }),
      healthCheck: async () => undefined,
      onState: (state) => {
        if (state.sidecar.phase === "healthy") healthyCount += 1;
      },
      onLog: (stream, text) => logs.push(`${stream}:${text}`),
    });
    try {
      await manager.switchWorkspace(workspace).catch((error) => {
        throw new Error(`${String(error)}\n${logs.join("\n")}`);
      });
      expect(healthyCount).toBe(1);
      await waitUntil(() => healthyCount >= 2, 8_000);
      await expect(readFile(violationPath, "utf8")).rejects.toThrow();
      const activeToolPid = Number(await readFile(toolPidPath, "utf8"));
      expect(processGroupExists(activeToolPid)).toBe(true);

      await manager.stop();
      expect(processGroupExists(activeToolPid)).toBe(false);
    } finally {
      const lastPid = Number(await readFile(toolPidPath, "utf8").catch(() => "0"));
      if (lastPid > 0 && processGroupExists(lastPid)) {
        await terminateProcessGroup(lastPid, { termGraceMs: 50, killGraceMs: 500 }).catch(() => undefined);
      }
      await manager.stop().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  }, 15_000);

  test("contains a healthy launch after a terminal control-stream overflow", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-control-overflow-"));
    const fixturePath = join(workspace, "sidecar-fixture.cjs");
    const counterPath = join(workspace, "launch-count");
    const firstSidecarPidPath = join(workspace, "first-sidecar-pid");
    const firstToolPidPath = join(workspace, "first-tool-pid");
    const activeToolPidPath = join(workspace, "active-tool-pid");
    const violationPath = join(workspace, "fail-open-detected");
    await writeFile(
      fixturePath,
      controlOverflowFixtureSource(MAX_SIDECAR_CONTROL_LINE_BYTES),
      "utf8",
    );
    let healthyCount = 0;
    const logs: string[] = [];
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: ({ env }) => spawn(process.execPath, [fixturePath], {
        cwd: workspace,
        env: {
          ...env,
          FIXTURE_COUNTER: counterPath,
          FIXTURE_FIRST_SIDECAR_PID: firstSidecarPidPath,
          FIXTURE_FIRST_TOOL_PID: firstToolPidPath,
          FIXTURE_ACTIVE_TOOL_PID: activeToolPidPath,
          FIXTURE_VIOLATION: violationPath,
        },
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      }),
      healthCheck: async () => undefined,
      onState: (state) => {
        if (state.sidecar.phase === "healthy") healthyCount += 1;
      },
      onLog: (stream, text) => logs.push(`${stream}:${text}`),
    });
    try {
      await manager.switchWorkspace(workspace).catch((error) => {
        throw new Error(`${String(error)}\n${logs.join("\n")}`);
      });
      expect(healthyCount).toBe(1);
      await waitUntil(() => existsSync(firstSidecarPidPath), 1_000);
      const firstSidecarPid = Number(await readFile(firstSidecarPidPath, "utf8"));
      const firstToolPid = Number(await readFile(firstToolPidPath, "utf8"));

      await waitUntil(() => healthyCount >= 2, 8_000);

      expect(logs.some((line) => line.includes("sidecar control stream failed:")
        && line.includes(`${MAX_SIDECAR_CONTROL_LINE_BYTES}-byte UTF-8 line limit`))).toBe(true);
      expect(processGroupExists(firstToolPid)).toBe(false);
      expect(processGroupExists(firstSidecarPid)).toBe(false);
      await expect(readFile(violationPath, "utf8")).rejects.toThrow();
      const activeToolPid = Number(await readFile(activeToolPidPath, "utf8"));
      expect(processGroupExists(activeToolPid)).toBe(true);

      await manager.stop();
      expect(processGroupExists(activeToolPid)).toBe(false);
    } finally {
      for (const path of [firstToolPidPath, activeToolPidPath, firstSidecarPidPath]) {
        const pid = Number(await readFile(path, "utf8").catch(() => "0"));
        if (pid > 0 && processGroupExists(pid)) {
          await terminateProcessGroup(pid, { termGraceMs: 50, killGraceMs: 500 }).catch(() => undefined);
        }
      }
      await manager.stop().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  }, 15_000);

  test("retains failed containment handles so stop can retry tool-group cleanup", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-containment-retry-"));
    const fixturePath = join(workspace, "sidecar-fixture.cjs");
    const counterPath = join(workspace, "launch-count");
    const firstSidecarPidPath = join(workspace, "first-sidecar-pid");
    const firstToolPidPath = join(workspace, "first-tool-pid");
    const activeToolPidPath = join(workspace, "active-tool-pid");
    const violationPath = join(workspace, "unexpected-restart");
    await writeFile(
      fixturePath,
      controlOverflowFixtureSource(MAX_SIDECAR_CONTROL_LINE_BYTES),
      "utf8",
    );
    let allowToolCleanup = false;
    let blockedToolCleanupAttempts = 0;
    let launchCount = 0;
    let sidecarPid = 0;
    let launchedChild: ChildProcessWithoutNullStreams | undefined;
    const cleanupPassword = "abc";
    const cleanupClientSecret = "sidecar-client-secret";
    const cleanupQuerySecret = "sidecar-query-secret";
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: ({ env }) => {
        launchCount += 1;
        const child = spawn(process.execPath, [fixturePath], {
          cwd: workspace,
          env: {
            ...env,
            FIXTURE_COUNTER: counterPath,
            FIXTURE_FIRST_SIDECAR_PID: firstSidecarPidPath,
            FIXTURE_FIRST_TOOL_PID: firstToolPidPath,
            FIXTURE_ACTIVE_TOOL_PID: activeToolPidPath,
            FIXTURE_VIOLATION: violationPath,
          },
          detached: true,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        sidecarPid = child.pid ?? 0;
        launchedChild = child;
        return child;
      },
      healthCheck: async () => undefined,
      processGroups: {
        terminate: async (pid, options) => {
          if (!allowToolCleanup && pid !== sidecarPid) {
            blockedToolCleanupAttempts += 1;
            // Model the post-deadline outcome deterministically: signaling has
            // failed and the existence probe below still sees the live group.
            throw new Error(
              `password=${cleanupPassword} client_secret=${cleanupClientSecret} `
              + `http://localhost:4312/fail?token=${cleanupQuerySecret} `
              + `Process group ${pid} survived the simulated cleanup deadline`,
            );
          }
          await terminateProcessGroup(pid, options);
        },
        exists: processGroupExists,
      },
    });
    try {
      await manager.switchWorkspace(workspace);
      const toolPid = Number(await readFile(firstToolPidPath, "utf8"));
      const internals = sidecarInternals(manager);

      await waitUntil(() => manager.state().sidecar.phase === "error", 4_000);

      expect(blockedToolCleanupAttempts).toBeGreaterThan(0);
      expect(launchCount).toBe(1);
      expect(manager.state().sidecar.attempt).toBe(0);
      expect(manager.state().sidecar.error).toContain("process cleanup is incomplete");
      expect(Buffer.byteLength(manager.state().sidecar.error ?? "", "utf8"))
        .toBeLessThanOrEqual(MAX_DESKTOP_ERROR_MESSAGE_BYTES);
      expect(manager.state().sidecar.error).not.toContain(cleanupPassword);
      expect(manager.state().sidecar.error).not.toContain(cleanupClientSecret);
      expect(manager.state().sidecar.error).not.toContain(cleanupQuerySecret);
      expect(manager.state().sidecar.error).not.toContain("localhost");
      expect(processGroupExists(sidecarPid)).toBe(false);
      expect(processGroupExists(toolPid)).toBe(true);
      expect(internals.child).toBe(launchedChild);
      expect(internals.childExit).toBeDefined();
      expect(internals.childClosed).toBeDefined();
      expect(internals.toolProcessGroups.has(toolPid)).toBe(true);
      expect(internals.restartTimer).toBeUndefined();
      await expect(readFile(violationPath, "utf8")).rejects.toThrow();

      const containment = await retryShutdownContainment({
        deadlineMs: 1_000,
        retryDelayMs: 1,
        stop: () => manager.stop(),
        wait: async () => {
          allowToolCleanup = true;
        },
      });

      expect(containment).toEqual({ status: "contained", attempts: 2 });
      expect(processGroupExists(toolPid)).toBe(false);
      expect(internals.child).toBeUndefined();
      expect(internals.childExit).toBeUndefined();
      expect(internals.childClosed).toBeUndefined();
      expect(internals.toolProcessGroups.size).toBe(0);
      expect(manager.state().sidecar.phase).toBe("idle");
    } finally {
      allowToolCleanup = true;
      await manager.stop().catch(() => undefined);
      for (const path of [firstToolPidPath, activeToolPidPath, firstSidecarPidPath]) {
        const pid = Number(await readFile(path, "utf8").catch(() => "0"));
        if (pid > 0 && processGroupExists(pid)) {
          await terminateProcessGroup(pid, { termGraceMs: 50, killGraceMs: 500 }).catch(() => undefined);
        }
      }
      await rm(workspace, { recursive: true, force: true });
    }
  }, 10_000);

  test("a queued stop supersedes a switch before it can launch", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-stop-switch-"));
    const cleanupEntered = deferred<void>();
    const allowCleanup = deferred<void>();
    let spawnCount = 0;
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: () => {
        spawnCount += 1;
        throw new Error("A superseded switch must not spawn");
      },
      healthCheck: async () => undefined,
    });
    try {
      const switching = manager.switchWorkspace(workspace, async () => {
        cleanupEntered.resolve();
        await allowCleanup.promise;
      });
      await cleanupEntered.promise;
      const stopping = manager.stop();
      allowCleanup.resolve();
      await Promise.all([switching, stopping]);

      expect(spawnCount).toBe(0);
      expect(manager.state().sidecar.phase).toBe("idle");
      expect(manager.currentWorkspace()).toBeUndefined();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      expect(spawnCount).toBe(0);
    } finally {
      allowCleanup.resolve();
      await manager.stop().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("a completed stop permanently rejects late workspace switches", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-terminal-stop-"));
    let spawnCount = 0;
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: () => {
        spawnCount += 1;
        throw new Error("A stopped manager must never spawn another sidecar");
      },
      healthCheck: async () => undefined,
    });
    try {
      await manager.stop();

      await expect(manager.switchWorkspace(workspace)).rejects.toThrow(
        "Sidecar manager has been stopped",
      );
      expect(spawnCount).toBe(0);
      expect(manager.state().sidecar.phase).toBe("idle");
      expect(manager.currentWorkspace()).toBeUndefined();
    } finally {
      await manager.stop().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("stop interrupts a sidecar launch that never becomes ready", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-never-ready-"));
    let childPid = 0;
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: ({ env }) => {
        const child = spawn(
          process.execPath,
          ["-e", "process.stdin.resume(); setInterval(() => undefined, 1000)"],
          {
            cwd: workspace,
            env,
            detached: true,
            stdio: ["pipe", "pipe", "pipe", "pipe"],
          },
        );
        childPid = child.pid ?? 0;
        return child;
      },
      healthCheck: async () => {
        throw new Error("A never-ready sidecar must not reach its health check");
      },
    });
    try {
      const switching = manager.switchWorkspace(workspace);
      await waitUntil(() => childPid > 0, 1_000);
      const startedAt = Date.now();
      const stopping = manager.stop();
      await Promise.race([
        Promise.all([switching, stopping]),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("stop waited for the sidecar ready timeout")), 4_000);
        }),
      ]);

      expect(Date.now() - startedAt).toBeLessThan(4_000);
      expect(processGroupExists(childPid)).toBe(false);
      expect(manager.state().sidecar.phase).toBe("idle");
      expect(manager.currentWorkspace()).toBeUndefined();
    } finally {
      await manager.stop().catch(() => undefined);
      if (childPid > 0 && processGroupExists(childPid)) {
        await terminateProcessGroup(childPid, { termGraceMs: 50, killGraceMs: 500 }).catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true });
    }
  }, 8_000);

  test("normal stop uses the graceful ownership frame without closing stdin", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(join(tmpdir(), "chili-sidecar-graceful-frame-"));
    const fixturePath = join(workspace, "sidecar-fixture.cjs");
    const markerPath = join(workspace, "graceful-marker");
    await writeFile(fixturePath, String.raw`
const { readFileSync, writeFileSync, writeSync } = require("node:fs");
const credential = readFileSync(3);
credential.fill(0);
writeSync(1, JSON.stringify({
  type: "chili.sidecar.ready",
  url: "http://127.0.0.1:3210/",
  pid: process.pid,
}) + "\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input !== "chili.sidecar.shutdown\n") return;
  writeFileSync(process.env.FIXTURE_MARKER, String(process.stdin.readableEnded));
  process.exit(0);
});
process.stdin.resume();
`, "utf8");
    const childPids: number[] = [];
    const manager = new SidecarManager({
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      spawnSidecar: ({ env }) => {
        const child = spawn(process.execPath, [fixturePath], {
          cwd: workspace,
          env: { ...env, FIXTURE_MARKER: markerPath },
          detached: true,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        if (!child.pid) throw new Error("Graceful ownership fixture did not receive a PID");
        childPids.push(child.pid);
        return child;
      },
      healthCheck: async () => undefined,
    });
    try {
      let initialLaunchError: unknown;
      try {
        await manager.switchWorkspace(workspace);
      } catch (error) {
        initialLaunchError = error;
      }
      if (initialLaunchError !== undefined) {
        expect(initialLaunchError).toBeInstanceOf(Error);
        expect((initialLaunchError as Error).message).toBe("Sidecar credential delivery failed");
        expect(manager.state().sidecar.phase).toBe("recovering");
        expect(manager.state().sidecar.attempt).toBe(1);
      }
      await waitUntil(() => manager.state().sidecar.phase === "healthy", 4_000);
      const launchAttempt = manager.state().sidecar.attempt;
      expect(childPids.length).toBe(launchAttempt + 1);
      expect(childPids.length).toBeLessThanOrEqual(4);

      await manager.stop();
      expect(await readFile(markerPath, "utf8")).toBe("false");
      expect(childPids.length).toBeGreaterThan(0);
      for (const childPid of childPids) expect(processGroupExists(childPid)).toBe(false);
      expect(manager.state().sidecar.phase).toBe("idle");
    } finally {
      await manager.stop().catch(() => undefined);
      for (const childPid of childPids) {
        if (childPid > 0 && processGroupExists(childPid)) {
          await terminateProcessGroup(childPid, { termGraceMs: 50, killGraceMs: 500 }).catch(() => undefined);
        }
      }
      await rm(workspace, { recursive: true, force: true });
    }
  }, 8_000);

  test("reconnects a clean event-stream EOF from the last durable cursor", async () => {
    const requests: StreamEventsRequest[] = [];
    let internals: SidecarManagerInternals;
    const client = eventClient((input) => {
      requests.push(input);
      if (requests.length === 1) return events(durableEvent("event_durable"));
      internals.stopping = true;
      return events();
    });
    const manager = new SidecarManager({ repositoryRoot: import.meta.dirname });
    internals = sidecarInternals(manager);

    await consumeForTest(internals, client);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.afterEventId).toBeUndefined();
    expect(requests[1]?.afterEventId).toBe("event_durable");
  });

  test("does not advance the reconnect cursor for transient output events", async () => {
    const requests: StreamEventsRequest[] = [];
    let internals: SidecarManagerInternals;
    const client = eventClient((input) => {
      requests.push(input);
      if (requests.length === 1) {
        return events(
          durableEvent("event_before_output"),
          transientEvent("event_transient_output"),
        );
      }
      internals.stopping = true;
      return events();
    });
    const manager = new SidecarManager({ repositoryRoot: import.meta.dirname });
    internals = sidecarInternals(manager);

    await consumeForTest(internals, client);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.afterEventId).toBe("event_before_output");
  });

  test("clears a stale cursor and emits exactly one resync before reconnecting", async () => {
    const requests: StreamEventsRequest[] = [];
    const resyncReasons: string[] = [];
    let internals: SidecarManagerInternals;
    const client = eventClient((input) => {
      requests.push(input);
      if (requests.length === 1) return events(durableEvent("event_stale"));
      if (requests.length === 2) {
        return failedEvents(new EventCursorResyncRequiredError("cursor expired", "event_stale"));
      }
      internals.stopping = true;
      return events();
    });
    const manager = new SidecarManager({
      repositoryRoot: import.meta.dirname,
      onResync: (reason) => resyncReasons.push(reason),
    });
    internals = sidecarInternals(manager);

    await consumeForTest(internals, client);

    expect(requests.map((request) => request.afterEventId)).toEqual([
      undefined,
      "event_stale",
      undefined,
    ]);
    expect(resyncReasons).toEqual(["cursor expired"]);
  });

  test("skips exactly one legacy transport-poison row and resyncs before reconnecting", async () => {
    const requests: StreamEventsRequest[] = [];
    const resyncReasons: string[] = [];
    let internals: SidecarManagerInternals;
    const client = eventClient((input) => {
      requests.push(input);
      if (requests.length === 1) {
        return failedEvents(new EventTransportResyncRequiredError(
          "oversized persisted event requires authoritative resync",
          "event_legacy_poison",
        ));
      }
      if (requests.length === 2) return events(durableEvent("event_after_poison"));
      internals.stopping = true;
      return events();
    });
    const manager = new SidecarManager({
      repositoryRoot: import.meta.dirname,
      onResync: (reason) => resyncReasons.push(reason),
    });
    internals = sidecarInternals(manager);

    await consumeForTest(internals, client);

    expect(requests.map((request) => request.afterEventId)).toEqual([
      undefined,
      "event_legacy_poison",
      "event_after_poison",
    ]);
    expect(resyncReasons).toEqual(["oversized persisted event requires authoritative resync"]);
  });

  test("stop cancels an in-progress transport reconnect backoff", async () => {
    const reconnectLogged = deferred<void>();
    const client = eventClient(() => failedEvents(new Error("connection reset")));
    const manager = new SidecarManager({
      repositoryRoot: import.meta.dirname,
      onLog: (_stream, text) => {
        if (text.includes("runtime event stream reconnect 1")) reconnectLogged.resolve();
      },
    });
    const internals = sidecarInternals(manager);
    internals.generation = 1;
    internals.stopping = false;
    internals.client = client;
    const consuming = internals.consumeEvents(1, client);
    await reconnectLogged.promise;

    internals.stopping = true;
    internals.eventController?.abort();
    const cancelledPromptly = await Promise.race([
      consuming.then(() => true),
      new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 100)),
    ]);

    expect(cancelledPromptly).toBe(true);
  });

  test("enforces three restart attempts and resets the budget after 30 healthy seconds", async () => {
    const manager = new SidecarManager({ repositoryRoot: import.meta.dirname });
    const internals = sidecarInternals(manager);
    const workspace = "/test/workspace";
    internals.workspace = workspace;
    internals.generation = 7;
    internals.stopping = false;
    let launchCalls = 0;
    internals.launch = async () => {
      launchCalls += 1;
      throw new Error(`launch ${launchCalls} failed`);
    };

    internals.noteFailureAndSchedule(new Error("initial launch failed"), 7, workspace);
    expect(manager.state().sidecar.attempt).toBe(1);
    for (const [index, delayMs] of [250, 750, 2_000].entries()) {
      const timer = requireInspectableTimer(internals.restartTimer, "restart");
      expect(timer._idleTimeout).toBe(delayMs);
      fireTimer(timer);
      await flushMicrotasksUntil(
        () => launchCalls === index + 1
          && (index === 2 || internals.restartTimer !== undefined),
        "restart attempt did not settle",
      );
    }

    expect(launchCalls).toBe(3);
    expect(internals.consecutiveFailures).toBe(4);
    expect(internals.restartTimer).toBeUndefined();
    expect(manager.state().sidecar).toEqual({
      phase: "error",
      attempt: 3,
      error: "Sidecar stopped after 3 restart attempts: launch 3 failed",
    });

    const child = Object.create(null) as ChildProcessWithoutNullStreams;
    internals.child = child;
    internals.phase = "healthy";
    internals.consecutiveFailures = 3;
    internals.attempt = 3;
    internals.armStableHealthWindow(7, workspace, child);
    const stabilityTimer = requireInspectableTimer(internals.stabilityTimer, "stability");
    expect(stabilityTimer._idleTimeout).toBe(30_000);
    fireTimer(stabilityTimer);

    expect(internals.consecutiveFailures).toBe(0);
    expect(manager.state().sidecar.attempt).toBe(0);
    internals.noteFailureAndSchedule(new Error("failure after stable window"), 7, workspace);
    expect(manager.state().sidecar.attempt).toBe(1);
    expect(requireInspectableTimer(internals.restartTimer, "reset restart")._idleTimeout).toBe(250);
    internals.stopping = true;
    internals.cancelRestartTimer();
    await flushMicrotasksUntil(
      () => internals.restartPromise === undefined,
      "cancelled restart did not settle",
    );
  });
});

function sidecarFixtureSource(): string {
  return String.raw`
const { spawn } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync, writeSync } = require("node:fs");

const credential = readFileSync(3);
credential.fill(0);

const firstLaunch = !existsSync(process.env.FIXTURE_COUNTER);
if (!firstLaunch && existsSync(process.env.FIXTURE_TOOL_PID)) {
  const oldPid = Number(readFileSync(process.env.FIXTURE_TOOL_PID, "utf8"));
  try {
    process.kill(-oldPid, 0);
    writeFileSync(process.env.FIXTURE_VIOLATION, String(oldPid));
  } catch {}
}

const tool = spawn("bash", ["-lc", "sleep 30 & wait"], {
  detached: true,
  stdio: "ignore",
});
writeFileSync(process.env.FIXTURE_TOOL_PID, String(tool.pid));
writeSync(1, JSON.stringify({ type: "chili.sidecar.process", action: "started", pid: tool.pid }) + "\n");

writeSync(1, JSON.stringify({
  type: "chili.sidecar.ready",
  url: "http://127.0.0.1:3210/",
  pid: process.pid,
}) + "\n");
if (firstLaunch) {
  writeFileSync(process.env.FIXTURE_COUNTER, "1");
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 150);
}
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk === "chili.sidecar.shutdown\n") process.exit(0);
});
`;
}

function readyAdmissionFixtureSource(): string {
  return String.raw`
const { readFileSync, writeSync } = require("node:fs");
const credential = readFileSync(3);
credential.fill(0);
writeSync(1, JSON.stringify({
  type: "chili.sidecar.ready",
  url: process.env.FIXTURE_READY_URL,
  pid: process.pid + Number(process.env.FIXTURE_PID_OFFSET),
}) + "\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.includes("chili.sidecar.shutdown\n")) process.exit(0);
});
process.stdin.resume();
`;
}

function controlOverflowFixtureSource(lineLimit: number): string {
  return String.raw`
const { spawn } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync, writeSync } = require("node:fs");

const credential = readFileSync(3);
credential.fill(0);

const firstLaunch = !existsSync(process.env.FIXTURE_COUNTER);
if (!firstLaunch && existsSync(process.env.FIXTURE_FIRST_TOOL_PID)) {
  const oldPid = Number(readFileSync(process.env.FIXTURE_FIRST_TOOL_PID, "utf8"));
  try {
    process.kill(-oldPid, 0);
    writeFileSync(process.env.FIXTURE_VIOLATION, String(oldPid));
  } catch (error) {
    if (error && error.code === "EPERM") {
      writeFileSync(process.env.FIXTURE_VIOLATION, String(oldPid));
    }
  }
}
const tool = spawn("/bin/sleep", ["30"], {
  detached: true,
  stdio: "ignore",
});
writeFileSync(
  firstLaunch ? process.env.FIXTURE_FIRST_TOOL_PID : process.env.FIXTURE_ACTIVE_TOOL_PID,
  String(tool.pid),
);
writeSync(1, JSON.stringify({ type: "chili.sidecar.process", action: "started", pid: tool.pid }) + "\n");
writeSync(1, JSON.stringify({
  type: "chili.sidecar.ready",
  url: "http://127.0.0.1:3210/",
  pid: process.pid,
}) + "\n");
if (firstLaunch) {
  writeFileSync(process.env.FIXTURE_COUNTER, "1");
  writeFileSync(process.env.FIXTURE_FIRST_SIDECAR_PID, String(process.pid));
  setTimeout(() => writeSync(1, "x".repeat(${lineLimit + 1})), 100);
}
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk === "chili.sidecar.shutdown\n") process.exit(0);
});
`;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for sidecar restart");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value as T) };
}

interface SidecarManagerInternals {
  workspace: string | undefined;
  child: ChildProcessWithoutNullStreams | undefined;
  childExit: Promise<unknown> | undefined;
  childClosed: Promise<unknown> | undefined;
  toolProcessGroups: Set<number>;
  client: RuntimeClient | undefined;
  phase: ReturnType<SidecarManager["state"]>["sidecar"]["phase"];
  attempt: number;
  consecutiveFailures: number;
  generation: number;
  stopping: boolean;
  eventController: AbortController | undefined;
  restartPromise: Promise<void> | undefined;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  stabilityTimer: ReturnType<typeof setTimeout> | undefined;
  launch(signal?: AbortSignal): Promise<void>;
  consumeEvents(generation: number, client: RuntimeClient): Promise<void>;
  noteFailureAndSchedule(error: unknown, generation: number, workspace: string): void;
  armStableHealthWindow(
    generation: number,
    workspace: string,
    child: ChildProcessWithoutNullStreams,
  ): void;
  cancelRestartTimer(): void;
}

interface InspectableTimer extends ReturnType<typeof setTimeout> {
  _idleTimeout?: number;
  _onTimeout(): void;
}

function sidecarInternals(manager: SidecarManager): SidecarManagerInternals {
  return manager as unknown as SidecarManagerInternals;
}

function eventClient(
  streamEvents: (input: StreamEventsRequest) => AsyncIterable<ChiliEvent>,
): RuntimeClient {
  return { streamEvents } as unknown as RuntimeClient;
}

async function consumeForTest(
  internals: SidecarManagerInternals,
  client: RuntimeClient,
): Promise<void> {
  internals.generation = 1;
  internals.stopping = false;
  internals.client = client;
  await internals.consumeEvents(1, client);
}

async function* events(...input: ChiliEvent[]): AsyncGenerator<ChiliEvent> {
  for (const event of input) yield event;
}

async function* failedEvents(error: Error): AsyncGenerator<ChiliEvent> {
  throw error;
}

function durableEvent(id: string): ChiliEvent {
  return {
    id,
    type: "session.created",
    time: 1,
    sessionId: "session_1",
    payload: { sessionId: "session_1", cwd: "/test/workspace" },
  } as ChiliEvent;
}

function transientEvent(id: string): ChiliEvent {
  return {
    id,
    type: "tool.output_delta",
    time: 2,
    sessionId: "session_1",
    payload: { callId: "call_1", stream: "stdout", delta: "chunk" },
  } as ChiliEvent;
}

function requireInspectableTimer(
  timer: ReturnType<typeof setTimeout> | undefined,
  label: string,
): InspectableTimer {
  if (!timer) throw new Error(`Expected ${label} timer`);
  const inspectable = timer as InspectableTimer;
  if (typeof inspectable._onTimeout !== "function") throw new Error(`${label} timer is not inspectable`);
  return inspectable;
}

function fireTimer(timer: InspectableTimer): void {
  const onTimeout = timer._onTimeout;
  clearTimeout(timer);
  onTimeout.call(timer);
}

async function flushMicrotasksUntil(
  predicate: () => boolean,
  failureMessage: string,
): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(failureMessage);
}
