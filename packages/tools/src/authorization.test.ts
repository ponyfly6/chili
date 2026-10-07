import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId, TurnId } from "@chili/protocol";
import { createEditTool } from "./builtins/edit.js";
import { createWriteFileTool } from "./builtins/write-file.js";
import { ToolExecutor } from "./executor.js";
import { FileReadStateStore } from "./file-read-state.js";
import { withFileOperationLocks } from "./file-operation-lock.js";
import { InMemoryToolRegistry } from "./registry.js";
import { FileSystemSnapshotProvider } from "./snapshot.js";
import type { ChiliToolDefinition, ToolExecutorOptions } from "./types.js";

async function workspace(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "chili-authorization-"));
  try { await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

function executorFor(tool: ChiliToolDefinition, options: Omit<ToolExecutorOptions, "registry" | "events"> & Pick<Partial<ToolExecutorOptions>, "events">): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  registry.register(tool);
  return new ToolExecutor({ registry, events: { publish: async () => {} }, ...options });
}

function executeWrite(executor: ToolExecutor, cwd: string) {
  return executor.execute({ cwd, sessionId: "s" as SessionId, turnId: "t" as TurnId,
    toolName: "write", input: { filePath: "file.txt", content: "after" } });
}

for (const toolName of ["edit", "write"] as const) {
  test(`${toolName} reviews once while a real backup and mutation recheck the permit`, async () => workspace(async (cwd) => {
    await writeFile(join(cwd, "file.txt"), "before");
    const fileReads = new FileReadStateStore();
    await fileReads.forSession("s").recordTextRead(cwd, join(cwd, "file.txt"), "before");
    let reviews = 0;
    let checks = 0;
    const executor = executorFor(toolName === "edit" ? createEditTool() : createWriteFileTool(), {
      gate: { review: async () => {
        reviews++;
        return { decision: "allow", assertCurrent: async () => { checks++; } };
      } },
      fileReadState: fileReads, snapshotProvider: new FileSystemSnapshotProvider(),
    });
    const result = await executor.execute({ cwd, sessionId: "s" as SessionId, turnId: "t" as TurnId, toolName,
      input: toolName === "edit" ? { filePath: "file.txt", oldString: "before", newString: "after" }
        : { filePath: "file.txt", content: "after" },
    });
    expect(result.status).toBe("completed");
    expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("after");
    expect(reviews).toBe(1);
    expect(checks).toBeGreaterThan(1);
  }));
}

test("revocation after execution entry while a real file lock is held prevents writing", async () => workspace(async (cwd) => {
  const path = join(cwd, "file.txt");
  await writeFile(path, "before");
  const fileReads = new FileReadStateStore();
  await fileReads.forSession("s").recordTextRead(cwd, path, "before");
  let valid = true;
  let release!: () => void;
  let locked!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { locked = resolve; });
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const unlock = new Promise<void>((resolve) => { release = resolve; });
  const holder = withFileOperationLocks([path], new AbortController().signal, async () => { locked(); await unlock; });
  await held;
  const write = createWriteFileTool();
  const executor = executorFor({ ...write, execute: async (input, context) => {
    entered();
    return write.execute(input, context);
  } }, { fileReadState: fileReads, gate: { review: async () => ({
    decision: "allow", assertCurrent: async () => { if (!valid) throw new Error("Review configuration changed"); },
  }) } });
  const result = executeWrite(executor, cwd);
  try {
    await entry;
    valid = false;
  } finally { release(); await holder; }
  expect((await result).status).toBe("failed");
  expect(await readFile(path, "utf8")).toBe("before");
}));

test("an unavailable review permit fails closed at a later execution boundary", async () => workspace(async (cwd) => {
  let available = true;
  let executed = false;
  const executor = executorFor({ name: "effect", description: "effect", risk: "write", inputSchema: {},
    execute: async () => { executed = true; return { title: "effect", output: "effect" }; },
  }, {
    gate: { review: async () => ({ decision: "allow", assertCurrent: async () => {
      if (!available) throw new Error("Review configuration unavailable");
    } }) },
    events: { publish: async (event) => {
      if (event.type === "tool.call_updated" && event.payload.status === "running") available = false;
    } },
  });
  const result = await executor.execute({ cwd, sessionId: "s" as SessionId, turnId: "t" as TurnId, toolName: "effect", input: {} });
  expect(result.status).toBe("failed");
  expect(executed).toBe(false);
}));

test("an awaited review retains its original configuration version", async () => workspace(async (cwd) => {
  const path = join(cwd, "file.txt");
  await writeFile(path, "before");
  const fileReads = new FileReadStateStore();
  await fileReads.forSession("s").recordTextRead(cwd, path, "before");
  let revision = 1;
  const executor = executorFor(createWriteFileTool(), { fileReadState: fileReads, gate: {
    review: async () => {
      const reviewedRevision = revision;
      await Promise.resolve();
      revision++;
      return { decision: "allow", assertCurrent: async () => {
        if (revision !== reviewedRevision) throw new Error("Review configuration changed");
      } };
    },
  } });
  const result = await executeWrite(executor, cwd);
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("Review configuration changed");
  expect(await readFile(path, "utf8")).toBe("before");
}));

test("worker validation and its backend scope use a copied policy and detect later narrowing", async () => workspace(async (cwd) => {
  const policy = { writeScope: ["*"], executeScope: ["pwd"] };
  let executed = false;
  const tool: ChiliToolDefinition = {
    name: "effect", description: "effect", risk: "execute", resourcePolicy: "process", inputSchema: {},
    isConcurrencySafe: false,
    isReadOnly: async () => { policy.writeScope.length = 0; return false; },
    resources: () => ({ permission: "bash", patterns: ["pwd"] }),
    execute: async () => { executed = true; return { title: "effect", output: "effect" }; },
  };
  const executor = executorFor(tool, {
    gate: { review: async () => ({ decision: "allow" }) },
    policyResolver: { resolve: () => policy },
  });
  const result = await executor.execute({ cwd, sessionId: "s" as SessionId, turnId: "t" as TurnId, toolName: "effect", input: {} });
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("Execution resource scope changed");
  expect(executed).toBe(false);
}));
