import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { createBashTool, createUnsandboxedBashRunner, type BashRunRequest } from "./builtins/bash.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import { FileSystemSnapshotProvider } from "./snapshot.js";
import type { ExecuteToolInput } from "./types.js";

test("scoped read-only Bash rejects environment changes before invoking the runner", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-bash-readonly-invocation-"));
  const requests: BashRunRequest[] = [];
  const tool = createBashTool({
    allowEscalation: false,
    runner: {
      async run(request) {
        requests.push(request);
        return {
          exitCode: 0, signal: null, stdout: "ok", stderr: "",
          stdoutTruncated: false, stderrTruncated: false, stdoutBytes: 2, stderrBytes: 0,
          outputLimitBytes: request.maxOutputBytes, durationMs: 1, timedOut: false, aborted: false,
          sandbox: "macos-seatbelt",
        };
      },
    },
  });
  const registry = new InMemoryToolRegistry();
  registry.register(tool);
  let nextId = 0;
  let executeScope: string[] = [];
  const executor = new ToolExecutor({
    registry,
    events: { publish: async () => undefined },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    snapshotProvider: new FileSystemSnapshotProvider(),
    policyResolver: { resolve: () => ({ allowedTools: ["bash"], writeScope: [], executeScope }) },
    createId: (prefix) => `${prefix}_${++nextId}`,
    now: () => 1 as TimestampMs,
  });

  try {
    await mkdir(join(workspace, "subdir"));
    for (const env of [undefined, {}]) {
      const input = { command: "pwd", cwd: "subdir", ...(env ? { env } : {}) };
      expect(await executor.canRunConcurrently("bash", input)).toBe(true);
      expect(tool.approval?.(input)).toMatchObject({ metadata: { readOnly: true } });
      expect((await executor.execute(executeInput(workspace, input))).status).toBe("completed");
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]?.cwd).toBe(join(workspace, "subdir"));

    // No startup script or alternate executable is run: the fake runner must
    // never receive these requests, even with the normal snapshot provider.
    const environmentOverrides: Record<string, string>[] = [
      { BASH_ENV: join(workspace, "startup.sh") },
      { PATH: join(workspace, "bin") },
      { HOME: join(workspace, "home") },
      { CHILI_TEST_ENV: "ok" },
    ];
    for (const env of environmentOverrides) {
      const input = { command: "pwd", env };
      expect(await executor.canRunConcurrently("bash", input)).toBe(false);
      expect(tool.approval?.(input)).toMatchObject({ metadata: { readOnly: false } });
      const result = await executor.execute(executeInput(workspace, input));
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.error.message).toContain("does not have execute scope");
    }
    expect(requests).toHaveLength(2);

    executeScope = ["pwd"];
    const authorized = await executor.execute(executeInput(workspace, {
      command: "pwd",
      env: { CHILI_TEST_ENV: "ok" },
    }));
    expect(authorized.status).toBe("completed");
    expect(requests).toHaveLength(3);
    expect(requests[2]?.env).toEqual({ CHILI_TEST_ENV: "ok" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

const unixTest = process.platform === "win32" ? test.skip : test;

unixTest("Unix unsandboxed Bash keeps authorized env and cwd without loading shell profiles", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-bash-no-profiles-"));
  try {
    const home = join(workspace, "home");
    const cwd = join(workspace, "subdir");
    await mkdir(home);
    await mkdir(cwd);
    for (const profile of [".bash_profile", ".bash_login", ".profile", ".bashrc"]) {
      await writeFile(join(home, profile), "printf '%s\\n' unexpected-profile-output\n");
    }
    const result = await createUnsandboxedBashRunner().run({
      command: 'printf "%s\\n" "$CHILI_TEST_ENV"; pwd',
      workspaceRoot: workspace,
      cwd,
      // An overridden PATH must not change which Bash the Unix runner starts.
      env: { HOME: home, PATH: home, CHILI_TEST_ENV: "retained" },
      timeoutMs: 5_000,
      maxOutputBytes: 4_000,
      sandboxPermissions: "use_default",
      signal: new AbortController().signal,
      onOutput: undefined,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`retained\n${await realpath(cwd)}\n`);
    expect(result.stderr).toBe("");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function executeInput(cwd: string, input: unknown): ExecuteToolInput {
  return {
    sessionId: "session_bash_invocation" as SessionId,
    turnId: "turn_bash_invocation" as TurnId,
    toolName: "bash",
    cwd,
    input,
  };
}
