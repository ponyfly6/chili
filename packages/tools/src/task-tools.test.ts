import { expect, test } from "bun:test";
import type { AgentPath, ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import type { ApprovalBrokerRequest, ExecuteToolInput } from "./types.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type {
  MailboxConsumeToolInput,
  MailboxListToolInput,
  SubagentControlController,
  SubagentMailboxRecord,
  SubagentTaskRecord,
  TaskCloseToolInput,
  TaskFollowupToolInput,
  TaskListToolInput,
  TaskWaitToolInput,
} from "./subagent.js";
import {
  createMailboxConsumeTool,
  createMailboxListTool,
  createTaskCloseTool,
  createTaskFollowupTool,
  createTaskListTool,
  createTaskWaitTool,
} from "./builtins/task.js";

test("agent control task tools normalize inputs and return task records", async () => {
  const controller = new FakeSubagentControlController();
  const approvals: ApprovalBrokerRequest[] = [];
  const executor = createExecutor(registryWithTaskTools(controller), approvals);

  const list = await executor.execute(toolInput("list_tasks", { status: "completed", limit: 5 }));
  expect(list.status).toBe("completed");
  if (list.status === "completed") {
    expect(JSON.parse(list.result.output)).toMatchObject({
      count: 1,
      tasks: [{ task_id: "task_done", status: "completed", summary: "done" }],
    });
  }
  expect(controller.taskListInputs).toEqual([{ status: "completed", limit: 5 }]);

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
    toolInput("close_task", { taskId: "task_done", status: "cancel", summary: "stop it", interrupt: false }),
  );
  expect(close.status).toBe("completed");
  expect(controller.taskCloseInputs).toEqual([
    { taskId: "task_done", status: "cancelled", summary: "stop it", interrupt: false },
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
    expect(JSON.parse(list.result.output)).toMatchObject({
      count: 1,
      messages: [{ message_id: "event_mailbox", status: "queued", task_id: "task_done" }],
    });
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

function registryWithTaskTools(controller: SubagentControlController): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createTaskListTool(controller));
  registry.register(createTaskWaitTool(controller));
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

class FakeSubagentControlController implements SubagentControlController {
  taskListInputs: TaskListToolInput[] = [];
  taskWaitInputs: TaskWaitToolInput[] = [];
  taskFollowupInputs: TaskFollowupToolInput[] = [];
  taskCloseInputs: TaskCloseToolInput[] = [];
  mailboxListInputs: MailboxListToolInput[] = [];
  mailboxConsumeInputs: MailboxConsumeToolInput[] = [];

  async listTasks(input: TaskListToolInput): Promise<SubagentTaskRecord[]> {
    this.taskListInputs.push(input);
    return [taskRecord("completed")];
  }

  async waitTask(input: TaskWaitToolInput): Promise<SubagentTaskRecord> {
    this.taskWaitInputs.push(input);
    return taskRecord("completed");
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

function taskRecord(status: SubagentTaskRecord["status"]): SubagentTaskRecord {
  return {
    taskId: "task_done",
    path: "/root/task_done" as AgentPath,
    taskName: "Done task",
    status,
    mode: "resumable",
    generation: 2,
    currentRunId: "agent_done",
    childSessionId: "session_child",
    childThreadId: "thread_child",
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
    childSessionId: "session_child",
    childThreadId: "thread_child",
    message: { role: "user", content: "continue" },
    createdAt: 1,
    ...(status === "consumed" ? { consumedAt: 2 } : {}),
  };
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}
