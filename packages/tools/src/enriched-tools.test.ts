import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { createApplyPatchTool } from "./builtins/apply-patch.js";
import { createBashTool } from "./builtins/bash.js";
import type { BashRunRequest, BashRunner } from "./builtins/bash.js";
import { createEditTool } from "./builtins/edit.js";
import { createGlobTool } from "./builtins/glob.js";
import { createGrepTool } from "./builtins/grep.js";
import { createReadFileTool } from "./builtins/read-file.js";
import { createReadImageTool } from "./builtins/read-image.js";
import { createToolSearchTool } from "./builtins/tool-search.js";
import { createWriteFileTool } from "./builtins/write-file.js";
import { InMemoryToolRegistry } from "./registry.js";
import { ToolExecutor } from "./executor.js";
import type { ExecuteToolInput, ToolAccessPolicyResolver } from "./types.js";
import type { SnapshotProvider, SnapshotRecord, SnapshotRevertResult } from "./types.js";

test("write tools require a fresh full read before modifying existing files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-read-state-"));
  try {
    await writeFile(join(workspace, "a.txt"), "old\n", "utf8");
    const registry = registryWithCoreTools();
    const executor = createExecutor(registry);

    const unreadEdit = await executor.execute(toolInput("edit", { filePath: "a.txt", oldString: "old", newString: "new" }, workspace));
    expect(unreadEdit.status).toBe("failed");
    if (unreadEdit.status === "failed") expect(unreadEdit.error.message).toContain("Read a.txt before modifying");

    const read = await executor.execute(toolInput("read", { filePath: "a.txt" }, workspace));
    expect(read.status).toBe("completed");
    const edit = await executor.execute(toolInput("edit", { filePath: "a.txt", oldString: "old", newString: "new" }, workspace));
    expect(edit.status).toBe("completed");
    expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("new\n");

    await writeFile(join(workspace, "a.txt"), "external\n", "utf8");
    const staleWrite = await executor.execute(toolInput("write", { filePath: "a.txt", content: "next\n" }, workspace));
    expect(staleWrite.status).toBe("failed");
    if (staleWrite.status === "failed") expect(staleWrite.error.message).toContain("File changed since it was read");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("glob, grep, and tool_search expose repository discovery tools", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-search-"));
  try {
    await writeFile(join(workspace, "alpha.ts"), "export const alpha = 1;\n", "utf8");
    await writeFile(join(workspace, "beta.md"), "alpha notes\n", "utf8");
    const registry = registryWithCoreTools();
    const executor = createExecutor(registry);

    const glob = await executor.execute(toolInput("glob", { pattern: "**/*.ts" }, workspace));
    expect(glob.status).toBe("completed");
    if (glob.status === "completed") expect(glob.result.output).toContain("alpha.ts");

    const grep = await executor.execute(toolInput("grep", { pattern: "alpha", headLimit: 5 }, workspace));
    expect(grep.status).toBe("completed");
    if (grep.status === "completed") expect(grep.result.output).toContain("alpha");

    const search = await executor.execute(toolInput("tool_search", { query: "write file" }, workspace));
    expect(search.status).toBe("completed");
    if (search.status === "completed") expect(search.result.output).toContain("write:");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("read_image returns image content for vision-capable models", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-read-image-"));
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwOKGAAAAABJRU5ErkJggg==", "base64");
    await writeFile(join(workspace, "pixel.png"), png);
    const registry = registryWithCoreTools();
    const executor = createExecutor(registry);

    const result = await executor.execute(toolInput("read_image", { filePath: "pixel.png" }, workspace));
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.output).toContain("MIME type: image/png");
    expect(result.result.content).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
    expect(result.result.metadata).toMatchObject({ path: "pixel.png", bytes: png.byteLength, mimeType: "image/png" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool executor applies per-tool output limits and persists full output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-output-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "large",
      description: "Emit a large result.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      maxResultOutputBytes: 4,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async () => ({ title: "large", output: "abcdefgh" }),
    });
    const executor = createExecutor(registry);

    const result = await executor.execute(toolInput("large", {}, workspace, "toolcall_large" as never));
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.result.output).toContain("full output saved");
    expect(result.result.metadata?.outputTruncated).toBe(true);
    expect(await readFile(join(workspace, ".chili", "tool-results", "toolcall_large.txt"), "utf8")).toBe("abcdefgh");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy hides and rejects unauthorized write tools", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-readonly-"));
  try {
    const registry = registryWithCoreTools();
    registry.register(createApplyPatchTool());
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["read", "tool_search"],
        writeScope: [],
      }),
    });

    const search = await executor.execute(toolInput("tool_search", { query: "write" }, workspace));
    expect(search.status).toBe("completed");
    if (search.status === "completed") expect(search.result.output).not.toContain("write:");

    const write = await executor.execute(toolInput("write", { filePath: "src/a.ts", content: "x" }, workspace));
    expect(write.status).toBe("failed");
    if (write.status === "failed") expect(write.error.message).toContain("not allowed by the current worker policy");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy enforces write scope for write and apply_patch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-write-"));
  try {
    const registry = registryWithCoreTools();
    registry.register(createApplyPatchTool());
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["write", "apply_patch"],
        writeScope: ["packages/core"],
      }),
    });

    const inScope = await executor.execute(toolInput("write", { filePath: "packages/core/a.ts", content: "ok\n" }, workspace));
    expect(inScope.status).toBe("completed");

    const outOfScope = await executor.execute(toolInput("write", { filePath: "packages/server/a.ts", content: "no\n" }, workspace));
    expect(outOfScope.status).toBe("failed");
    if (outOfScope.status === "failed") expect(outOfScope.error.message).toContain("outside this worker's write scope");

    const patch = await executor.execute(
      toolInput(
        "apply_patch",
        {
          operations: [
            { type: "create", path: "packages/core/b.ts", content: "ok\n" },
            { type: "create", path: "packages/server/b.ts", content: "no\n" },
          ],
        },
        workspace,
      ),
    );
    expect(patch.status).toBe("failed");
    if (patch.status === "failed") expect(patch.error.message).toContain("outside this worker's write scope");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy allows only read-only bash without execute scope", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-bash-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool());
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["bash"],
        executeScope: [],
      }),
    });

    const readOnly = await executor.execute(toolInput("bash", { command: "pwd" }, workspace));
    expect(readOnly.status).toBe("completed");

    for (const command of ["git branch", "git branch --list", "git status", "git diff"]) {
      const result = await executor.execute(toolInput("bash", { command }, workspace));
      expect(result.status).toBe("completed");
    }

    const build = await executor.execute(toolInput("bash", { command: "bun test" }, workspace));
    expect(build.status).toBe("failed");
    if (build.status === "failed") expect(build.error.message).toContain("does not have execute scope");

    const findDelete = await executor.execute(toolInput("bash", { command: "find . -delete" }, workspace));
    expect(findDelete.status).toBe("failed");
    if (findDelete.status === "failed") expect(findDelete.error.message).toContain("does not have execute scope");

    for (const command of ["sed -i 's/a/b/' file", "awk -i inplace '{print}' file", "git branch -D foo"]) {
      const result = await executor.execute(toolInput("bash", { command }, workspace));
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.error.message).toContain("does not have execute scope");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash supports workspace-scoped cwd and env overrides", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-bash-cwd-"));
  try {
    await mkdir(join(workspace, "subdir"), { recursive: true });
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool());
    const executor = createExecutor(registry);

    const result = await executor.execute(
      toolInput("bash", { command: "printf \"$CHILI_TEST_ENV:$(basename \"$PWD\")\"", cwd: "subdir", env: { CHILI_TEST_ENV: "ok" } }, workspace),
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result.output).toBe("ok:subdir");
      expect(result.result.metadata).toMatchObject({
        timedOut: false,
        stdoutBytes: 9,
        outputLimitBytes: 256_000,
      });
    }

    const outside = await executor.execute(toolInput("bash", { command: "pwd", cwd: ".." }, workspace));
    expect(outside.status).toBe("failed");
    if (outside.status === "failed") expect(outside.error.message).toContain("cwd must stay inside the workspace");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash publishes live stdout and stderr tool output deltas", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-bash-stream-"));
  const events: ChiliEvent[] = [];
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool());
    const executor = createExecutor(registry, undefined, undefined, events);

    const result = await executor.execute(
      toolInput("bash", { command: "printf out1; printf err1 >&2; sleep 0.05; printf out2; printf err2 >&2" }, workspace, "toolcall_bash_stream" as ToolCallId),
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result.output).toContain("out1out2");
      expect(result.result.output).toContain("[stderr]\nerr1err2");
    }

    const deltas = events.filter((event): event is Extract<ChiliEvent, { type: "tool.output_delta" }> => event.type === "tool.output_delta");
    expect(deltas.map((event) => String(event.payload.callId))).toEqual(deltas.map(() => "toolcall_bash_stream"));
    expect(deltas.filter((event) => event.payload.stream === "stdout").map((event) => event.payload.delta).join("")).toBe("out1out2");
    expect(deltas.filter((event) => event.payload.stream === "stderr").map((event) => event.payload.delta).join("")).toBe("err1err2");
    expect(events.at(-1)?.type).toBe("tool.call_finished");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash runner injection receives resolved request and formats process output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-bash-runner-"));
  const events: ChiliEvent[] = [];
  const controller = new AbortController();
  let seen: BashRunRequest | undefined;
  try {
    await mkdir(join(workspace, "subdir"), { recursive: true });
    const runner: BashRunner = {
      async run(request) {
        seen = request;
        await request.onOutput?.({ stream: "stdout", delta: "live-out" });
        await request.onOutput?.({ stream: "stderr", delta: "live-err" });
        return {
          exitCode: null,
          signal: "SIGTERM",
          stdout: "captured stdout",
          stderr: "captured stderr",
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutBytes: 15,
          stderrBytes: 15,
          outputLimitBytes: request.maxOutputBytes,
          durationMs: 42,
          timedOut: true,
          aborted: false,
        };
      },
    };
    const registry = new InMemoryToolRegistry();
    registry.register(createBashTool({ runner }));
    const executor = createExecutor(registry, undefined, undefined, events);
    const input = toolInput(
      "bash",
      {
        command: "printf fake",
        cwd: "subdir",
        env: { CHILI_TEST_ENV: "ok" },
        timeoutMs: 123,
        maxOutputBytes: 17,
      },
      workspace,
      "toolcall_fake_bash_runner" as ToolCallId,
    );
    input.signal = controller.signal;

    const result = await executor.execute(input);

    expect(result.status).toBe("completed");
    expect(seen).toMatchObject({
      command: "printf fake",
      cwd: join(workspace, "subdir"),
      env: { CHILI_TEST_ENV: "ok" },
      timeoutMs: 123,
      maxOutputBytes: 17,
      signal: controller.signal,
    });
    expect(typeof seen?.onOutput).toBe("function");
    if (result.status === "completed") {
      expect(result.result.title).toBe("timed out after 123ms");
      expect(result.result.output).toContain("captured stdout");
      expect(result.result.output).toContain("[stderr]\ncaptured stderr");
      expect(result.result.output).toContain("[process timed out after 123ms and was terminated]");
      expect(result.result.metadata).toMatchObject({
        command: "printf fake",
        cwd: join(workspace, "subdir"),
        envKeys: ["CHILI_TEST_ENV"],
        signal: "SIGTERM",
        timedOut: true,
        stdoutBytes: 15,
        stderrBytes: 15,
        outputLimitBytes: 17,
      });
    }
    const deltas = events.filter((event): event is Extract<ChiliEvent, { type: "tool.output_delta" }> => event.type === "tool.output_delta");
    expect(deltas.map((event) => event.payload.delta)).toEqual(["live-out", "live-err"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bash approval metadata is unchanged by runner injection", () => {
  const runner: BashRunner = {
    async run() {
      throw new Error("not used");
    },
  };
  const input = {
    command: "rm -rf *",
    cwd: "subdir",
    env: { ZED: "1", ALPHA: "2" },
  };

  expect(createBashTool({ runner }).approval?.(input)).toEqual(createBashTool().approval?.(input));
});

test("snapshot creation failure fails closed before write tools mutate files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-snapshot-fail-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(createWriteFileTool());
    const executor = createExecutor(registry, undefined, failingSnapshotProvider());

    const result = await executor.execute(toolInput("write", { filePath: "new.txt", content: "next\n" }, workspace));
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error.message).toContain("Snapshot failed before write");
    await expect(stat(join(workspace, "new.txt"))).rejects.toThrow();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy allows scoped team task updates without file write scope", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-team-task-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(fakeTeamTaskUpdateTool());
    registry.register(createToolSearchTool(registry));
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["team_task_update", "tool_search"],
        writeScope: [],
        teamId: "team_1",
        taskId: "task_1",
        memberPath: "/root/worker",
      }),
    });

    const search = await executor.execute(toolInput("tool_search", { query: "select:team_task_update" }, workspace));
    expect(search.status).toBe("completed");
    if (search.status === "completed") expect(search.result.output).toContain("team_task_update:");

    const update = await executor.execute(
      toolInput("team_task_update", { teamId: "team_1", taskId: "task_1", summary: "done" }, workspace),
    );
    expect(update.status).toBe("completed");

    const otherTask = await executor.execute(
      toolInput("team_task_update", { teamId: "team_1", taskId: "task_2", summary: "no" }, workspace),
    );
    expect(otherTask.status).toBe("failed");
    if (otherTask.status === "failed") expect(otherTask.error.message).toContain("team task scope");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scoped worker policy restricts team messages to the worker identity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-tools-policy-team-message-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register(fakeTeamMessageSendTool());
    const executor = createExecutor(registry, {
      resolve: () => ({
        allowedTools: ["team_message_send"],
        writeScope: [],
        teamId: "team_1",
        taskId: "task_1",
        memberPath: "/root/worker",
      }),
    });

    const message = await executor.execute(
      toolInput(
        "team_message_send",
        {
          teamId: "team_1",
          from: "/root/worker",
          to: "/root/lead",
          content: "done",
          taskId: "task_1",
        },
        workspace,
      ),
    );
    expect(message.status).toBe("completed");

    const impersonation = await executor.execute(
      toolInput(
        "team_message_send",
        {
          teamId: "team_1",
          from: "/root/other",
          to: "/root/lead",
          content: "no",
          taskId: "task_1",
        },
        workspace,
      ),
    );
    expect(impersonation.status).toBe("failed");
    if (impersonation.status === "failed") expect(impersonation.error.message).toContain("member path");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function registryWithCoreTools(): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createReadImageTool());
  registry.register(createEditTool());
  registry.register(createWriteFileTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createToolSearchTool(registry));
  return registry;
}

function fakeTeamTaskUpdateTool() {
  return {
    name: "team_task_update",
    description: "Update status, owner, summary, or metadata for a team task.",
    risk: "write" as const,
    inputSchema: { type: "object" },
    approval: (): false => false,
    execute: async () => ({ title: "team_task_update", output: "updated" }),
  };
}

function fakeTeamMessageSendTool() {
  return {
    name: "team_message_send",
    description: "Send a durable message to a team member or broadcast to the team.",
    risk: "write" as const,
    inputSchema: { type: "object" },
    approval: (): false => false,
    execute: async () => ({ title: "team_message_send", output: "sent" }),
  };
}

function createExecutor(
  registry: InMemoryToolRegistry,
  policyResolver?: ToolAccessPolicyResolver,
  snapshotProvider?: SnapshotProvider,
  events?: ChiliEvent[],
): ToolExecutor {
  return new ToolExecutor({
    registry,
    events: { publish: async (event: ChiliEvent) => { events?.push(event); } },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    ...(policyResolver ? { policyResolver } : {}),
    ...(snapshotProvider ? { snapshotProvider } : {}),
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
}

function toolInput(toolName: string, input: unknown, cwd: string, callId?: ToolCallId): ExecuteToolInput {
  const value: ExecuteToolInput = {
    sessionId: "session_tools" as SessionId,
    turnId: "turn_tools" as TurnId,
    toolName,
    input,
    cwd,
  };
  if (callId) value.callId = callId;
  return value;
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function failingSnapshotProvider(): SnapshotProvider {
  return {
    async create(): Promise<SnapshotRecord | undefined> {
      throw new Error("snapshot store unavailable");
    },
    async revert(): Promise<SnapshotRevertResult> {
      throw new Error("not used");
    },
  };
}
