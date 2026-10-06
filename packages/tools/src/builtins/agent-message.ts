import type { ToolResult } from "@chili/protocol";
import { normalizeAgentPath } from "@chili/protocol";
import type {
  AgentMessageDelivery,
  AgentMessageListToolInput,
  AgentMessageRecord,
  AgentMessageSendToolInput,
  AgentMessageToolController,
} from "../agent-message.js";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";

export interface AgentMessageToolResult extends ToolResult {
  metadata: Record<string, unknown>;
}

export function createAgentMessageSendTool(
  controller: AgentMessageToolController,
): ChiliToolDefinition<AgentMessageSendToolInput, AgentMessageToolResult> {
  return {
    name: "agent_message_send",
    aliases: ["send_agent_message", "send_message"],
    description:
      "Send a durable message to an ad-hoc agent by task id, canonical path, task name, or 'parent'. queueOnly records without starting a turn; triggerTurn wakes only a live recipient.",
    resourcePolicy: "internal",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["to", "content"],
      properties: {
        messageId: { type: "string" },
        message_id: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        target: { type: "string" },
        content: { type: "string" },
        text: { type: "string" },
        message: { type: "string" },
        delivery: { type: "string", enum: ["queueOnly", "triggerTurn"] },
        taskId: { type: "string" },
        task_id: { type: "string" },
        metadata: { type: "object" },
      },
    },
    validate: validateAgentMessageSendInput,
    approval: () => false,
    async execute(input, context) {
      await context.metadata({
        metadata: {
          messageId: input.messageId,
          message_id: input.messageId,
          to: input.to,
          delivery: input.delivery ?? "queueOnly",
          taskId: input.taskId,
          task_id: input.taskId,
        },
      });
      return agentMessageRecordResult("agent_message_send", await controller.sendAgentMessage(input, context));
    },
  };
}

export function createAgentMessageListTool(
  controller: AgentMessageToolController,
): ChiliToolDefinition<AgentMessageListToolInput, AgentMessageToolResult> {
  return {
    name: "agent_message_list",
    aliases: ["list_agent_messages"],
    description: "List durable ad-hoc agent messages visible to the current agent tree in FIFO order.",
    resourcePolicy: "internal",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["queued", "delivering", "consumed", "discarded"] },
        taskId: { type: "string" },
        task_id: { type: "string" },
        path: { type: "string" },
        from: { type: "string" },
        limit: { type: "number" },
        all: { type: "boolean" },
      },
    },
    validate: validateAgentMessageListInput,
    approval: () => false,
    async execute(input, context) {
      return agentMessageListResult(await controller.listAgentMessages(input, context));
    },
  };
}

function validateAgentMessageSendInput(input: unknown): ValidationResult<AgentMessageSendToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const to = requiredString(input, ["to", "target"], "to");
  if (!to.ok) return to;
  const content = requiredString(input, ["content", "text", "message"], "content");
  if (!content.ok) return content;
  const from = optionalString(input, ["from"], "from");
  if (!from.ok) return from;
  if (from.value) {
    try {
      normalizeAgentPath(from.value);
    } catch {
      return { ok: false, message: "from must be an absolute canonical agent path" };
    }
  }
  const delivery = normalizeDelivery(input.delivery);
  if (!delivery.ok) return delivery;
  const metadata = optionalObject(input.metadata, "metadata");
  if (!metadata.ok) return metadata;

  const value: AgentMessageSendToolInput = {
    to: to.value,
    content: content.value,
    delivery: delivery.value ?? "queueOnly",
  };
  assignString(value, "messageId", pickString(input, ["messageId", "message_id"]));
  assignString(value, "taskId", pickString(input, ["taskId", "task_id"]));
  if (from.value) value.from = normalizeAgentPath(from.value);
  if (metadata.value) value.metadata = metadata.value;
  return { ok: true, value };
}

function validateAgentMessageListInput(input: unknown): ValidationResult<AgentMessageListToolInput> {
  const record = input === undefined || input === null ? {} : input;
  if (!isRecord(record)) return { ok: false, message: "expected an object" };
  const status = record.status;
  if (
    status !== undefined &&
    status !== "queued" &&
    status !== "delivering" &&
    status !== "consumed" &&
    status !== "discarded"
  ) {
    return { ok: false, message: "status must be queued, delivering, consumed, or discarded" };
  }
  const path = optionalString(record, ["path"], "path");
  if (!path.ok) return path;
  const from = optionalString(record, ["from"], "from");
  if (!from.ok) return from;
  for (const [name, value] of [["path", path.value], ["from", from.value]] as const) {
    if (!value) continue;
    try {
      normalizeAgentPath(value);
    } catch {
      return { ok: false, message: `${name} must be an absolute canonical agent path` };
    }
  }
  const limit = optionalPositiveInteger(record.limit, "limit");
  if (!limit.ok) return limit;
  if (record.all !== undefined && typeof record.all !== "boolean") {
    return { ok: false, message: "all must be a boolean" };
  }

  const value: AgentMessageListToolInput = {};
  if (status) value.status = status;
  assignString(value, "taskId", pickString(record, ["taskId", "task_id"]));
  if (path.value) value.path = normalizeAgentPath(path.value);
  if (from.value) value.from = normalizeAgentPath(from.value);
  if (limit.value !== undefined) value.limit = limit.value;
  if (record.all !== undefined) value.all = record.all;
  return { ok: true, value };
}

function agentMessageRecordResult(title: string, message: AgentMessageRecord): AgentMessageToolResult {
  return {
    title: `${title} ${message.messageId}`,
    output: JSON.stringify(agentMessageOutput(message)),
    metadata: {
      messageId: message.messageId,
      message_id: message.messageId,
      from: message.fromPath,
      to: message.toPath,
      delivery: message.delivery,
      status: message.status,
    },
  };
}

function agentMessageListResult(messages: readonly AgentMessageRecord[]): AgentMessageToolResult {
  return {
    title: `agent_message_list ${messages.length}`,
    output: JSON.stringify({ count: messages.length, messages: messages.map(agentMessageOutput) }),
    metadata: { count: messages.length },
  };
}

function agentMessageOutput(message: AgentMessageRecord): Record<string, unknown> {
  return pruneUndefined({
    message_id: message.messageId,
    messageId: message.messageId,
    from_path: message.fromPath,
    fromPath: message.fromPath,
    to_path: message.toPath,
    toPath: message.toPath,
    delivery: message.delivery,
    status: message.status,
    task_id: message.taskId,
    taskId: message.taskId,
    recipient_session_id: message.recipientSessionId,
    recipientSessionId: message.recipientSessionId,
    content: message.content,
    metadata: message.metadata,
    created_at: message.createdAt,
    createdAt: message.createdAt,
    consumed_at: message.consumedAt,
    consumedAt: message.consumedAt,
  });
}

function normalizeDelivery(value: unknown): ValidationResult<AgentMessageDelivery | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "delivery must be a string" };
  switch (value.trim().toLowerCase()) {
    case "queueonly":
    case "queue_only":
    case "queue-only":
    case "queue":
      return { ok: true, value: "queueOnly" };
    case "triggerturn":
    case "trigger_turn":
    case "trigger-turn":
    case "wake":
      return { ok: true, value: "triggerTurn" };
    default:
      return { ok: false, message: "delivery must be queueOnly or triggerTurn" };
  }
}

function requiredString(
  input: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): ValidationResult<string> {
  const value = pickString(input, keys);
  return value ? { ok: true, value } : { ok: false, message: `${name} must be a non-empty string` };
}

function optionalString(
  input: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): ValidationResult<string | undefined> {
  const present = keys.find((key) => input[key] !== undefined);
  if (!present) return { ok: true, value: undefined };
  if (typeof input[present] !== "string") return { ok: false, message: `${name} must be a string` };
  const value = (input[present] as string).trim();
  return value ? { ok: true, value } : { ok: false, message: `${name} must be a non-empty string` };
}

function optionalObject(value: unknown, name: string): ValidationResult<Record<string, unknown> | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value)) return { ok: false, message: `${name} must be an object` };
  return { ok: true, value };
}

function optionalPositiveInteger(value: unknown, name: string): ValidationResult<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Number.isInteger(value) || (value as number) <= 0) {
    return { ok: false, message: `${name} must be a positive integer` };
  }
  return { ok: true, value: value as number };
}

function pickString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function assignString<T extends object, K extends keyof T>(target: T, key: K, value: string | undefined): void {
  if (value !== undefined) target[key] = value as T[K];
}

function pruneUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
