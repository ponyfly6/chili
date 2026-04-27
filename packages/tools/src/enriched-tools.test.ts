import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { createApplyPatchTool } from "./builtins/apply-patch.js";
import { createBashTool } from "./builtins/bash.js";
import { createEditTool } from "./builtins/edit.js";
import { createGlobTool } from "./builtins/glob.js";
import { createGrepTool } from "./builtins/grep.js";
import { createReadFileTool } from "./builtins/read-file.js";
import { createToolSearchTool } from "./builtins/tool-search.js";
import { createWriteFileTool } from "./builtins/write-file.js";
import { InMemoryToolRegistry } from "./registry.js";
import { ToolExecutor } from "./executor.js";
import type { ExecuteToolInput, ToolAccessPolicyResolver } from "./types.js";

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

    const build = await executor.execute(toolInput("bash", { command: "bun test" }, workspace));
    expect(build.status).toBe("failed");
    if (build.status === "failed") expect(build.error.message).toContain("does not have execute scope");
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

function createExecutor(registry: InMemoryToolRegistry, policyResolver?: ToolAccessPolicyResolver): ToolExecutor {
  return new ToolExecutor({
    registry,
    events: { publish: async (_event: ChiliEvent) => undefined },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    ...(policyResolver ? { policyResolver } : {}),
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
