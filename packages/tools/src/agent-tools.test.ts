import { expect, test } from "bun:test";
import type { SessionId, TimestampMs, TurnId } from "@chili/protocol";
import type { AgentMessageListToolInput, AgentMessageRecord, AgentMessageSendToolInput, AgentMessageToolController } from "./agent-message.js";
import {
  createAgentListTool,
  createAgentResumeTool,
  createAgentSendTool,
  createAgentSpawnTool,
  createAgentStopTool,
  createAgentWaitTool,
} from "./builtins/agent.js";
import { createCodeModeTool } from "./builtins/code-mode.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type {
  CompleteTaskToolInput,
  SubagentController,
  SubagentControlController,
  SubagentTaskBatchWaitRecord,
  SubagentTaskRecord,
  TaskCloseToolInput,
  TaskFollowupToolInput,
  TaskListToolInput,
  TaskToolInput,
  TaskWaitBatchToolInput,
} from "./subagent.js";
import type { ApprovalBrokerRequest, ExecuteToolInput, ExecuteToolResult } from "./types.js";

test("canonical agent tools expose exactly six names, with no old aliases and with code mode contracts", () => {
  const { registry } = setup();
  expect(registry.list().map((tool) => tool.name).sort()).toEqual([
    "agent_list", "agent_resume", "agent_send", "agent_spawn", "agent_stop", "agent_wait",
  ]);
  for (const tool of registry.list()) {
    expect(tool.aliases).toBeUndefined();
    expect(tool.codeMode).toBe(true);
    expect(tool.outputSchema).toBeDefined();
  }
  for (const name of ["task", "task_batch", "task_wait", "task_followup", "agent_message_send", "agent_message_list"]) {
    expect(registry.get(name)).toBeUndefined();
  }
});

test("agent_spawn preserves single inline defaults and supports explicit background execution", async () => {
  const { executor, controller, approvals } = setup();
  const inline = completed(await executor.execute(input("agent_spawn", { description: "inspect", prompt: "task_wait is a symbol in this code" })));
  const background = completed(await executor.execute(input("agent_spawn", { description: "inspect again", prompt: "work", mode: "background" })));
  expect(controller.spawnInputs).toMatchObject([
    { description: "inspect", prompt: "task_wait is a symbol in this code", completionPolicy: "join" },
    { description: "inspect again", prompt: "work", mode: "background", completionPolicy: "notify" },
  ]);
  expect(controller.spawnInputs[0]).not.toHaveProperty("mode");
  expect(inline.title).toBe("agent_spawn task_1");
  expect(inline.structuredData).toMatchObject({ task_id: "task_1", status: "completed", summary: "task_wait is a symbol in this code" });
  expect(inline.metadata).toMatchObject({ taskId: "task_1", task_id: "task_1", completionPolicy: "join" });
  expect(background.structuredData).toMatchObject({ task_id: "task_2", status: "running", completion_policy: "notify" });
  expect(approvals.map((approval) => [approval.toolName, approval.permission, approval.patterns])).toEqual([
    ["agent_spawn", "task", ["spawn"]], ["agent_spawn", "task", ["spawn"]],
  ]);
  await expect(executor.canRunConcurrently("agent_spawn", { description: "a", prompt: "b" })).resolves.toBe(false);
  await expect(executor.canRunConcurrently("agent_spawn", { description: "a", prompt: "b", mode: "background" })).resolves.toBe(true);
});

test("agent_spawn joins batches and keeps partial spawn failure handles and metadata", async () => {
  const { executor, controller } = setup();
  controller.failDescriptions.add("fails");
  const result = completed(await executor.execute(input("agent_spawn", {
    tasks: [{ description: "first", prompt: "read" }, { description: "fails", prompt: "read" }, { description: "third", prompt: "read" }],
    maxConcurrency: 1,
    batchId: "batch_review",
    timeoutMs: 25,
  })));
  expect(controller.waitInputs).toEqual([{ taskIds: ["task_1", "task_3"], waitFor: "all", timeoutMs: 25, batchId: "batch_review" }]);
  expect(controller.spawnInputs.map((task) => [task.mode, task.completionPolicy, task.batchId, task.batchIndex])).toEqual([
    ["background", "join", "batch_review", 0], ["background", "join", "batch_review", 1], ["background", "join", "batch_review", 2],
  ]);
  expect(result.structuredData).toMatchObject({
    batchId: "batch_review", count: 3, spawned_count: 2, spawn_failure_count: 1,
    tasks: [{ task_id: "task_1" }, { task_id: "task_3" }],
    spawn_failures: [{ batchIndex: 1, description: "fails", error: "cannot spawn fails" }],
  });
  expect(result.metadata).toMatchObject({ batchId: "batch_review", taskIds: ["task_1", "task_3"], status: "partial_spawn" });
});

test("supervised spawn retains batch obligations while all generated guidance names canonical tools", async () => {
  const { executor, controller } = setup();
  const result = completed(await executor.execute(input("agent_spawn", { tasks: [{ description: "first", prompt: "work" }], completionPolicy: "supervised" })));
  expect(controller.waitInputs).toEqual([]);
  expect(result.structuredData).toMatchObject({ required_open_batch: true, supervised_confirmation_required: true });
  const nextAction = (result.structuredData as { next_action: string }).next_action;
  expect(nextAction).toContain("agent_wait(waitFor=any)");
  expect(nextAction).toContain("agent_resume");
  expect(nextAction).not.toContain("task_wait");
  expect(result.metadata?.nextAction).toBe(nextAction);
});

test("agent_spawn rejects mixed single/batch requests, batch-only single options, and unsupported modes", async () => {
  const { executor, controller } = setup();
  for (const args of [
    { tasks: [{ description: "a", prompt: "b" }], prompt: "ambiguous" },
    { tasks: [{ description: "a", prompt: "b" }], mode: "background" },
    { description: "a", prompt: "b", maxConcurrency: 2 },
    { description: "a", prompt: "b", batchId: "batch" },
    { description: "a", prompt: "b", timeoutMs: 2 },
    { description: "a", prompt: "b", mode: "typo" },
    { description: "a", prompt: "b", completionPolicy: "supervised" },
    { tasks: [] },
    { tasks: [{ description: "a", prompt: "b", mode: "one_shot" }] },
  ]) expect((await executor.execute(input("agent_spawn", args))).status).toBe("failed");
  expect(controller.spawnInputs).toEqual([]);
});

test("agent_list routes agent and message filters without silently discarding cross-view fields", async () => {
  const { executor, controller } = setup();
  const agents = completed(await executor.execute(input("agent_list", { taskIds: ["task_1"], status: "completed", all: true })));
  const messages = completed(await executor.execute(input("agent_list", { view: "messages", taskId: "task_1", path: "/root/reviewer", from: "/root", status: "queued", limit: 2 })));
  expect(controller.listInputs).toEqual([{ taskIds: ["task_1"], status: "completed", all: true }]);
  expect(controller.messageListInputs).toEqual([{ taskId: "task_1", path: "/root/reviewer", from: "/root", status: "queued", limit: 2 }]);
  expect(agents.structuredData).toMatchObject({ tasks: [{ task_id: "task_1", status: "completed" }] });
  expect(messages.structuredData).toMatchObject({ count: 2, messages: [{ message_id: "message_1" }, { message_id: "message_2" }] });
  expect(messages.title).toBe("agent_list 2");
  for (const args of [
    { view: "unknown" }, { taskId: "task_1" }, { from: "/root" }, { path: "/root" },
    { view: "messages", taskIds: ["task_1"] }, { view: "messages", status: "completed" }, { status: "queued" },
  ]) expect((await executor.execute(input("agent_list", args))).status).toBe("failed");
  expect(controller.listInputs).toHaveLength(1);
  expect(controller.messageListInputs).toHaveLength(1);
});

test("agent_send queues messages or requests idle delivery without invoking lifecycle controls", async () => {
  const { executor, controller } = setup();
  const queued = completed(await executor.execute(input("agent_send", { to: "reviewer", content: "task_followup is the old API", messageId: "message_queued" })));
  completed(await executor.execute(input("agent_send", { to: "parent", content: "ready", delivery: "triggerTurn" })));
  expect(controller.messageInputs).toEqual([
    { to: "reviewer", content: "task_followup is the old API", messageId: "message_queued", delivery: "queueOnly" },
    { to: "parent", content: "ready", delivery: "triggerTurn" },
  ]);
  expect(controller.closeInputs).toEqual([]);
  expect(controller.resumeInputs).toEqual([]);
  expect(queued.structuredData).toMatchObject({ message_id: "message_queued", content: "task_followup is the old API" });
});

test("agent_wait returns partial snapshots for both single and multiple handles", async () => {
  const { executor, controller } = setup();
  controller.timedOut = true;
  const single = completed(await executor.execute(input("agent_wait", { taskId: "task_running", timeoutMs: 25 })));
  const batch = completed(await executor.execute(input("agent_wait", { taskIds: ["task_1", "task_running", "task_running"], waitFor: "any", timeoutMs: 50, batchId: "batch_1" })));
  expect(controller.waitInputs).toEqual([
    { taskIds: ["task_running"], waitFor: "all", timeoutMs: 25 },
    { taskIds: ["task_1", "task_running"], waitFor: "any", timeoutMs: 50, batchId: "batch_1" },
  ]);
  expect(single.structuredData).toMatchObject({ timedOut: true, satisfied: false, pending_task_ids: ["task_running"], tasks: [{ task_id: "task_running", status: "running" }] });
  expect(batch.structuredData).toMatchObject({ batchId: "batch_1", final_count: 1, pending_count: 1, count: 2 });
  expect((batch.structuredData as { next_action: string }).next_action).toContain("agent_wait");
  for (const args of [{}, { taskId: "a", taskIds: ["a"] }, { taskId: " " }, { taskIds: [] }, { taskId: "a", timeoutMs: 0 }]) {
    expect((await executor.execute(input("agent_wait", args))).status).toBe("failed");
  }
  expect(controller.waitInputs).toHaveLength(2);
});

test("agent_stop always interrupts and cancels; agent_resume accepts an optional continuation prompt", async () => {
  const { executor, controller, approvals } = setup();
  const stopped = completed(await executor.execute(input("agent_stop", { taskId: "task_1", summary: "pause investigation" })));
  const resumed = completed(await executor.execute(input("agent_resume", { taskId: "task_1" })));
  completed(await executor.execute(input("agent_resume", { taskId: "task_1", prompt: "inspect tests", maxTurns: 3 })));
  expect(controller.closeInputs).toEqual([{ taskId: "task_1", summary: "pause investigation", status: "cancelled", interrupt: true }]);
  expect(controller.resumeInputs).toEqual([
    { taskId: "task_1", prompt: "Continue the previous task from where you stopped." },
    { taskId: "task_1", prompt: "inspect tests", maxTurns: 3 },
  ]);
  expect(stopped.structuredData).toMatchObject({ task_id: "task_1", status: "cancelled", summary: "pause investigation" });
  expect(resumed.structuredData).toMatchObject({ task_id: "task_1", status: "running" });
  expect(approvals.map((approval) => [approval.toolName, approval.permission, approval.patterns])).toEqual([
    ["agent_stop", "task", ["task_1"]], ["agent_resume", "task", ["task_1"]], ["agent_resume", "task", ["task_1"]],
  ]);
  for (const args of [{ taskId: "task_1", status: "completed" }, { taskId: "task_1", interrupt: false }]) {
    expect((await executor.execute(input("agent_stop", args))).status).toBe("failed");
  }
  for (const args of [{ taskId: "task_1", prompt: " " }, { taskId: "task_1", maxTurns: 0 }]) {
    expect((await executor.execute(input("agent_resume", args))).status).toBe("failed");
  }
  expect(controller.closeInputs).toHaveLength(1);
  expect(controller.resumeInputs).toHaveLength(2);
});

test("code mode can compose agent tools and consume structured results directly", async () => {
  const { executor, registry, controller } = setup();
  registry.register(createCodeModeTool());
  const result = completed(await executor.execute(input("code_mode", {
    code: `const spawned = await tools.agent_spawn({description:"review", prompt:"work", mode:"background"});
      const id = spawned.structuredData.task_id;
      await tools.agent_send({to:id, content:"check edge cases"});
      const waited = await tools.agent_wait({taskId:id});
      text({id, status:waited.structuredData.tasks[0].status});`,
  })));
  expect(result.output).toContain('"id":"task_1"');
  expect(result.output).toContain('"status":"completed"');
  expect(controller.messageInputs).toEqual([{ to: "task_1", content: "check edge cases", delivery: "queueOnly" }]);
});

function completed(result: ExecuteToolResult) {
  if (result.status !== "completed") throw result.error;
  expect(result.result.structuredData === undefined || JSON.stringify(result.result.structuredData) === result.result.output).toBe(true);
  return result.result;
}

function setup() {
  const controller = new FakeController();
  const registry = new InMemoryToolRegistry();
  const approvals: ApprovalBrokerRequest[] = [];
  for (const tool of [
    createAgentSpawnTool(controller, controller), createAgentListTool(controller, controller),
    createAgentSendTool(controller), createAgentWaitTool(controller), createAgentStopTool(controller), createAgentResumeTool(controller),
  ]) registry.register(tool);
  let nextId = 0;
  const executor = new ToolExecutor({
    registry,
    events: { publish: async () => undefined },
    approvals: { decide: async (request) => { approvals.push(request); return { action: "allow_once" }; } },
    createId: (prefix) => `${prefix}_${++nextId}`,
    now: () => 1 as TimestampMs,
  });
  return { controller, registry, executor, approvals };
}

class FakeController implements SubagentController, SubagentControlController, AgentMessageToolController {
  spawnInputs: TaskToolInput[] = [];
  listInputs: TaskListToolInput[] = [];
  waitInputs: TaskWaitBatchToolInput[] = [];
  resumeInputs: TaskFollowupToolInput[] = [];
  closeInputs: TaskCloseToolInput[] = [];
  messageInputs: AgentMessageSendToolInput[] = [];
  messageListInputs: AgentMessageListToolInput[] = [];
  failDescriptions = new Set<string>();
  timedOut = false;

  async spawnTask(args: TaskToolInput) {
    this.spawnInputs.push(args);
    if (this.failDescriptions.has(args.description)) throw new Error(`cannot spawn ${args.description}`);
    return { taskId: `task_${this.spawnInputs.length}`, status: args.mode === "background" ? "running" as const : "completed" as const, summary: args.prompt };
  }
  async completeTask(args: CompleteTaskToolInput) { return { taskId: args.taskId, summary: args.summary, status: args.status ?? "completed" as const }; }
  async listTasks(args: TaskListToolInput) { this.listInputs.push(args); return [record("task_1")]; }
  async waitTask(): Promise<SubagentTaskRecord> { throw new Error("agent_wait must use waitTasks, including single handles"); }
  async waitTasks(args: TaskWaitBatchToolInput): Promise<SubagentTaskBatchWaitRecord> {
    this.waitInputs.push(args);
    return { waitFor: args.waitFor ?? "all", satisfied: !this.timedOut, timedOut: this.timedOut, tasks: args.taskIds.map((id) => record(id, id === "task_running" ? "running" : "completed")) };
  }
  async followupTask(args: TaskFollowupToolInput) { this.resumeInputs.push(args); return record(args.taskId, "running"); }
  async closeTask(args: TaskCloseToolInput) { this.closeInputs.push(args); return { ...record(args.taskId, args.status), summary: args.summary ?? "stopped" }; }
  async listMailbox() { return []; }
  async consumeMailbox(): Promise<never> { throw new Error("mailbox consumption is internal"); }
  async sendAgentMessage(args: AgentMessageSendToolInput) {
    this.messageInputs.push(args);
    return { ...message(args.messageId ?? `message_${this.messageInputs.length}`), content: args.content, delivery: args.delivery ?? "queueOnly" };
  }
  async listAgentMessages(args: AgentMessageListToolInput) { this.messageListInputs.push(args); return [message("message_1"), message("message_2")]; }
}

function record(taskId: string, status: SubagentTaskRecord["status"] = "completed"): SubagentTaskRecord {
  return { taskId, status, path: `/root/${taskId}`, mode: "background", summary: "done" };
}

function message(messageId: string): AgentMessageRecord {
  return { messageId, fromPath: "/root", toPath: "/root/reviewer", status: "queued", delivery: "queueOnly", content: "message" };
}

function input(toolName: string, args: unknown): ExecuteToolInput {
  return { sessionId: "session_agents" as SessionId, turnId: "turn_agents" as TurnId, cwd: process.cwd(), toolName, input: args };
}
