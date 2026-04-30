import type { ToolResult } from "@chili/protocol";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import type {
  CompleteTaskStatus,
  CompleteTaskToolInput,
  MailboxConsumeToolInput,
  MailboxListToolInput,
  SubagentController,
  SubagentControlController,
  SubagentMailboxRecord,
  SubagentTaskCompletion,
  SubagentTaskHandle,
  SubagentTaskRecord,
  SubagentTaskStatus,
  TaskToolInput,
  TaskCloseToolInput,
  TaskFollowupToolInput,
  TaskListToolInput,
  TaskWaitToolInput,
} from "../subagent.js";

export interface SubagentToolMetadata extends Record<string, unknown> {
  task_id: string;
  taskId: string;
  summary: string;
  status: string;
  mode?: string;
}

export interface SubagentToolResult extends ToolResult {
  metadata: Record<string, unknown>;
}

export function createTaskTool(controller: SubagentController): ChiliToolDefinition<TaskToolInput, SubagentToolResult> {
  return {
    name: "task",
    aliases: ["agent"],
    description:
      "Spawn an ad-hoc local subagent task through the injected subagent controller. If you created or assigned a persistent team task, use team_task_dispatch instead so the team board stays linked and synced.",
    risk: "execute",
    inputSchema: {
      type: "object",
      required: ["description", "prompt"],
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
        mode: { type: "string" },
        subagent_type: { type: "string" },
      },
    },
    validate(input): ValidationResult<TaskToolInput> {
      return validateTaskInput(input);
    },
    approval(input) {
      return {
        permission: "task",
        patterns: [input.mode ?? "default"],
        metadata: {
          description: input.description,
          mode: input.mode ?? "default",
          promptPreview: preview(input.prompt),
        },
      };
    },
    async execute(input, context) {
      await context.metadata({
        metadata: {
          description: input.description,
          mode: input.mode ?? "default",
        },
      });

      const task = await controller.spawnTask(input, context);
      return taskToolResult(task, input.mode);
    },
  };
}

export function createCompleteTaskTool(
  controller: SubagentController,
): ChiliToolDefinition<CompleteTaskToolInput, SubagentToolResult> {
  return {
    name: "complete_task",
    description: "Complete the current local subagent task through the injected subagent controller.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["taskId", "summary"],
      properties: {
        taskId: { type: "string" },
        task_id: { type: "string" },
        summary: { type: "string" },
        status: { type: "string", enum: ["completed", "failed", "cancelled"] },
      },
    },
    validate(input): ValidationResult<CompleteTaskToolInput> {
      return validateCompleteTaskInput(input);
    },
    approval() {
      return false;
    },
    async execute(input, context) {
      await context.metadata({
        metadata: {
          taskId: input.taskId,
          task_id: input.taskId,
          status: input.status ?? "completed",
        },
      });

      const completion = await controller.completeTask(input, context);
      return completeTaskToolResult(completion);
    },
  };
}

export function createTaskListTool(
  controller: SubagentControlController,
): ChiliToolDefinition<TaskListToolInput, SubagentToolResult> {
  return {
    name: "task_list",
    aliases: ["list_tasks", "agent_list"],
    description: "List local subagent tasks visible to the current session.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "running", "completed", "failed", "cancelled"] },
        limit: { type: "number" },
        all: { type: "boolean" },
      },
    },
    validate(input): ValidationResult<TaskListToolInput> {
      return validateTaskListInput(input);
    },
    approval: () => false,
    async execute(input, context) {
      const tasks = await controller.listTasks(input, context);
      return taskListToolResult(tasks);
    },
  };
}

export function createTaskWaitTool(
  controller: SubagentControlController,
): ChiliToolDefinition<TaskWaitToolInput, SubagentToolResult> {
  return {
    name: "task_wait",
    aliases: ["wait_task", "agent_wait"],
    description: "Wait until a local subagent task reaches a final state.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string" },
        task_id: { type: "string" },
        timeoutMs: { type: "number" },
        timeout_ms: { type: "number" },
      },
    },
    validate(input): ValidationResult<TaskWaitToolInput> {
      return validateTaskWaitInput(input);
    },
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { taskId: input.taskId, task_id: input.taskId } });
      const task = await controller.waitTask(input, context);
      return taskRecordToolResult("task_wait", task);
    },
  };
}

export function createTaskFollowupTool(
  controller: SubagentControlController,
): ChiliToolDefinition<TaskFollowupToolInput, SubagentToolResult> {
  return {
    name: "task_followup",
    aliases: ["followup_task", "agent_followup"],
    description: "Send a follow-up prompt to an existing resumable subagent task.",
    risk: "execute",
    inputSchema: {
      type: "object",
      required: ["taskId", "prompt"],
      properties: {
        taskId: { type: "string" },
        task_id: { type: "string" },
        prompt: { type: "string" },
        text: { type: "string" },
        message: { type: "string" },
        maxTurns: { type: "number" },
        max_turns: { type: "number" },
      },
    },
    validate(input): ValidationResult<TaskFollowupToolInput> {
      return validateTaskFollowupInput(input);
    },
    approval(input) {
      return {
        permission: "task",
        patterns: [input.taskId],
        metadata: {
          taskId: input.taskId,
          task_id: input.taskId,
          promptPreview: preview(input.prompt),
        },
      };
    },
    async execute(input, context) {
      await context.metadata({
        metadata: {
          taskId: input.taskId,
          task_id: input.taskId,
          promptPreview: preview(input.prompt),
        },
      });
      const task = await controller.followupTask(input, context);
      return taskRecordToolResult("task_followup", task);
    },
  };
}

export function createTaskCloseTool(
  controller: SubagentControlController,
): ChiliToolDefinition<TaskCloseToolInput, SubagentToolResult> {
  return {
    name: "task_close",
    aliases: ["close_task", "agent_close"],
    description: "Close a local subagent task, usually cancelling or marking it completed.",
    risk: "execute",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string" },
        task_id: { type: "string" },
        status: { type: "string", enum: ["completed", "failed", "cancelled"] },
        summary: { type: "string" },
        error: { type: "string" },
        interrupt: { type: "boolean" },
      },
    },
    validate(input): ValidationResult<TaskCloseToolInput> {
      return validateTaskCloseInput(input);
    },
    approval(input) {
      return {
        permission: "task",
        patterns: [input.taskId],
        metadata: {
          taskId: input.taskId,
          task_id: input.taskId,
          status: input.status ?? "cancelled",
          summary: input.summary,
        },
      };
    },
    async execute(input, context) {
      await context.metadata({
        metadata: {
          taskId: input.taskId,
          task_id: input.taskId,
          status: input.status ?? "cancelled",
        },
      });
      const task = await controller.closeTask(input, context);
      return taskRecordToolResult("task_close", task);
    },
  };
}

export function createMailboxListTool(
  controller: SubagentControlController,
): ChiliToolDefinition<MailboxListToolInput, SubagentToolResult> {
  return {
    name: "mailbox_list",
    aliases: ["list_mailbox", "agent_mailbox"],
    description: "List queued or consumed mailbox messages for local subagents.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["queued", "delivering", "consumed"] },
        taskId: { type: "string" },
        task_id: { type: "string" },
        path: { type: "string" },
        limit: { type: "number" },
        all: { type: "boolean" },
      },
    },
    validate(input): ValidationResult<MailboxListToolInput> {
      return validateMailboxListInput(input);
    },
    approval: () => false,
    async execute(input, context) {
      const messages = await controller.listMailbox(input, context);
      return mailboxListToolResult(messages);
    },
  };
}

export function createMailboxConsumeTool(
  controller: SubagentControlController,
): ChiliToolDefinition<MailboxConsumeToolInput, SubagentToolResult> {
  return {
    name: "mailbox_consume",
    aliases: ["consume_mailbox", "agent_mailbox_consume"],
    description: "Consume a queued subagent mailbox message and deliver it to the child session if required.",
    risk: "execute",
    inputSchema: {
      type: "object",
      required: ["messageId"],
      properties: {
        messageId: { type: "string" },
        message_id: { type: "string" },
        id: { type: "string" },
      },
    },
    validate(input): ValidationResult<MailboxConsumeToolInput> {
      return validateMailboxConsumeInput(input);
    },
    approval(input) {
      return {
        permission: "mailbox",
        patterns: [input.messageId],
        metadata: { messageId: input.messageId, message_id: input.messageId },
      };
    },
    async execute(input, context) {
      await context.metadata({ metadata: { messageId: input.messageId, message_id: input.messageId } });
      const message = await controller.consumeMailbox(input, context);
      return mailboxRecordToolResult("mailbox_consume", message);
    },
  };
}

function validateTaskInput(input: unknown): ValidationResult<TaskToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };

  const description = pickOptionalString(input, ["description", "title", "name", "summary"]);
  if (!description.ok) return { ok: false, message: "description must be a string" };

  const prompt = pickOptionalString(input, ["prompt", "task", "instructions", "instruction", "message"]);
  if (!prompt.ok) return { ok: false, message: "prompt must be a string" };

  const mode = pickOptionalString(input, ["mode", "subagent_type", "subagentType", "agentType", "type"]);
  if (!mode.ok) return { ok: false, message: "mode must be a string" };

  const promptValue = nonEmptyString(prompt.value ?? description.value);
  if (promptValue === undefined) {
    return { ok: false, message: "prompt or description must be a non-empty string" };
  }

  const descriptionValue = nonEmptyString(description.value ?? summarizePrompt(promptValue));
  if (descriptionValue === undefined) {
    return { ok: false, message: "description must be a non-empty string" };
  }

  const value: TaskToolInput = {
    description: descriptionValue,
    prompt: promptValue,
  };

  const modeValue = nonEmptyString(mode.value);
  if (mode.value !== undefined && modeValue === undefined) {
    return { ok: false, message: "mode must be a non-empty string" };
  }
  if (modeValue !== undefined) value.mode = modeValue;

  return { ok: true, value };
}

function validateCompleteTaskInput(input: unknown): ValidationResult<CompleteTaskToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };

  const taskId = pickOptionalString(input, ["taskId", "task_id", "id"]);
  if (!taskId.ok) return { ok: false, message: "taskId must be a string" };

  const summary = pickOptionalString(input, ["summary", "result", "response", "message"]);
  if (!summary.ok) return { ok: false, message: "summary must be a string" };

  const taskIdValue = nonEmptyString(taskId.value);
  if (taskIdValue === undefined) {
    return { ok: false, message: "taskId must be a non-empty string" };
  }

  const summaryValue = nonEmptyString(summary.value);
  if (summaryValue === undefined) {
    return { ok: false, message: "summary must be a non-empty string" };
  }

  const status = normalizeCompleteStatus(input.status ?? input.state ?? input.outcome);
  if (!status.ok) return status;

  const value: CompleteTaskToolInput = {
    taskId: taskIdValue,
    summary: summaryValue,
    status: status.value ?? "completed",
  };

  return { ok: true, value };
}

function validateTaskListInput(input: unknown): ValidationResult<TaskListToolInput> {
  const record = optionalRecord(input);
  if (!record.ok) return record;

  const status = normalizeTaskStatus(record.value.status);
  if (!status.ok) return status;
  const limit = optionalPositiveInteger(record.value.limit, "limit");
  if (!limit.ok) return limit;
  const all = optionalBoolean(record.value.all, "all");
  if (!all.ok) return all;

  const value: TaskListToolInput = {};
  if (status.value) value.status = status.value;
  if (limit.value !== undefined) value.limit = limit.value;
  if (all.value !== undefined) value.all = all.value;
  return { ok: true, value };
}

function validateTaskWaitInput(input: unknown): ValidationResult<TaskWaitToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const taskId = requiredNonEmptyString(pickOptionalString(input, ["taskId", "task_id", "id"]), "taskId");
  if (!taskId.ok) return taskId;
  const timeoutMs = optionalPositiveInteger(input.timeoutMs ?? input.timeout_ms, "timeoutMs");
  if (!timeoutMs.ok) return timeoutMs;

  const value: TaskWaitToolInput = { taskId: taskId.value };
  if (timeoutMs.value !== undefined) value.timeoutMs = timeoutMs.value;
  return { ok: true, value };
}

function validateTaskFollowupInput(input: unknown): ValidationResult<TaskFollowupToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const taskId = requiredNonEmptyString(pickOptionalString(input, ["taskId", "task_id", "id"]), "taskId");
  if (!taskId.ok) return taskId;
  const prompt = requiredNonEmptyString(pickOptionalString(input, ["prompt", "text", "message", "instructions"]), "prompt");
  if (!prompt.ok) return prompt;
  const maxTurns = optionalPositiveInteger(input.maxTurns ?? input.max_turns, "maxTurns");
  if (!maxTurns.ok) return maxTurns;

  const value: TaskFollowupToolInput = { taskId: taskId.value, prompt: prompt.value };
  if (maxTurns.value !== undefined) value.maxTurns = maxTurns.value;
  return { ok: true, value };
}

function validateTaskCloseInput(input: unknown): ValidationResult<TaskCloseToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const taskId = requiredNonEmptyString(pickOptionalString(input, ["taskId", "task_id", "id"]), "taskId");
  if (!taskId.ok) return taskId;
  const status = normalizeCompleteStatus(input.status ?? input.state ?? input.outcome);
  if (!status.ok) return status;
  const summary = pickOptionalString(input, ["summary", "reason", "message"]);
  if (!summary.ok) return { ok: false, message: "summary must be a string" };
  const error = pickOptionalString(input, ["error"]);
  if (!error.ok) return { ok: false, message: "error must be a string" };
  const interrupt = optionalBoolean(input.interrupt, "interrupt");
  if (!interrupt.ok) return interrupt;

  const value: TaskCloseToolInput = { taskId: taskId.value };
  if (status.value) value.status = status.value;
  const summaryValue = nonEmptyString(summary.value);
  if (summaryValue !== undefined) value.summary = summaryValue;
  const errorValue = nonEmptyString(error.value);
  if (errorValue !== undefined) value.error = errorValue;
  if (interrupt.value !== undefined) value.interrupt = interrupt.value;
  return { ok: true, value };
}

function validateMailboxListInput(input: unknown): ValidationResult<MailboxListToolInput> {
  const record = optionalRecord(input);
  if (!record.ok) return record;

  const status = normalizeMailboxStatus(record.value.status);
  if (!status.ok) return status;
  const taskId = pickOptionalString(record.value, ["taskId", "task_id"]);
  if (!taskId.ok) return { ok: false, message: "taskId must be a string" };
  const path = pickOptionalString(record.value, ["path"]);
  if (!path.ok) return { ok: false, message: "path must be a string" };
  const limit = optionalPositiveInteger(record.value.limit, "limit");
  if (!limit.ok) return limit;
  const all = optionalBoolean(record.value.all, "all");
  if (!all.ok) return all;

  const value: MailboxListToolInput = {};
  if (status.value) value.status = status.value;
  const taskIdValue = nonEmptyString(taskId.value);
  if (taskIdValue !== undefined) value.taskId = taskIdValue;
  const pathValue = nonEmptyString(path.value);
  if (pathValue !== undefined) value.path = pathValue;
  if (limit.value !== undefined) value.limit = limit.value;
  if (all.value !== undefined) value.all = all.value;
  return { ok: true, value };
}

function validateMailboxConsumeInput(input: unknown): ValidationResult<MailboxConsumeToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const messageId = requiredNonEmptyString(pickOptionalString(input, ["messageId", "message_id", "id"]), "messageId");
  if (!messageId.ok) return messageId;
  return { ok: true, value: { messageId: messageId.value } };
}

function taskToolResult(task: SubagentTaskHandle, mode?: string): SubagentToolResult {
  const metadata = metadataFor(task, mode);
  return {
    title: `task ${task.taskId}`,
    output: JSON.stringify({ task_id: task.taskId, summary: task.summary, status: task.status }),
    metadata,
  };
}

function completeTaskToolResult(completion: SubagentTaskCompletion): SubagentToolResult {
  const metadata = metadataFor(completion);
  return {
    title: `complete_task ${completion.taskId}`,
    output: JSON.stringify({
      task_id: completion.taskId,
      summary: completion.summary,
      status: completion.status,
    }),
    metadata,
  };
}

function taskListToolResult(tasks: readonly SubagentTaskRecord[]): SubagentToolResult {
  const output = {
    count: tasks.length,
    tasks: tasks.map(taskRecordOutput),
  };
  return {
    title: `task_list ${tasks.length}`,
    output: JSON.stringify(output),
    metadata: {
      count: tasks.length,
    },
  };
}

function taskRecordToolResult(title: string, task: SubagentTaskRecord): SubagentToolResult {
  return {
    title: `${title} ${task.taskId}`,
    output: JSON.stringify(taskRecordOutput(task)),
    metadata: {
      task_id: task.taskId,
      taskId: task.taskId,
      status: task.status,
      summary: task.summary ?? "",
    },
  };
}

function mailboxListToolResult(messages: readonly SubagentMailboxRecord[]): SubagentToolResult {
  const output = {
    count: messages.length,
    messages: messages.map(mailboxRecordOutput),
  };
  return {
    title: `mailbox_list ${messages.length}`,
    output: JSON.stringify(output),
    metadata: {
      count: messages.length,
    },
  };
}

function mailboxRecordToolResult(title: string, message: SubagentMailboxRecord): SubagentToolResult {
  return {
    title: `${title} ${message.messageId}`,
    output: JSON.stringify(mailboxRecordOutput(message)),
    metadata: {
      message_id: message.messageId,
      messageId: message.messageId,
      status: message.status,
      task_id: message.taskId ?? "",
      taskId: message.taskId ?? "",
    },
  };
}

function taskRecordOutput(task: SubagentTaskRecord): Record<string, unknown> {
  return pruneUndefined({
    task_id: task.taskId,
    taskId: task.taskId,
    path: task.path,
    task_name: task.taskName,
    taskName: task.taskName,
    status: task.status,
    mode: task.mode,
    generation: task.generation,
    current_run_id: task.currentRunId,
    currentRunId: task.currentRunId,
    child_session_id: task.childSessionId,
    childSessionId: task.childSessionId,
    child_thread_id: task.childThreadId,
    childThreadId: task.childThreadId,
    summary: task.summary,
    error: task.error,
    created_at: task.createdAt,
    createdAt: task.createdAt,
    updated_at: task.updatedAt,
    updatedAt: task.updatedAt,
    completed_at: task.completedAt,
    completedAt: task.completedAt,
  });
}

function mailboxRecordOutput(message: SubagentMailboxRecord): Record<string, unknown> {
  return pruneUndefined({
    message_id: message.messageId,
    messageId: message.messageId,
    path: message.path,
    from_path: message.fromPath,
    fromPath: message.fromPath,
    status: message.status,
    trigger_turn: message.triggerTurn,
    triggerTurn: message.triggerTurn,
    task_id: message.taskId,
    taskId: message.taskId,
    child_session_id: message.childSessionId,
    childSessionId: message.childSessionId,
    child_thread_id: message.childThreadId,
    childThreadId: message.childThreadId,
    message: message.message,
    created_at: message.createdAt,
    createdAt: message.createdAt,
    consumed_at: message.consumedAt,
    consumedAt: message.consumedAt,
  });
}

function metadataFor(task: SubagentTaskHandle | SubagentTaskCompletion, mode?: string): SubagentToolMetadata {
  const metadata: SubagentToolMetadata = {
    task_id: task.taskId,
    taskId: task.taskId,
    summary: task.summary,
    status: task.status,
  };
  if (mode !== undefined) metadata.mode = mode;
  return metadata;
}

function normalizeCompleteStatus(value: unknown): ValidationResult<CompleteTaskStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "status must be a string" };

  switch (value.trim().toLowerCase()) {
    case "completed":
    case "complete":
    case "done":
    case "success":
      return { ok: true, value: "completed" };
    case "failed":
    case "failure":
    case "error":
      return { ok: true, value: "failed" };
    case "cancelled":
    case "canceled":
    case "cancel":
      return { ok: true, value: "cancelled" };
    default:
      return { ok: false, message: "status must be completed, failed, or cancelled" };
  }
}

function normalizeTaskStatus(value: unknown): ValidationResult<SubagentTaskStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "status must be a string" };
  switch (value.trim().toLowerCase()) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return { ok: true, value: value.trim().toLowerCase() as SubagentTaskStatus };
    case "canceled":
      return { ok: true, value: "cancelled" };
    default:
      return { ok: false, message: "status must be pending, running, completed, failed, or cancelled" };
  }
}

function normalizeMailboxStatus(value: unknown): ValidationResult<"queued" | "delivering" | "consumed" | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "status must be a string" };
  switch (value.trim().toLowerCase()) {
    case "queued":
    case "pending":
      return { ok: true, value: "queued" };
    case "delivering":
    case "running":
      return { ok: true, value: "delivering" };
    case "consumed":
    case "done":
      return { ok: true, value: "consumed" };
    default:
      return { ok: false, message: "status must be queued, delivering, or consumed" };
  }
}

function optionalRecord(input: unknown): ValidationResult<Record<string, unknown>> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  return { ok: true, value: input };
}

function requiredNonEmptyString(
  picked: { ok: true; value?: string } | { ok: false },
  name: string,
): ValidationResult<string> {
  if (!picked.ok) return { ok: false, message: `${name} must be a string` };
  const value = nonEmptyString(picked.value);
  if (value === undefined) return { ok: false, message: `${name} must be a non-empty string` };
  return { ok: true, value };
}

function optionalPositiveInteger(value: unknown, name: string): ValidationResult<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { ok: false, message: `${name} must be a positive integer` };
  }
  return { ok: true, value };
}

function optionalBoolean(value: unknown, name: string): ValidationResult<boolean | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "boolean") return { ok: false, message: `${name} must be a boolean` };
  return { ok: true, value };
}

function pickOptionalString(
  record: Record<string, unknown>,
  keys: readonly string[],
): { ok: true; value?: string } | { ok: false } {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return { ok: false };
    return { ok: true, value };
  }
  return { ok: true };
}

function nonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function summarizePrompt(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 80) return singleLine;
  return `${singleLine.slice(0, 77)}...`;
}

function preview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 300) return normalized;
  return `${normalized.slice(0, 300)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pruneUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = item;
  }
  return output;
}
