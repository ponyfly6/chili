import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, ToolCallId, TurnId } from "@chili/protocol";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, type BashRunRequest, type BashRunResult, type BashRunner } from "./builtins/bash.js";
import { createProcessTool } from "./builtins/process.js";
import { ToolExecutor } from "./executor.js";
import { ManagedProcessManager } from "./managed-process.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ApprovalBrokerRequest, ExecuteToolInput, ExecuteToolResult, ToolAccessPolicy } from "./types.js";

test("managed Bash approval uses the original command and denial never starts a process", async () => {
  const fixture = await createFixture({ denyApproval: true });
  try {
    const command = "bun run dev -- --port 4312";
    const result = await fixture.execute("bash", {
      command, background: true, env: { CHILI_TEST_MODE: "development" },
    });
    expect(result.status).toBe("failed");
    expect(fixture.approvals).toHaveLength(1);
    expect(fixture.approvals[0]).toMatchObject({
      permission: "bash",
      patterns: [command],
      metadata: {
        command, background: true, readOnly: false,
        envKeys: ["CHILI_TEST_MODE"], sandboxPermissions: "use_default",
      },
    });
    expect(fixture.runner.requests).toHaveLength(0);
    expect(fixture.manager.list(fixture.owner)).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test("managed Bash refuses cwd escapes, including symlinks, before starting a process", async () => {
  const fixture = await createFixture();
  try {
    const alias = join(fixture.workspace, "outside-link");
    await symlink(fixture.otherWorkspace, alias);
    for (const cwd of [fixture.otherWorkspace, "../other", "outside-link"]) {
      const result = await fixture.execute("bash", { command: "pwd", background: true, cwd });
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.error.message).toContain("inside the authoritative workspace");
    }
    expect(fixture.runner.requests).toHaveLength(0);
    expect(fixture.manager.list(fixture.owner)).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test("background execution and environment overrides require a worker execute scope", async () => {
  const fixture = await createFixture({
    policy: { allowedTools: ["bash"], executeScope: [], writeScope: [] },
  });
  try {
    for (const input of [
      { command: "pwd", background: true },
      { command: "pwd", env: { BASH_ENV: "startup.sh" } },
      { command: "pwd", background: true, env: { CHILI_TEST_MODE: "development" } },
    ]) {
      expect(await fixture.executor.canRunConcurrently("bash", input)).toBe(false);
      const result = await fixture.execute("bash", input);
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.error.message).toContain("does not have execute scope");
    }
    expect(fixture.approvals).toHaveLength(0);
    expect(fixture.runner.requests).toHaveLength(0);
    expect(fixture.manager.list(fixture.owner)).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test("registries without a process manager reject background Bash during validation", async () => {
  const fixture = await createFixture({ managedBash: false });
  try {
    expect(fixture.registry.get("bash")?.inputSchema).not.toHaveProperty("properties.background");
    const result = await fixture.execute("bash", { command: "pwd", background: true });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error.message).toContain("unavailable in this tool registry");
    expect(fixture.approvals).toHaveLength(0);
    expect(fixture.runner.requests).toHaveLength(0);
  } finally {
    await fixture.cleanup();
  }
});

test("managed Bash preserves execution parameters and later logs belong to new calls", async () => {
  const fixture = await createFixture();
  try {
    const subdir = join(fixture.workspace, "app");
    await mkdir(subdir);
    const controller = new AbortController();
    const launch = await fixture.execute("bash", {
      command: "bun run dev", background: true, cwd: "app",
      env: { CHILI_TEST_MODE: "development" }, timeoutMs: 120_000,
    }, { signal: controller.signal });
    const processId = launchedProcessId(launch);
    expect(launch.status === "completed" && launch.result.metadata).toMatchObject({
      processId, processStatus: "running", background: true,
    });
    const request = fixture.runner.requests[0]!;
    expect(request).toMatchObject({
      command: "bun run dev", workspaceRoot: fixture.workspace, cwd: subdir,
      env: { CHILI_TEST_MODE: "development" }, timeoutMs: 120_000,
      sandboxPermissions: "use_default",
    });
    expect(request.signal).not.toBe(controller.signal);
    expect(request.onOutput).toBeUndefined();
    expect(typeof request.onRawOutput).toBe("function");
    const launchFinished = fixture.events.findIndex((event) => event.type === "tool.call_finished"
      && event.payload.callId === launch.callId && event.payload.status === "completed");
    expect(launchFinished).toBeGreaterThanOrEqual(0);

    controller.abort();
    expect(request.signal.aborted).toBe(false);
    await fixture.runner.emit("stdout", "service ready after launch\n");
    await fixture.runner.emit("stderr", "late diagnostic\n");
    const read = await fixture.execute("process", { action: "read", processId }, {
      turnId: "turn_later" as TurnId,
    });
    expect(read.status).toBe("completed");
    if (read.status === "completed") {
      expect(read.result.output).toContain("service ready after launch");
      expect(read.result.output).toContain("late diagnostic");
      expect(read.result.metadata).toMatchObject({ processStatus: "running" });
    }
    fixture.runner.finish(7);
    const exited = await fixture.execute("process", { action: "read", processId, waitMs: 2_000 });
    expect(exited.status === "completed" && exited.result.metadata).toMatchObject({
      processStatus: "exited", exitCode: 7,
    });
    expect(fixture.events.slice(launchFinished + 1).filter((event) => (
      event.type === "tool.output_delta" || event.type === "tool.call_updated"
    ) && event.payload.callId === launch.callId)).toEqual([]);
    expect(fixture.approvals).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});

test("process tools hide other sessions and workspaces and reject their handles", async () => {
  const fixture = await createFixture();
  try {
    const processId = launchedProcessId(await fixture.execute("bash", {
      command: "private service command", background: true,
    }));
    await fixture.runner.emit("stdout", "private service output\n");
    const ownList = await fixture.execute("process", { action: "list" });
    expect(ownList.status).toBe("completed");
    if (ownList.status === "completed") expect(JSON.parse(ownList.result.output)).toEqual([
      expect.objectContaining({ processId, status: "running" }),
    ]);

    for (const context of [
      { sessionId: "session_sibling" as SessionId },
      { cwd: fixture.otherWorkspace },
    ]) {
      const list = await fixture.execute("process", { action: "list" }, context);
      expect(list.status).toBe("completed");
      if (list.status === "completed") expect(JSON.parse(list.result.output)).toEqual([]);
      for (const action of ["read", "stop"] as const) {
        const result = await fixture.execute("process", { action, processId }, context);
        expect(result.status).toBe("failed");
        if (result.status === "failed") {
          expect(result.error.message).toBe("Managed process is not available in this session and workspace");
          expect(result.error.message).not.toContain("private service");
        }
      }
    }
    expect(fixture.runner.requests[0]!.signal.aborted).toBe(false);
    expect((await fixture.manager.read(fixture.owner, processId)).status).toBe("running");
  } finally {
    await fixture.cleanup();
  }
});

test("process stop stays non-read-only and cannot bypass a scoped worker policy", async () => {
  const fixture = await createFixture();
  try {
    const processId = launchedProcessId(await fixture.execute("bash", {
      command: "bun run dev", background: true,
    }));
    expect(await fixture.executor.canRunConcurrently("process", { action: "read", processId })).toBe(true);
    expect(await fixture.executor.canRunConcurrently("process", { action: "stop", processId })).toBe(false);
    const policy = { allowedTools: ["process"], executeScope: [], writeScope: [] };
    const read = await fixture.execute("process", { action: "read", processId }, { policy });
    expect(read.status).toBe("completed");
    const denied = await fixture.execute("process", { action: "stop", processId }, { policy });
    expect(denied.status).toBe("failed");
    if (denied.status === "failed") expect(denied.error.message).toContain("does not have execute scope");
    expect(fixture.runner.requests[0]!.signal.aborted).toBe(false);
    const stopped = await fixture.execute("process", { action: "stop", processId });
    expect(stopped.status === "completed" && stopped.result.metadata).toMatchObject({ processStatus: "stopped" });
    expect(fixture.runner.requests[0]!.signal.aborted).toBe(true);
    expect(fixture.approvals).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});

test("failed background launch metadata delivery stops its undelivered process", async () => {
  const fixture = await createFixture({
    publish(event) {
      if (event.type === "tool.call_updated" && event.payload.metadata?.processId) {
        throw new Error("launch receipt could not be persisted");
      }
    },
  });
  try {
    await expect(fixture.execute("bash", { command: "bun run dev", background: true }))
      .rejects.toThrow("launch receipt could not be persisted");
    expect(fixture.runner.requests).toHaveLength(1);
    expect(fixture.runner.requests[0]!.signal.aborted).toBe(true);
    expect(fixture.manager.list(fixture.owner)).toEqual([
      expect.objectContaining({ status: "stopped" }),
    ]);
    expect(fixture.events.some((event) => event.type === "tool.call_finished"
      && event.payload.status === "completed")).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

test("cancelling the initial Bash call stops a process before its handle is delivered", async () => {
  const fixture = await createFixture();
  try {
    const controller = new AbortController();
    const pending = fixture.execute("bash", { command: "bun run dev", background: true }, {
      signal: controller.signal,
    });
    await fixture.runner.started;
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(fixture.runner.requests[0]!.signal.aborted).toBe(true);
    expect(fixture.manager.list(fixture.owner)).toEqual([
      expect.objectContaining({ status: "stopped" }),
    ]);
    expect(fixture.events.some((event) => event.type === "tool.call_finished"
      && event.payload.status === "completed")).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

interface FixtureOptions {
  denyApproval?: boolean;
  managedBash?: boolean;
  policy?: ToolAccessPolicy;
  publish?: (event: ChiliEvent) => void | Promise<void>;
}

async function createFixture(options: FixtureOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chili-managed-process-tools-")));
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other");
  await mkdir(workspace);
  await mkdir(otherWorkspace);
  const owner = { sessionId: "session_managed_tools" as SessionId, workspaceRoot: workspace };
  const manager = new ManagedProcessManager();
  const runner = controlledRunner();
  const registry = new InMemoryToolRegistry();
  registry.register(createBashTool({
    runner, ...(options.managedBash === false ? {} : { processes: manager }),
  }));
  registry.register(createProcessTool(manager));
  const events: ChiliEvent[] = [];
  const approvals: ApprovalBrokerRequest[] = [];
  let nextId = 0;
  const executor = new ToolExecutor({
    registry,
    events: { async publish(event) {
      await options.publish?.(event);
      events.push(event);
    } },
    approvals: { async decide(request) {
      approvals.push(request);
      return options.denyApproval ? { action: "deny", feedback: "Execution was denied" } : { action: "allow_once" };
    } },
    ...(options.policy ? { policyResolver: { resolve: () => options.policy } } : {}),
    createId: (prefix) => `${prefix}_${++nextId}`,
  });
  return {
    workspace, otherWorkspace, owner, manager, runner, registry, executor, events, approvals,
    execute(toolName: string, input: unknown, overrides: Partial<ExecuteToolInput> = {}) {
      return executor.execute({
        sessionId: owner.sessionId,
        turnId: "turn_managed_tools" as TurnId,
        callId: `toolcall_managed_${++nextId}` as ToolCallId,
        cwd: workspace, toolName, input, ...overrides,
      });
    },
    async cleanup() {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function controlledRunner(): BashRunner & {
  requests: BashRunRequest[];
  started: Promise<void>;
  emit(stream: "stdout" | "stderr", text: string): Promise<void>;
  finish(exitCode: number): void;
} {
  const requests: BashRunRequest[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
  let complete: ((result: BashRunResult) => void) | undefined;
  let settled = false;
  return {
    requests, started,
    async run(request) {
      requests.push(request);
      const pending = new Promise<BashRunResult>((resolveRun, rejectRun) => {
        const abort = () => {
          if (settled) return;
          settled = true;
          const error = new Error("Controlled process aborted");
          error.name = "AbortError";
          rejectRun(error);
        };
        complete = (result) => {
          if (settled) return;
          settled = true;
          request.signal.removeEventListener("abort", abort);
          resolveRun(result);
        };
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      });
      markStarted();
      return pending;
    },
    async emit(stream, text) {
      const request = requests[0];
      if (!request || settled) throw new Error("No controlled process is running");
      await request.onRawOutput?.({ stream, chunk: Buffer.from(text) });
    },
    finish(exitCode) {
      const request = requests[0];
      if (!request || !complete) throw new Error("No controlled process has started");
      complete({
        exitCode, signal: null, stdout: "", stderr: "",
        stdoutTruncated: false, stderrTruncated: false, stdoutBytes: 0, stderrBytes: 0,
        outputLimitBytes: request.maxOutputBytes, durationMs: 1, timedOut: false, aborted: false,
        sandbox: "none",
      });
    },
  };
}

function launchedProcessId(result: ExecuteToolResult): string {
  expect(result.status).toBe("completed");
  if (result.status !== "completed") throw result.error;
  const processId = result.result.metadata?.processId;
  expect(typeof processId).toBe("string");
  if (typeof processId !== "string") throw new Error("Launch did not return a process handle");
  return processId;
}
