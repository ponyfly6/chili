import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { createEditTool } from "./builtins/edit.js";
import { createGlobTool } from "./builtins/glob.js";
import { createGrepTool } from "./builtins/grep.js";
import { createReadFileTool } from "./builtins/read-file.js";
import { createToolSearchTool } from "./builtins/tool-search.js";
import { createWriteFileTool } from "./builtins/write-file.js";
import { InMemoryToolRegistry } from "./registry.js";
import { ToolExecutor } from "./executor.js";
import type { ExecuteToolInput } from "./types.js";

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

function createExecutor(registry: InMemoryToolRegistry): ToolExecutor {
  return new ToolExecutor({
    registry,
    events: { publish: async (_event: ChiliEvent) => undefined },
    approvals: { decide: async () => ({ action: "allow_once" }) },
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
