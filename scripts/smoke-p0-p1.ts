import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextWindowBuilder, SingleAgentRuntime, SnapshotRecoveryService } from "../packages/core/src/index.js";
import { SqliteEventStore } from "../packages/store/src/index.js";
import {
  FileSystemSnapshotProvider,
  InMemoryToolRegistry,
  ToolExecutor,
  createApplyPatchTool,
  createBashTool,
  createEditTool,
  createGitDiffTool,
  createReadFileTool,
} from "../packages/tools/src/index.js";

function idFactory(): (prefix: string) => string {
  let seq = 0;
  return (prefix) => `${prefix}_${++seq}`;
}

function registerTools(): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createEditTool());
  registry.register(createApplyPatchTool());
  registry.register(createBashTool());
  registry.register(createGitDiffTool());
  return registry;
}

function createHarness(workspace: string, model: SingleAgentRuntimeConstructor["model"], options: Partial<SingleAgentRuntimeConstructor> = {}) {
  const createId = idFactory();
  const store = new SqliteEventStore(join(workspace, `${globalThis.crypto.randomUUID()}.sqlite`));
  const registry = registerTools();
  const snapshotProvider = new FileSystemSnapshotProvider({
    rootDir: join(workspace, "snapshots"),
    createId,
    now: () => 1 as never,
  });
  const toolExecutor = new ToolExecutor({
    registry,
    events: { publish: (event) => store.append(event) },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    snapshotProvider,
    createId,
    now: () => 1 as never,
    maxResultOutputBytes: 4_096,
  });
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor,
    createId,
    now: () => 1 as never,
    ...options,
  });
  return { runtime, store, snapshotProvider };
}

type SingleAgentRuntimeConstructor = ConstructorParameters<typeof SingleAgentRuntime>[0];

const workspace = await mkdtemp(join(tmpdir(), "chili-p0-p1-"));

try {
  await smokeSingleAgentToolLoop(workspace);
  await smokeInterruptSyntheticResult(workspace);
  await smokeRetry(workspace);
  await smokeDoomLoopGuard(workspace);
  await smokeSnapshotRevert(workspace);
  await smokeContextAndOutputTruncation(workspace);
  console.log("P0/P1 smoke ok");
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function smokeSingleAgentToolLoop(workspace: string): Promise<void> {
  await writeFile(join(workspace, "a.txt"), "old\n", "utf8");
  const harness = createHarness(workspace, {
    stream: async function* () {
      yield { type: "text_delta", text: "editing" } as const;
      yield {
        type: "tool_call",
        name: "replace",
        input: { file_path: "a.txt", old_string: "old", new_string: "new" },
      } as const;
      yield { type: "finish", reason: "stop" } as const;
    },
  });

  const sessionId = await harness.runtime.createSession({ threadId: "thread_1" as never, cwd: workspace });
  await harness.runtime.appendUserMessage({ sessionId, threadId: "thread_1" as never, text: "change file" });
  const result = await harness.runtime.runTurn({ sessionId, threadId: "thread_1" as never, cwd: workspace });

  assert.equal(result.status, "completed");
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "new\n");
  const events = await harness.store.events({ sessionId, limit: 100 });
  assert.ok(events.some((event) => event.type === "approval.requested"));
  assert.ok(events.some((event) => event.type === "snapshot.created"));
  assert.ok(events.some((event) => event.type === "tool.call_finished" && event.payload.status === "completed"));
  harness.store.close();
}

async function smokeInterruptSyntheticResult(workspace: string): Promise<void> {
  const harness = createHarness(workspace, {
    stream: async function* () {
      yield { type: "tool_call", name: "bash", input: { command: "sleep 5" } } as const;
      yield { type: "finish", reason: "stop" } as const;
    },
  });
  const sessionId = await harness.runtime.createSession({ threadId: "thread_2" as never, cwd: workspace });
  await harness.runtime.appendUserMessage({ sessionId, threadId: "thread_2" as never, text: "run sleep" });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  const result = await harness.runtime.runTurn({
    sessionId,
    threadId: "thread_2" as never,
    cwd: workspace,
    signal: controller.signal,
  });

  assert.equal(result.status, "cancelled");
  const events = await harness.store.events({ sessionId, limit: 100 });
  assert.ok(events.some((event) => event.type === "tool.call_finished" && event.payload.status === "cancelled" && event.payload.synthetic));
  const messages = await harness.store.messages(sessionId);
  assert.ok(
    messages.some((message) =>
      message.parts.some((part) => part.type === "tool_result" && part.synthetic && part.error?.toLowerCase().includes("abort")),
    ),
  );
  harness.store.close();
}

async function smokeRetry(workspace: string): Promise<void> {
  let attempts = 0;
  const harness = createHarness(
    workspace,
    {
      stream: async function* () {
        attempts++;
        if (attempts === 1) {
          yield { type: "error", error: new Error("temporarily unavailable") } as const;
          return;
        }
        yield { type: "finish", reason: "stop" } as const;
      },
    },
    { retryPolicy: { maxAttempts: 2, initialDelayMs: 1 } },
  );
  const sessionId = await harness.runtime.createSession({ threadId: "thread_3" as never, cwd: workspace });
  await harness.runtime.appendUserMessage({ sessionId, threadId: "thread_3" as never, text: "retry" });
  const result = await harness.runtime.runTurn({ sessionId, threadId: "thread_3" as never, cwd: workspace });

  assert.equal(result.status, "completed");
  assert.equal(attempts, 2);
  assert.ok((await harness.store.events({ sessionId, limit: 100 })).some((event) => event.type === "turn.retry_scheduled"));
  harness.store.close();
}

async function smokeDoomLoopGuard(workspace: string): Promise<void> {
  const harness = createHarness(
    workspace,
    {
      stream: async function* () {
        yield { type: "tool_call", name: "read_file", input: { filePath: "a.txt" } } as const;
        yield { type: "tool_call", name: "read_file", input: { filePath: "a.txt" } } as const;
        yield { type: "finish", reason: "stop" } as const;
      },
    },
    { doomLoopGuard: { maxRepeatedToolCalls: 1 } },
  );
  const sessionId = await harness.runtime.createSession({ threadId: "thread_4" as never, cwd: workspace });
  await harness.runtime.appendUserMessage({ sessionId, threadId: "thread_4" as never, text: "loop" });
  const result = await harness.runtime.runTurn({ sessionId, threadId: "thread_4" as never, cwd: workspace });

  assert.equal(result.status, "failed");
  const events = await harness.store.events({ sessionId, limit: 100 });
  assert.ok(events.some((event) => event.type === "turn.guard_triggered"));
  assert.ok(events.some((event) => event.type === "tool.call_finished" && event.payload.synthetic && event.payload.status === "failed"));
  harness.store.close();
}

async function smokeSnapshotRevert(workspace: string): Promise<void> {
  await writeFile(join(workspace, "snap.txt"), "before", "utf8");
  const harness = createHarness(workspace, {
    stream: async function* () {
      yield {
        type: "tool_call",
        name: "edit",
        input: { filePath: "snap.txt", oldString: "before", newString: "after" },
      } as const;
      yield { type: "finish", reason: "stop" } as const;
    },
  });
  const sessionId = await harness.runtime.createSession({ threadId: "thread_5" as never, cwd: workspace });
  await harness.runtime.appendUserMessage({ sessionId, threadId: "thread_5" as never, text: "snapshot" });
  await harness.runtime.runTurn({ sessionId, threadId: "thread_5" as never, cwd: workspace });

  assert.equal(await readFile(join(workspace, "snap.txt"), "utf8"), "after");
  const snapshotEvent = (await harness.store.events({ sessionId, type: "snapshot.created", limit: 10 }))[0];
  assert.ok(snapshotEvent);
  const recovery = new SnapshotRecoveryService({
    store: harness.store,
    snapshotProvider: harness.snapshotProvider,
    createId: idFactory(),
    now: () => 1 as never,
  });
  await recovery.revert({ sessionId, threadId: "thread_5" as never, snapshotId: snapshotEvent.payload.snapshotId });
  assert.equal(await readFile(join(workspace, "snap.txt"), "utf8"), "before");
  assert.equal((await harness.store.events({ sessionId, type: "snapshot.reverted", limit: 10 })).length, 1);
  harness.store.close();
}

async function smokeContextAndOutputTruncation(workspace: string): Promise<void> {
  const builder = new ContextWindowBuilder({
    maxInputChars: 120,
    maxToolResultChars: 20,
    preserveRecentMessages: 1,
  });
  const built = builder.build([
    {
      id: "msg_1" as never,
      sessionId: "session_1" as never,
      role: "user",
      createdAt: 1 as never,
      parts: [{ id: "part_1" as never, messageId: "msg_1" as never, sessionId: "session_1" as never, type: "text", text: "x".repeat(200) }],
    },
    {
      id: "msg_2" as never,
      sessionId: "session_1" as never,
      role: "assistant",
      createdAt: 2 as never,
      parts: [{ id: "part_2" as never, messageId: "msg_2" as never, sessionId: "session_1" as never, type: "tool_result", callId: "toolcall_1" as never, output: "y".repeat(100) }],
    },
  ]);
  assert.ok(built.compactionBoundary);
  assert.equal(built.usage.truncatedToolResults, 1);
  assert.ok(built.messages.at(-1)?.parts[0]?.type === "tool_result");
  assert.ok(built.messages.at(-1)?.parts[0]?.type === "tool_result" && built.messages.at(-1)?.parts[0]?.output.includes("tool result omitted"));

  const createId = idFactory();
  const store = new SqliteEventStore(join(workspace, `${globalThis.crypto.randomUUID()}.sqlite`));
  const registry = new InMemoryToolRegistry();
  registry.register(createReadFileTool());
  const executor = new ToolExecutor({
    registry,
    events: { publish: (event) => store.append(event) },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    createId,
    now: () => 1 as never,
    maxResultOutputBytes: 12,
  });
  const runtime = new SingleAgentRuntime({
    store,
    model: {
      stream: async function* () {
        yield { type: "finish", reason: "stop" } as const;
      },
    },
    toolRegistry: registry,
    toolExecutor: executor,
    createId,
    now: () => 1 as never,
    contextBudget: { maxInputChars: 80, preserveRecentMessages: 1 },
  });

  const sessionId = await runtime.createSession({ threadId: "thread_6" as never, cwd: workspace });
  await runtime.appendUserMessage({ sessionId, threadId: "thread_6" as never, text: "a".repeat(200) });
  const result = await runtime.runTurn({ sessionId, threadId: "thread_6" as never, cwd: workspace });
  assert.equal(result.status, "completed");
  assert.ok((await store.events({ sessionId, type: "turn.compaction_requested", limit: 10 })).length >= 1);

  await writeFile(join(workspace, "big.txt"), "12345678901234567890", "utf8");
  const toolResult = await executor.execute({
    sessionId,
    threadId: "thread_6" as never,
    turnId: "turn_tool" as never,
    toolName: "read",
    input: { filePath: "big.txt" },
    cwd: workspace,
  });
  assert.equal(toolResult.status, "completed");
  assert.ok(toolResult.result.output.includes("tool output truncated"));
  store.close();
}
