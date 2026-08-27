import { expect, test } from "bun:test";
import type { AgentPath, ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import type { ApprovalBrokerRequest, ExecuteToolInput } from "./types.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type {
  MailboxConsumeToolInput,
  MailboxListToolInput,
  SubagentController,
  SubagentControlController,
  SubagentMailboxRecord,
  SubagentTaskBatchWaitRecord,
  SubagentTaskRecord,
  TaskToolInput,
  TaskCloseToolInput,
  TaskFollowupToolInput,
  TaskListToolInput,
  TaskWaitBatchToolInput,
  TaskWaitToolInput,
} from "./subagent.js";
import {
  createTaskBatchTool,
  createMailboxConsumeTool,
  createMailboxListTool,
  createTaskCloseTool,
  createTaskFollowupTool,
  createTaskListTool,
  createTaskTool,
  createTaskWaitBatchTool,
  createTaskWaitTool,
} from "./builtins/task.js";

test("agent control task tools normalize inputs and return task records", async () => {
  const controller = new FakeSubagentControlController();
  const approvals: ApprovalBrokerRequest[] = [];
  const executor = createExecutor(registryWithTaskTools(controller), approvals);

  const list = await executor.execute(toolInput("list_tasks", { status: "incomplete", limit: 5 }));
  expect(list.status).toBe("completed");
  if (list.status === "completed") {
    expect(JSON.parse(list.result.output)).toMatchObject({
      count: 1,
      tasks: [{ task_id: "task_done", status: "completed", summary: "done" }],
    });
  }
  expect(controller.taskListInputs).toEqual([{ status: "incomplete", limit: 5 }]);

  const wait = await executor.execute(toolInput("wait_task", { task_id: "task_done", timeout_ms: 25 }));
  expect(wait.status).toBe("completed");
  if (wait.status === "completed") {
    expect(JSON.parse(wait.result.output)).toMatchObject({ task_id: "task_done", status: "completed" });
  }
  expect(controller.taskWaitInputs).toEqual([{ taskId: "task_done", timeoutMs: 25 }]);

  const followup = await executor.execute(
    toolInput("followup_task", { task_id: "task_done", text: "check again", max_turns: 2 }),
  );
  expect(followup.status).toBe("completed");
  expect(controller.taskFollowupInputs).toEqual([{ taskId: "task_done", prompt: "check again", maxTurns: 2 }]);

  const close = await executor.execute(
    toolInput("close_task", { taskId: "task_done", status: "needs_attention", summary: "stop it", interrupt: false }),
  );
  expect(close.status).toBe("completed");
  expect(controller.taskCloseInputs).toEqual([
    { taskId: "task_done", status: "incomplete", summary: "stop it", interrupt: false },
  ]);

  expect(approvals.map((request) => request.permission)).toEqual(["task", "task"]);
  expect(approvals.map((request) => request.patterns)).toEqual([["task_done"], ["task_done"]]);
});

test("agent control mailbox tools normalize inputs and return mailbox records", async () => {
  const controller = new FakeSubagentControlController();
  const approvals: ApprovalBrokerRequest[] = [];
  const executor = createExecutor(registryWithTaskTools(controller), approvals);

  const list = await executor.execute(toolInput("agent_mailbox", { status: "pending", task_id: "task_done", limit: 3 }));
  expect(list.status).toBe("completed");
  if (list.status === "completed") {
    const output = JSON.parse(list.result.output) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(output).toMatchObject({
      count: 1,
      messages: [{
        message_id: "event_mailbox",
        status: "queued",
        task_id: "task_done",
        recipient_session_id: "session_child",
        recipientSessionId: "session_child",
      }],
    });
    expect(output.messages[0]).not.toHaveProperty("child_session_id");
    expect(output.messages[0]).not.toHaveProperty("childSessionId");
  }
  expect(controller.mailboxListInputs).toEqual([{ status: "queued", taskId: "task_done", limit: 3 }]);

  const consumed = await executor.execute(toolInput("consume_mailbox", { message_id: "event_mailbox" }));
  expect(consumed.status).toBe("completed");
  if (consumed.status === "completed") {
    expect(JSON.parse(consumed.result.output)).toMatchObject({ message_id: "event_mailbox", status: "consumed" });
  }
  expect(controller.mailboxConsumeInputs).toEqual([{ messageId: "event_mailbox" }]);
  expect(approvals.map((request) => request.permission)).toEqual(["mailbox"]);
  expect(approvals[0]?.patterns).toEqual(["event_mailbox"]);
});

test("task lifecycle schemas expose incomplete as a terminal status", () => {
  const controller = new FakeSubagentControlController();
  expect(createTaskListTool(controller).inputSchema).toMatchObject({
    properties: { status: { enum: expect.arrayContaining(["incomplete"]) } },
  });
  expect(createTaskCloseTool(controller).inputSchema).toMatchObject({
    properties: { status: { enum: expect.arrayContaining(["incomplete"]) } },
  });
});

test("task tools mark only background spawn calls concurrency-safe", async () => {
  const controller = new FakeSubagentController();
  const registry = new InMemoryToolRegistry();
  registry.register(createTaskTool(controller));
  registry.register(createTaskBatchTool(controller));
  const executor = createExecutor(registry, []);

  await expect(executor.canRunConcurrently("task", { description: "one", prompt: "run" })).resolves.toBe(false);
  await expect(executor.canRunConcurrently("task", { description: "one", prompt: "run", mode: "background" })).resolves.toBe(true);
  await expect(executor.canRunConcurrently("task_batch", { tasks: [{ description: "one", prompt: "run" }] })).resolves.toBe(true);
});

test("supervised is an explicit batch-only lifecycle policy", async () => {
  const controller = new FakeSubagentController();
  const lifecycle = new FakeSubagentControlController();
  const registry = new InMemoryToolRegistry();
  registry.register(createTaskTool(controller));
  registry.register(createTaskBatchTool(controller, lifecycle));
  const executor = createExecutor(registry, []);

  expect(createTaskBatchTool(controller, lifecycle).inputSchema).toMatchObject({
    properties: {
      completion_policy: { enum: expect.arrayContaining(["supervised"]) },
    },
  });
  expect(createTaskTool(controller).inputSchema).toMatchObject({
    properties: {
      completion_policy: { enum: expect.not.arrayContaining(["supervised"]) },
    },
  });

  const single = await executor.execute(toolInput("task", {
    description: "invalid supervised single",
    prompt: "work",
    completion_policy: "supervised",
  }));
  expect(single.status).toBe("failed");

  const batch = await executor.execute(toolInput("task_batch", {
    completion_policy: "supervised",
    tasks: [
      { description: "first", prompt: "read first" },
      { description: "second", prompt: "read second" },
    ],
  }));

  expect(batch.status).toBe("completed");
  expect(lifecycle.taskWaitBatchInputs).toEqual([]);
  expect(controller.spawnInputs.map((input) => input.completionPolicy)).toEqual(["supervised", "supervised"]);
  if (batch.status === "completed") {
    expect(JSON.parse(batch.result.output)).toMatchObject({
      completion_policy: "supervised",
      required_open_batch: true,
      supervised_confirmation_required: true,
      result_delivery: "supervised_loop",
      pending_count: 2,
      supervised_task_ids: ["task_1", "task_2"],
    });
    expect(batch.result.metadata).toMatchObject({
      completionPolicy: "supervised",
      notificationRequested: false,
      requiredOpenBatch: true,
      supervisedConfirmationRequired: true,
    });
  }
});

test("task_batch caps the batch at the task_wait_batch closure limit", () => {
  const controller = new FakeSubagentController();
  const tool = createTaskBatchTool(controller);
  const tasks = Array.from({ length: 65 }, (_, index) => ({
    description: `task ${index + 1}`,
    prompt: `inspect ${index + 1}`,
  }));

  expect(tool.inputSchema).toMatchObject({
    properties: { tasks: { maxItems: 64 } },
  });
  expect(tool.validate?.({ tasks: tasks.slice(0, 64), completion_policy: "supervised" })).toMatchObject({ ok: true });
  expect(tool.validate?.({ tasks, completion_policy: "supervised" })).toEqual({
    ok: false,
    message: "tasks must contain 64 tasks or fewer",
  });
});

test("single task applies source provenance and lifecycle policy defaults", async () => {
  const controller = new FakeSubagentController();
  const registry = new InMemoryToolRegistry();
  registry.register(createTaskTool(controller));
  const executor = createExecutor(registry, []);

  const background = await executor.execute(toolInput(
    "task",
    { description: "reader", prompt: "read it", mode: "background" },
    "call_background" as ToolCallId,
  ));
  const foreground = await executor.execute(toolInput(
    "task",
    { description: "writer", prompt: "write it" },
    "call_foreground" as ToolCallId,
  ));

  expect(controller.spawnInputs).toEqual([
    {
      description: "reader",
      prompt: "read it",
      mode: "background",
      sourceCallId: "call_background" as ToolCallId,
      completionPolicy: "notify",
    },
    {
      description: "writer",
      prompt: "write it",
      sourceCallId: "call_foreground" as ToolCallId,
      completionPolicy: "join",
    },
  ]);
  if (background.status === "completed") {
    expect(JSON.parse(background.result.output)).toMatchObject({
      completion_policy: "notify",
      status: "running",
    });
  }
  if (foreground.status === "completed") {
    expect(JSON.parse(foreground.result.output)).toMatchObject({
      completion_policy: "join",
      status: "running",
    });
  }
});

test("task_batch launches background subagents with bounded parallelism", async () => {
  const controller = new FakeSubagentController();
  const registry = new InMemoryToolRegistry();
  registry.register(createTaskBatchTool(controller));
  const approvals: ApprovalBrokerRequest[] = [];
  const executor = createExecutor(registry, approvals);

  const result = await executor.execute(toolInput("task_batch", {
    completion_policy: "detached",
    max_concurrency: 2,
    tasks: [
      { description: "first", prompt: "read first" },
      { description: "second", prompt: "read second" },
      { description: "third", prompt: "read third" },
    ],
  }));

  expect(result.status).toBe("completed");
  expect(controller.maxRunning).toBe(2);
  expect(controller.spawnInputs).toEqual([
    {
      description: "first",
      prompt: "read first",
      mode: "background",
      sourceCallId: "toolcall_1" as ToolCallId,
      batchId: "toolcall_1",
      batchIndex: 0,
      expectedBatchSize: 3,
      maxConcurrency: 2,
      completionPolicy: "detached",
    },
    {
      description: "second",
      prompt: "read second",
      mode: "background",
      sourceCallId: "toolcall_1" as ToolCallId,
      batchId: "toolcall_1",
      batchIndex: 1,
      expectedBatchSize: 3,
      maxConcurrency: 2,
      completionPolicy: "detached",
    },
    {
      description: "third",
      prompt: "read third",
      mode: "background",
      sourceCallId: "toolcall_1" as ToolCallId,
      batchId: "toolcall_1",
      batchIndex: 2,
      expectedBatchSize: 3,
      maxConcurrency: 2,
      completionPolicy: "detached",
    },
  ]);
  expect(approvals.map((request) => request.patterns)).toEqual([["spawn"]]);
  if (result.status === "completed") {
    expect(JSON.parse(result.result.output)).toMatchObject({
      batch_id: "toolcall_1",
      completion_policy: "detached",
      count: 3,
      tasks: [
        { task_id: "task_1", status: "running" },
        { task_id: "task_2", status: "running" },
        { task_id: "task_3", status: "running" },
      ],
    });
  }
});

test("task_batch defaults to join and returns terminal lifecycle records", async () => {
  const controller = new FakeSubagentController();
  const lifecycle = new FakeSubagentControlController();
  lifecycle.batchWaitResult = {
    waitFor: "all",
    satisfied: true,
    timedOut: false,
    tasks: [taskRecord("completed", "task_1"), taskRecord("failed", "task_2")],
  };
  const registry = new InMemoryToolRegistry();
  registry.register(createTaskBatchTool(controller, lifecycle));
  const executor = createExecutor(registry, []);

  const result = await executor.execute(toolInput("task_batch", {
    batch_id: "batch_readers",
    max_concurrency: 2,
    timeout_ms: 75,
    tasks: [
      { description: "first", prompt: "read first" },
      { description: "second", prompt: "read second" },
    ],
  }));

  expect(result.status).toBe("completed");
  expect(lifecycle.taskWaitBatchInputs).toEqual([{
    taskIds: ["task_1", "task_2"],
    waitFor: "all",
    timeoutMs: 75,
    batchId: "batch_readers",
  }]);
  expect(controller.spawnInputs.map((input) => ({
    sourceCallId: input.sourceCallId,
    batchId: input.batchId,
    batchIndex: input.batchIndex,
    expectedBatchSize: input.expectedBatchSize,
    maxConcurrency: input.maxConcurrency,
    completionPolicy: input.completionPolicy,
  }))).toEqual([
    {
      sourceCallId: "toolcall_1" as ToolCallId,
      batchId: "batch_readers",
      batchIndex: 0,
      expectedBatchSize: 2,
      maxConcurrency: 2,
      completionPolicy: "join",
    },
    {
      sourceCallId: "toolcall_1" as ToolCallId,
      batchId: "batch_readers",
      batchIndex: 1,
      expectedBatchSize: 2,
      maxConcurrency: 2,
      completionPolicy: "join",
    },
  ]);
  if (result.status === "completed") {
    expect(JSON.parse(result.result.output)).toMatchObject({
      batch_id: "batch_readers",
      completion_policy: "join",
      satisfied: true,
      timed_out: false,
      final_count: 2,
      failed_count: 1,
      pending_count: 0,
      tasks: [
        { task_id: "task_1", status: "completed" },
        { task_id: "task_2", status: "failed" },
      ],
    });
  }
});

test("task_batch join timeout returns partial statuses and preserves every handle", async () => {
  const controller = new FakeSubagentController();
  const lifecycle = new FakeSubagentControlController();
  lifecycle.batchWaitResult = {
    waitFor: "all",
    satisfied: false,
    timedOut: true,
    tasks: [taskRecord("completed", "task_1"), taskRecord("running", "task_2")],
  };
  const registry = new InMemoryToolRegistry();
  registry.register(createTaskBatchTool(controller, lifecycle));
  const executor = createExecutor(registry, []);

  const result = await executor.execute(toolInput("task_batch", {
    timeout_ms: 10,
    tasks: [
      { description: "first", prompt: "read first" },
      { description: "second", prompt: "read second" },
    ],
  }));

  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    expect(JSON.parse(result.result.output)).toMatchObject({
      completion_policy: "join",
      max_concurrency: 3,
      requested_max_concurrency: 3,
      concurrency_limit_scope: "batch_request_capped_by_runtime_global",
      satisfied: false,
      timed_out: true,
      final_count: 1,
      pending_count: 1,
      pending_task_ids: ["task_2"],
      tasks: [
        { task_id: "task_1", status: "completed" },
        { task_id: "task_2", status: "running" },
      ],
    });
    expect(result.result.metadata?.taskIds).toEqual(["task_1", "task_2"]);
    expect(controller.spawnInputs.map((input) => input.maxConcurrency)).toEqual([3, 3]);
  }
});

test("task_batch reports partial spawn failures without losing successful handles", async () => {
  const controller = new FakeSubagentController();
  controller.failDescriptions.add("second");
  const registry = new InMemoryToolRegistry();
  registry.register(createTaskBatchTool(controller));
  const executor = createExecutor(registry, []);

  const result = await executor.execute(toolInput("task_batch", {
    completion_policy: "notify",
    max_concurrency: 1,
    tasks: [
      { description: "first", prompt: "read first" },
      { description: "second", prompt: "read second" },
      { description: "third", prompt: "read third" },
    ],
  }));

  expect(result.status).toBe("completed");
  expect(controller.spawnInputs.map((input) => input.description)).toEqual(["first", "second", "third"]);
  if (result.status === "completed") {
    expect(JSON.parse(result.result.output)).toMatchObject({
      completion_policy: "notify",
      count: 3,
      expected_batch_size: 3,
      spawned_count: 2,
      spawn_failure_count: 1,
      spawn_failures: [{ batch_index: 1, description: "second", error: "spawn failed: second" }],
      tasks: [
        { task_id: "task_1", status: "running" },
        { task_id: "task_3", status: "running" },
      ],
    });
    expect(result.result.metadata?.status).toBe("partial_spawn");
    expect(result.result.metadata?.taskIds).toEqual(["task_1", "task_3"]);
  }
});

test("task_batch normalizes hostile spawn failures in successful tool output", async () => {
  const controller = new FakeSubagentController();
  controller.spawnErrors.set("hostile", hostileSuccessfulOutputError("task batch spawn failed"));
  const registry = new InMemoryToolRegistry();
  registry.register(createTaskBatchTool(controller));
  const executor = createExecutor(registry, []);

  const result = await executor.execute(toolInput("task_batch", {
    completion_policy: "notify",
    tasks: [{ description: "hostile", prompt: "trigger hostile spawn failure" }],
  }));

  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    const output = JSON.parse(result.result.output) as {
      spawn_failures: Array<{ error: string }>;
    };
    expect(output.spawn_failures).toHaveLength(1);
    expectBoundedSanitizedDiagnostic(output.spawn_failures[0]?.error, 512);
    expect(utf8Bytes(result.result.output)).toBeLessThan(8 * 1024);
    const metadataFailures = result.result.metadata?.spawnFailures as Array<{ error: string }> | undefined;
    expectBoundedSanitizedDiagnostic(metadataFailures?.[0]?.error, 512);
  }
});

test("task_wait_batch supports any semantics and returns partial timeout state", async () => {
  const controller = new FakeSubagentControlController();
  controller.batchWaitResult = {
    waitFor: "any",
    satisfied: false,
    timedOut: true,
    tasks: [taskRecord("completed", "task_done"), taskRecord("running", "task_live")],
  };
  const executor = createExecutor(registryWithTaskTools(controller), []);

  const result = await executor.execute(toolInput("wait_tasks", {
    task_ids: ["task_done", "task_live", "task_live"],
    wait_for: "any",
    timeout_ms: 25,
    batch_id: "batch_readers",
  }));

  expect(result.status).toBe("completed");
  expect(controller.taskWaitBatchInputs).toEqual([{
    taskIds: ["task_done", "task_live"],
    waitFor: "any",
    timeoutMs: 25,
    batchId: "batch_readers",
  }]);
  if (result.status === "completed") {
    expect(JSON.parse(result.result.output)).toMatchObject({
      batch_id: "batch_readers",
      wait_for: "any",
      satisfied: false,
      timed_out: true,
      final_count: 1,
      pending_count: 1,
      pending_task_ids: ["task_live"],
    });
  }
});

test("task_wait_batch any does not claim supervised all-task closure when every observed task is terminal", async () => {
  const controller = new FakeSubagentControlController();
  controller.batchWaitResult = {
    waitFor: "any",
    satisfied: true,
    timedOut: false,
    tasks: [taskRecord("completed", "task_1"), taskRecord("completed", "task_2")],
  };
  const executor = createExecutor(registryWithTaskTools(controller), []);

  const result = await executor.execute(toolInput("task_wait_batch", {
    task_ids: ["task_1", "task_2"],
    wait_for: "any",
  }));

  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    expect(JSON.parse(result.result.output)).toMatchObject({
      wait_for: "any",
      pending_count: 0,
      required_open_batch: true,
      batch_closed: false,
      next_action: expect.stringContaining("task_wait_batch(wait_for=all)"),
    });
    expect(result.result.metadata).toMatchObject({
      requiredOpenBatch: true,
      batchClosed: false,
    });
  }
});

function registryWithTaskTools(controller: SubagentControlController): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createTaskListTool(controller));
  registry.register(createTaskWaitTool(controller));
  registry.register(createTaskWaitBatchTool(controller));
  registry.register(createTaskFollowupTool(controller));
  registry.register(createTaskCloseTool(controller));
  registry.register(createMailboxListTool(controller));
  registry.register(createMailboxConsumeTool(controller));
  return registry;
}

function createExecutor(registry: InMemoryToolRegistry, approvals: ApprovalBrokerRequest[]): ToolExecutor {
  return new ToolExecutor({
    registry,
    events: { publish: async (_event: ChiliEvent) => undefined },
    approvals: {
      decide: async (request) => {
        approvals.push(request);
        return { action: "allow_once" };
      },
    },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
}

function toolInput(toolName: string, input: unknown, callId?: ToolCallId): ExecuteToolInput {
  const value: ExecuteToolInput = {
    sessionId: "session_tools" as SessionId,
    turnId: "turn_tools" as TurnId,
    toolName,
    input,
    cwd: process.cwd(),
  };
  if (callId) value.callId = callId;
  return value;
}

class FakeSubagentController implements SubagentController {
  spawnInputs: TaskToolInput[] = [];
  failDescriptions = new Set<string>();
  spawnErrors = new Map<string, unknown>();
  running = 0;
  maxRunning = 0;

  async spawnTask(input: TaskToolInput) {
    this.spawnInputs.push(input);
    const taskId = `task_${this.spawnInputs.length}`;
    if (this.spawnErrors.has(input.description)) {
      throw this.spawnErrors.get(input.description);
    }
    if (this.failDescriptions.has(input.description)) {
      throw new Error(`spawn failed: ${input.description}`);
    }
    this.running += 1;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    await sleepMs(input.description === "first" ? 20 : 1);
    this.running -= 1;
    return {
      taskId,
      status: "running" as const,
      summary: "",
    };
  }

  async completeTask() {
    return {
      taskId: "task_done",
      status: "completed" as const,
      summary: "done",
    };
  }
}

class FakeSubagentControlController implements SubagentControlController {
  taskListInputs: TaskListToolInput[] = [];
  taskWaitInputs: TaskWaitToolInput[] = [];
  taskWaitBatchInputs: TaskWaitBatchToolInput[] = [];
  taskFollowupInputs: TaskFollowupToolInput[] = [];
  taskCloseInputs: TaskCloseToolInput[] = [];
  mailboxListInputs: MailboxListToolInput[] = [];
  mailboxConsumeInputs: MailboxConsumeToolInput[] = [];
  batchWaitResult?: SubagentTaskBatchWaitRecord;

  async listTasks(input: TaskListToolInput): Promise<SubagentTaskRecord[]> {
    this.taskListInputs.push(input);
    return [taskRecord("completed")];
  }

  async waitTask(input: TaskWaitToolInput): Promise<SubagentTaskRecord> {
    this.taskWaitInputs.push(input);
    return taskRecord("completed");
  }

  async waitTasks(input: TaskWaitBatchToolInput): Promise<SubagentTaskBatchWaitRecord> {
    this.taskWaitBatchInputs.push(input);
    return this.batchWaitResult ?? {
      waitFor: input.waitFor ?? "all",
      satisfied: true,
      timedOut: false,
      tasks: [taskRecord("completed")],
    };
  }

  async followupTask(input: TaskFollowupToolInput): Promise<SubagentTaskRecord> {
    this.taskFollowupInputs.push(input);
    return taskRecord("completed");
  }

  async closeTask(input: TaskCloseToolInput): Promise<SubagentTaskRecord> {
    this.taskCloseInputs.push(input);
    return taskRecord(input.status ?? "cancelled");
  }

  async listMailbox(input: MailboxListToolInput): Promise<SubagentMailboxRecord[]> {
    this.mailboxListInputs.push(input);
    return [mailboxRecord("queued")];
  }

  async consumeMailbox(input: MailboxConsumeToolInput): Promise<SubagentMailboxRecord> {
    this.mailboxConsumeInputs.push(input);
    return mailboxRecord("consumed");
  }
}

function taskRecord(status: SubagentTaskRecord["status"], taskId = "task_done"): SubagentTaskRecord {
  return {
    taskId,
    path: `/root/${taskId}` as AgentPath,
    taskName: "Done task",
    status,
    mode: "resumable",
    generation: 2,
    currentRunId: "agent_done",
    childSessionId: "session_child",
    summary: "done",
    createdAt: 1,
    updatedAt: 2,
    ...(status === "running" || status === "pending" ? {} : { completedAt: 3 }),
  };
}

function mailboxRecord(status: SubagentMailboxRecord["status"]): SubagentMailboxRecord {
  return {
    messageId: "event_mailbox",
    path: "/root/task_done" as AgentPath,
    fromPath: "/root" as AgentPath,
    status,
    triggerTurn: true,
    taskId: "task_done",
    recipientSessionId: "session_child",
    message: { role: "user", content: "continue" },
    createdAt: 1,
    ...(status === "consumed" ? { consumedAt: 2 } : {}),
  };
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HOSTILE_SUCCESS_OUTPUT_SECRET = "sk-team-success-output-secret-123456789";

function hostileSuccessfulOutputError(label: string): Error {
  return new Error([
    `${label}: password=${HOSTILE_SUCCESS_OUTPUT_SECRET}`,
    `Authorization: Bearer ${HOSTILE_SUCCESS_OUTPUT_SECRET}`,
    `http://127.0.0.1:4567/callback?token=${HOSTILE_SUCCESS_OUTPUT_SECRET}`,
    "\u0000".repeat(5 * 1024 * 1024),
  ].join("\n"));
}

function expectBoundedSanitizedDiagnostic(value: string | undefined, maxBytes: number): void {
  expect(value).toBeDefined();
  if (value === undefined) return;
  expect(value).toContain("[REDACTED]");
  expect(value).not.toContain(HOSTILE_SUCCESS_OUTPUT_SECRET);
  expect(value).not.toContain("127.0.0.1");
  expect(value).not.toContain("\u0000");
  expect(utf8Bytes(value)).toBeLessThanOrEqual(maxBytes);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
