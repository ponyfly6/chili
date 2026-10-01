import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { createAgentMessageListTool, createAgentMessageSendTool } from "./builtins/agent-message.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type {
  AgentMessageListToolInput,
  AgentMessageRecord,
  AgentMessageSendToolInput,
  AgentMessageToolController,
} from "./agent-message.js";
import type { ExecuteToolInput } from "./types.js";

test("agent message tools distinguish queue-only from trigger-turn delivery", async () => {
  const controller = new FakeAgentMessageController();
  const executor = createExecutor(controller);

  const queued = await executor.execute(toolInput("send_message", {
    message_id: "message_1",
    to: "reader",
    text: "keep this for your next turn",
  }));
  const triggered = await executor.execute(toolInput("agent_message_send", {
    to: "parent",
    content: "I need a decision",
    delivery: "trigger-turn",
    metadata: { kind: "question" },
  }));

  expect(queued.status).toBe("completed");
  expect(triggered.status).toBe("completed");
  expect(controller.sendInputs).toEqual([
    {
      messageId: "message_1",
      to: "reader",
      content: "keep this for your next turn",
      delivery: "queueOnly",
    },
    {
      to: "parent",
      content: "I need a decision",
      delivery: "triggerTurn",
      metadata: { kind: "question" },
    },
  ]);
  if (triggered.status === "completed") {
    expect(JSON.parse(triggered.result.output)).toMatchObject({
      from_path: "/root/worker",
      to_path: "/root",
      delivery: "triggerTurn",
      status: "queued",
    });
  }
});

test("agent message list normalizes filters and preserves controller FIFO order", async () => {
  const controller = new FakeAgentMessageController();
  const executor = createExecutor(controller);

  const result = await executor.execute(toolInput("list_agent_messages", {
    status: "consumed",
    task_id: "task_reader",
    path: "/root/reader",
    from: "/root",
    limit: 2,
  }));

  expect(result.status).toBe("completed");
  expect(controller.listInputs).toEqual([{
    status: "consumed",
    taskId: "task_reader",
    path: "/root/reader",
    from: "/root",
    limit: 2,
  }]);
  if (result.status === "completed") {
    expect(JSON.parse(result.result.output)).toMatchObject({
      count: 2,
      messages: [{ message_id: "message_1" }, { message_id: "message_2" }],
    });
  }
});

class FakeAgentMessageController implements AgentMessageToolController {
  sendInputs: AgentMessageSendToolInput[] = [];
  listInputs: AgentMessageListToolInput[] = [];

  async sendAgentMessage(input: AgentMessageSendToolInput): Promise<AgentMessageRecord> {
    this.sendInputs.push(input);
    return record(input.messageId ?? "message_2", input.delivery ?? "queueOnly");
  }

  async listAgentMessages(input: AgentMessageListToolInput): Promise<AgentMessageRecord[]> {
    this.listInputs.push(input);
    return [record("message_1", "queueOnly"), record("message_2", "triggerTurn")];
  }
}

function record(messageId: string, delivery: AgentMessageRecord["delivery"]): AgentMessageRecord {
  return {
    messageId,
    fromPath: "/root/worker",
    toPath: "/root",
    delivery,
    status: "queued",
    content: "message content",
    createdAt: 1,
  };
}

function createExecutor(controller: AgentMessageToolController): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  registry.register(createAgentMessageSendTool(controller));
  registry.register(createAgentMessageListTool(controller));
  return new ToolExecutor({
    registry,
    events: { publish: async (_event: ChiliEvent) => undefined },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
}

function toolInput(toolName: string, input: unknown): ExecuteToolInput {
  return {
    sessionId: "session_tools" as SessionId,
    turnId: "turn_tools" as TurnId,
    toolName,
    input,
    cwd: process.cwd(),
  };
}

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix) => `${prefix}_${++next}`;
}
