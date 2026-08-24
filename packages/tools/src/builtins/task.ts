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
  SubagentTaskBatchWaitRecord,
  SubagentTaskCompletion,
  SubagentTaskHandle,
  SubagentTaskRecord,
  SubagentTaskStatus,
  TaskCompletionPolicy,
  TaskBatchToolInput,
  TaskToolInput,
  TaskCloseToolInput,
  TaskFollowupToolInput,
  TaskListToolInput,
  TaskWaitBatchToolInput,
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

const DEFAULT_TASK_BATCH_CONCURRENCY = 3;
const MAX_TASK_BATCH_CONCURRENCY = 32;
const DEFAULT_TASK_BATCH_COMPLETION_POLICY: TaskCompletionPolicy = "join";
const DEFAULT_TASK_BATCH_JOIN_TIMEOUT_MS = 600_000;
const MAX_TASK_BATCH_TASKS = 64;

interface TaskBatchSpawnFailure {
  batchIndex: number;
  description: string;
  error: string;
}

interface TaskBatchSpawnResult {
  tasks: SubagentTaskHandle[];
  failures: TaskBatchSpawnFailure[];
}

export function createTaskTool(controller: SubagentController): ChiliToolDefinition<TaskToolInput, SubagentToolResult> {
  return {
    name: "task",
    aliases: ["agent"],
    description:
      "Spawn one ad-hoc local subagent. For work required by the current response, use one-shot/resumable so the final result returns inline, or use task_batch (default join) for parallel work. Background defaults to completion_policy=notify: it returns a handle immediately and wakes the parent at terminal state; detached never wakes. Do not answer the original request with only a launch status: wait/read the result, follow up or verify gaps, and integrate it. Use team_task_dispatch for persistent team-board work.",
    risk: "execute",
    inputSchema: {
      type: "object",
      required: ["description", "prompt"],
      properties: {
        description: { type: "string" },
        prompt: { type: "string" },
        mode: { type: "string" },
        subagent_type: { type: "string" },
        completionPolicy: { type: "string", enum: ["join", "notify", "detached"] },
        completion_policy: { type: "string", enum: ["join", "notify", "detached"] },
      },
    },
    validate(input): ValidationResult<TaskToolInput> {
      return validateTaskInput(input);
    },
    isConcurrencySafe(input) {
      return isBackgroundTaskInput(input);
    },
    approval(input) {
      return {
        permission: "task",
        patterns: ["spawn"],
        metadata: {
          description: input.description,
          mode: input.mode ?? "default",
          completionPolicy: input.completionPolicy ?? (normalizeTaskMode(input.mode) === "background" ? "notify" : "join"),
          promptPreview: preview(input.prompt),
        },
      };
    },
    async execute(input, context) {
      const completionPolicy = input.completionPolicy
        ?? (normalizeTaskMode(input.mode) === "background" ? "notify" : "join");
      await context.metadata({
        metadata: {
          description: input.description,
          mode: input.mode ?? "default",
          sourceCallId: context.callId,
          completionPolicy,
          completion_policy: completionPolicy,
          notificationRequested: completionPolicy === "notify",
        },
      });

      const task = await controller.spawnTask({
        ...input,
        sourceCallId: context.callId,
        completionPolicy,
      }, context);
      return taskToolResult(task, input.mode, completionPolicy, context.callId);
    },
  };
}

export function createTaskBatchTool(
  controller: SubagentController,
  lifecycleController?: SubagentControlController,
): ChiliToolDefinition<TaskBatchToolInput, SubagentToolResult> {
  return {
    name: "task_batch",
    aliases: ["agent_batch", "spawn_tasks", "spawn_agents"],
    description:
      "Spawn independent ad-hoc subagents in parallel. Use default join for one-pass work required by the current response; it waits inline and returns terminal summaries. Use completion_policy=supervised for multi-stage collaboration or quality review: it returns handles immediately but keeps this parent turn responsible for task_wait_batch(any), result review/task_followup, a final task_wait_batch(all), verification, and integration. notify is intentionally asynchronous and wakes a later parent turn; detached never wakes. max_concurrency defaults to 3 and is also runtime-capped. Do not finish with only a launch/completion status. Persistent team tasks should use team_task_dispatch.",
    risk: "execute",
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          maxItems: MAX_TASK_BATCH_TASKS,
          items: {
            type: "object",
            required: ["description", "prompt"],
            properties: {
              description: { type: "string" },
              prompt: { type: "string" },
              mode: { type: "string", enum: ["background"] },
              subagent_type: { type: "string", enum: ["background"] },
            },
          },
        },
        maxConcurrency: { type: "number" },
        max_concurrency: { type: "number" },
        completionPolicy: { type: "string", enum: ["join", "notify", "detached", "supervised"] },
        completion_policy: { type: "string", enum: ["join", "notify", "detached", "supervised"] },
        timeoutMs: { type: "number" },
        timeout_ms: { type: "number" },
        batchId: { type: "string" },
        batch_id: { type: "string" },
      },
    },
    validate(input): ValidationResult<TaskBatchToolInput> {
      return validateTaskBatchInput(input);
    },
    approval(input) {
      return {
        permission: "task",
        patterns: ["spawn"],
        metadata: {
          count: input.tasks.length,
          maxConcurrency: input.maxConcurrency ?? DEFAULT_TASK_BATCH_CONCURRENCY,
          requestedMaxConcurrency: input.maxConcurrency ?? DEFAULT_TASK_BATCH_CONCURRENCY,
          concurrencyLimitScope: "batch_request_capped_by_runtime_global",
          completionPolicy: input.completionPolicy ?? DEFAULT_TASK_BATCH_COMPLETION_POLICY,
          ...(input.batchId ? { batchId: input.batchId } : {}),
          tasks: input.tasks.map((task) => ({
            description: task.description,
            promptPreview: preview(task.prompt),
          })),
        },
      };
    },
    async execute(input, context) {
      const maxConcurrency = input.maxConcurrency ?? DEFAULT_TASK_BATCH_CONCURRENCY;
      const completionPolicy = input.completionPolicy ?? DEFAULT_TASK_BATCH_COMPLETION_POLICY;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TASK_BATCH_JOIN_TIMEOUT_MS;
      const batchId = input.batchId ?? context.callId;
      await context.metadata({
        metadata: {
          count: input.tasks.length,
          maxConcurrency,
          requestedMaxConcurrency: maxConcurrency,
          concurrencyLimitScope: "batch_request_capped_by_runtime_global",
          mode: "background",
          batchId,
          batch_id: batchId,
          completionPolicy,
          completion_policy: completionPolicy,
          expectedBatchSize: input.tasks.length,
          notificationRequested: completionPolicy === "notify",
        },
      });

      const scopedTasks = input.tasks.map((task, batchIndex): TaskToolInput => ({
        ...task,
        sourceCallId: context.callId,
        batchId,
        batchIndex,
        expectedBatchSize: input.tasks.length,
        maxConcurrency,
        completionPolicy,
      }));
      const spawned = await runTaskBatch(scopedTasks, maxConcurrency, (task) => controller.spawnTask(task, context));
      const tasks = spawned.tasks;
      if (completionPolicy !== "join") {
        return taskBatchToolResult(tasks, {
          batchId,
          completionPolicy,
          expectedBatchSize: scopedTasks.length,
          maxConcurrency,
          sourceCallId: context.callId,
          spawnFailures: spawned.failures,
        });
      }

      if (!lifecycleController || tasks.length === 0) {
        return taskBatchToolResult(tasks, {
          batchId,
          completionPolicy,
          joinAvailable: lifecycleController !== undefined,
          expectedBatchSize: scopedTasks.length,
          maxConcurrency,
          sourceCallId: context.callId,
          spawnFailures: spawned.failures,
        });
      }

      const waited = await lifecycleController.waitTasks({
        taskIds: tasks.map((task) => task.taskId),
        waitFor: "all",
        timeoutMs,
        batchId,
      }, context);
      return taskBatchToolResult(tasks, {
        batchId,
        completionPolicy,
        expectedBatchSize: scopedTasks.length,
        joinAvailable: true,
        maxConcurrency,
        sourceCallId: context.callId,
        spawnFailures: spawned.failures,
        waited,
      });
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
        status: { type: "string", enum: ["completed", "incomplete", "failed", "cancelled"] },
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
    description:
      "List local subagent tasks. Results are scoped to the current session unless all=true; task_ids can inspect an exact set of handles returned by task or task_batch.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "running", "completed", "incomplete", "failed", "cancelled"] },
        taskIds: { type: "array", items: { type: "string" } },
        task_ids: { type: "array", items: { type: "string" } },
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
      return taskListToolResult(tasks, input);
    },
  };
}

export function createTaskWaitTool(
  controller: SubagentControlController,
): ChiliToolDefinition<TaskWaitToolInput, SubagentToolResult> {
  return {
    name: "task_wait",
    aliases: ["wait_task", "agent_wait"],
    description:
      "Wait until one local subagent reaches a final state, then integrate its summary before responding. A timeout is an error; use task_wait_batch for partial batch snapshots.",
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

export function createTaskWaitBatchTool(
  controller: SubagentControlController,
): ChiliToolDefinition<TaskWaitBatchToolInput, SubagentToolResult> {
  return {
    name: "task_wait_batch",
    aliases: ["wait_tasks", "agent_wait_batch"],
    description:
      "Wait for any or all task_ids to reach a final state. Defaults to all. Timeout returns the latest partial statuses and preserves every handle; integrate completed summaries and report pending, failed, incomplete, or cancelled work.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      required: ["taskIds"],
      properties: {
        taskIds: { type: "array", items: { type: "string" } },
        task_ids: { type: "array", items: { type: "string" } },
        waitFor: { type: "string", enum: ["any", "all"] },
        wait_for: { type: "string", enum: ["any", "all"] },
        timeoutMs: { type: "number" },
        timeout_ms: { type: "number" },
        batchId: { type: "string" },
        batch_id: { type: "string" },
      },
    },
    validate(input): ValidationResult<TaskWaitBatchToolInput> {
      return validateTaskWaitBatchInput(input);
    },
    approval: () => false,
    async execute(input, context) {
      await context.metadata({
        metadata: {
          taskIds: input.taskIds,
          task_ids: input.taskIds,
          waitFor: input.waitFor ?? "all",
          wait_for: input.waitFor ?? "all",
          ...(input.batchId ? { batchId: input.batchId, batch_id: input.batchId } : {}),
        },
      });
      const waited = await controller.waitTasks(input, context);
      return taskWaitBatchToolResult(waited, input.batchId);
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
        status: { type: "string", enum: ["completed", "incomplete", "failed", "cancelled"] },
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
        status: { type: "string", enum: ["queued", "delivering", "consumed", "discarded"] },
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
  const completionPolicy = normalizeTaskCompletionPolicy(input.completionPolicy ?? input.completion_policy);
  if (!completionPolicy.ok) return completionPolicy;
  if (completionPolicy.value === "supervised") {
    return { ok: false, message: "completionPolicy=supervised is only supported by task_batch" };
  }

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
  if (completionPolicy.value !== undefined) value.completionPolicy = completionPolicy.value;

  return { ok: true, value };
}

function validateTaskBatchInput(input: unknown): ValidationResult<TaskBatchToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  if (!Array.isArray(input.tasks)) return { ok: false, message: "tasks must be an array" };
  if (input.tasks.length === 0) return { ok: false, message: "tasks must contain at least one task" };
  if (input.tasks.length > MAX_TASK_BATCH_TASKS) {
    return { ok: false, message: `tasks must contain ${MAX_TASK_BATCH_TASKS} tasks or fewer` };
  }

  const maxConcurrency = optionalPositiveInteger(input.maxConcurrency ?? input.max_concurrency, "maxConcurrency");
  if (!maxConcurrency.ok) return maxConcurrency;
  if (maxConcurrency.value !== undefined && maxConcurrency.value > MAX_TASK_BATCH_CONCURRENCY) {
    return { ok: false, message: `maxConcurrency must be ${MAX_TASK_BATCH_CONCURRENCY} or less` };
  }

  const completionPolicy = normalizeTaskCompletionPolicy(input.completionPolicy ?? input.completion_policy);
  if (!completionPolicy.ok) return completionPolicy;
  const timeoutMs = optionalPositiveInteger(input.timeoutMs ?? input.timeout_ms, "timeoutMs");
  if (!timeoutMs.ok) return timeoutMs;
  const batchId = optionalNonEmptyString(pickOptionalString(input, ["batchId", "batch_id"]), "batchId");
  if (!batchId.ok) return batchId;

  const tasks: TaskToolInput[] = [];
  for (const [index, item] of input.tasks.entries()) {
    const task = validateTaskInput(item);
    if (!task.ok) return { ok: false, message: `tasks[${index}]: ${task.message}` };
    const mode = normalizeTaskMode(task.value.mode);
    if (mode !== undefined && mode !== "background") {
      return { ok: false, message: `tasks[${index}].mode must be background` };
    }
    tasks.push({ ...task.value, mode: "background" });
  }

  const value: TaskBatchToolInput = { tasks };
  if (maxConcurrency.value !== undefined) value.maxConcurrency = maxConcurrency.value;
  value.completionPolicy = completionPolicy.value ?? DEFAULT_TASK_BATCH_COMPLETION_POLICY;
  if (timeoutMs.value !== undefined) value.timeoutMs = timeoutMs.value;
  if (batchId.value !== undefined) value.batchId = batchId.value;
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
  const taskIds = optionalTaskIds(record.value.taskIds ?? record.value.task_ids, "taskIds");
  if (!taskIds.ok) return taskIds;
  const limit = optionalPositiveInteger(record.value.limit, "limit");
  if (!limit.ok) return limit;
  const all = optionalBoolean(record.value.all, "all");
  if (!all.ok) return all;

  const value: TaskListToolInput = {};
  if (status.value) value.status = status.value;
  if (taskIds.value !== undefined) value.taskIds = taskIds.value;
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

function validateTaskWaitBatchInput(input: unknown): ValidationResult<TaskWaitBatchToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const taskIds = optionalTaskIds(input.taskIds ?? input.task_ids ?? input.ids, "taskIds");
  if (!taskIds.ok) return taskIds;
  if (taskIds.value === undefined || taskIds.value.length === 0) {
    return { ok: false, message: "taskIds must contain at least one task id" };
  }
  if (taskIds.value.length > MAX_TASK_BATCH_TASKS) {
    return { ok: false, message: `taskIds must contain ${MAX_TASK_BATCH_TASKS} or fewer unique task ids` };
  }

  const waitFor = normalizeTaskWaitMode(input.waitFor ?? input.wait_for);
  if (!waitFor.ok) return waitFor;
  const timeoutMs = optionalPositiveInteger(input.timeoutMs ?? input.timeout_ms, "timeoutMs");
  if (!timeoutMs.ok) return timeoutMs;
  const batchId = optionalNonEmptyString(pickOptionalString(input, ["batchId", "batch_id"]), "batchId");
  if (!batchId.ok) return batchId;

  const value: TaskWaitBatchToolInput = {
    taskIds: taskIds.value,
    waitFor: waitFor.value ?? "all",
  };
  if (timeoutMs.value !== undefined) value.timeoutMs = timeoutMs.value;
  if (batchId.value !== undefined) value.batchId = batchId.value;
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

function taskToolResult(
  task: SubagentTaskHandle,
  mode: string | undefined,
  completionPolicy: TaskCompletionPolicy,
  sourceCallId: string,
): SubagentToolResult {
  const metadata = {
    ...metadataFor(task, mode),
    completionPolicy,
    completion_policy: completionPolicy,
    notificationRequested: completionPolicy === "notify",
    sourceCallId,
    source_call_id: sourceCallId,
  };
  const background = normalizeTaskMode(mode) === "background";
  const integrationRequired = completionPolicy !== "detached";
  const resultDelivery = !background
    ? "inline_terminal"
    : completionPolicy === "notify"
      ? "completion_notification"
      : completionPolicy === "detached"
        ? "none"
        : "task_wait_required";
  const nextAction = !background
    ? "Read this final summary, verify or follow up on gaps, and integrate it into the answer to the original request."
    : completionPolicy === "notify"
      ? "This is only an interim handle. The parent will be woken at terminal state; then read the final summary and finish the original request instead of only reporting completion."
      : completionPolicy === "detached"
        ? "This task is intentionally detached and will not wake the parent; do not promise its result in the current response."
        : "Call task_wait for this handle, read the terminal summary, and integrate it before answering the original request.";
  return {
    title: `task ${task.taskId}`,
    output: JSON.stringify({
      task_state: { task_id: task.taskId, status: task.status },
      task_id: task.taskId,
      status: task.status,
      summary: task.summary,
      source_call_id: sourceCallId,
      completion_policy: completionPolicy,
      integration_required: integrationRequired,
      result_delivery: resultDelivery,
      next_action: nextAction,
    }),
    metadata: {
      ...metadata,
      integrationRequired,
      resultDelivery,
      nextAction,
    },
  };
}

function taskBatchToolResult(
  handles: readonly SubagentTaskHandle[],
  options: {
    batchId: string;
    completionPolicy: TaskCompletionPolicy;
    expectedBatchSize: number;
    maxConcurrency: number;
    sourceCallId: string;
    spawnFailures: readonly TaskBatchSpawnFailure[];
    joinAvailable?: boolean;
    waited?: SubagentTaskBatchWaitRecord;
  },
): SubagentToolResult {
  const tasks = options.waited?.tasks ?? handles;
  const finalCount = tasks.filter((task) => isFinalTaskStatus(task.status)).length;
  const failedCount = tasks.filter((task) => task.status === "failed").length;
  const incompleteCount = tasks.filter((task) => task.status === "incomplete").length;
  const cancelledCount = tasks.filter((task) => task.status === "cancelled").length;
  const pendingTaskIds = tasks.filter((task) => !isFinalTaskStatus(task.status)).map((task) => task.taskId);
  const satisfied = (options.waited?.satisfied ?? false) && options.spawnFailures.length === 0;
  const timedOut = options.waited?.timedOut ?? false;
  const nextAction = batchNextAction(options.completionPolicy, {
    finalCount,
    ...(options.joinAvailable !== undefined ? { joinAvailable: options.joinAvailable } : {}),
    spawnFailureCount: options.spawnFailures.length,
    taskCount: tasks.length,
    timedOut,
  });
  const taskOutputs = tasks.map((task) => "path" in task
    ? taskRecordOutput(task)
    : {
        task_id: task.taskId,
        taskId: task.taskId,
        summary: task.summary,
        status: task.status,
      });

  return {
    title: `task_batch ${options.expectedBatchSize}`,
    output: JSON.stringify({
      batch_id: options.batchId,
      batchId: options.batchId,
      source_call_id: options.sourceCallId,
      sourceCallId: options.sourceCallId,
      task_states: taskOutputs.map((task) => ({
        task_id: task.task_id,
        status: task.status,
      })),
      completion_policy: options.completionPolicy,
      completionPolicy: options.completionPolicy,
      count: options.expectedBatchSize,
      expected_batch_size: options.expectedBatchSize,
      expectedBatchSize: options.expectedBatchSize,
      spawned_count: handles.length,
      spawnedCount: handles.length,
      spawn_failure_count: options.spawnFailures.length,
      spawnFailureCount: options.spawnFailures.length,
      spawn_failures: options.spawnFailures.map((failure) => ({
        batch_index: failure.batchIndex,
        batchIndex: failure.batchIndex,
        description: failure.description,
        error: failure.error,
      })),
      max_concurrency: options.maxConcurrency,
      maxConcurrency: options.maxConcurrency,
      requested_max_concurrency: options.maxConcurrency,
      concurrency_limit_scope: "batch_request_capped_by_runtime_global",
      join_available: options.completionPolicy === "join" ? options.joinAvailable ?? false : undefined,
      joined: options.completionPolicy === "join" && options.waited !== undefined,
      satisfied,
      timed_out: timedOut,
      timedOut,
      final_count: finalCount,
      failed_count: failedCount,
      incomplete_count: incompleteCount,
      cancelled_count: cancelledCount,
      pending_count: pendingTaskIds.length,
      pending_task_ids: pendingTaskIds,
      integration_required: options.completionPolicy !== "detached",
      required_open_batch: options.completionPolicy === "supervised" && handles.length > 0,
      supervised_confirmation_required: options.completionPolicy === "supervised" && handles.length > 0,
      supervised_task_ids: options.completionPolicy === "supervised" ? handles.map((task) => task.taskId) : undefined,
      result_delivery: options.completionPolicy === "join"
        ? "inline"
        : options.completionPolicy === "notify"
          ? "completion_notification"
          : options.completionPolicy === "supervised" ? "supervised_loop" : "none",
      next_action: nextAction,
      tasks: taskOutputs,
    }),
    metadata: {
      batchId: options.batchId,
      batch_id: options.batchId,
      sourceCallId: options.sourceCallId,
      source_call_id: options.sourceCallId,
      completionPolicy: options.completionPolicy,
      completion_policy: options.completionPolicy,
      count: options.expectedBatchSize,
      expectedBatchSize: options.expectedBatchSize,
      spawnedCount: handles.length,
      spawnFailureCount: options.spawnFailures.length,
      spawnFailures: options.spawnFailures,
      maxConcurrency: options.maxConcurrency,
      requestedMaxConcurrency: options.maxConcurrency,
      concurrencyLimitScope: "batch_request_capped_by_runtime_global",
      task_ids: handles.map((task) => task.taskId),
      taskIds: handles.map((task) => task.taskId),
      status: options.spawnFailures.length > 0
        ? handles.length > 0 ? "partial_spawn" : "spawn_failed"
        : timedOut ? "timed_out" : satisfied ? "complete" : "running",
      mode: "background",
      satisfied,
      timedOut,
      finalCount,
      failedCount,
      incompleteCount,
      cancelledCount,
      pendingTaskIds,
      integrationRequired: options.completionPolicy !== "detached",
      requiredOpenBatch: options.completionPolicy === "supervised" && handles.length > 0,
      supervisedConfirmationRequired: options.completionPolicy === "supervised" && handles.length > 0,
      supervisedTaskIds: options.completionPolicy === "supervised" ? handles.map((task) => task.taskId) : [],
      resultDelivery: options.completionPolicy === "join"
        ? "inline"
        : options.completionPolicy === "notify"
          ? "completion_notification"
          : options.completionPolicy === "supervised" ? "supervised_loop" : "none",
      nextAction,
      notificationRequested: options.completionPolicy === "notify",
    },
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

function taskListToolResult(tasks: readonly SubagentTaskRecord[], input: TaskListToolInput): SubagentToolResult {
  const scope = input.all ? "all_sessions" : "current_session";
  const output = {
    count: tasks.length,
    scope,
    ...(input.taskIds ? { task_ids: input.taskIds } : {}),
    tasks: tasks.map(taskRecordOutput),
  };
  return {
    title: `task_list ${tasks.length}`,
    output: JSON.stringify(output),
    metadata: {
      count: tasks.length,
      scope,
    },
  };
}

function taskWaitBatchToolResult(waited: SubagentTaskBatchWaitRecord, batchId?: string): SubagentToolResult {
  const finalCount = waited.tasks.filter((task) => isFinalTaskStatus(task.status)).length;
  const failedCount = waited.tasks.filter((task) => task.status === "failed").length;
  const incompleteCount = waited.tasks.filter((task) => task.status === "incomplete").length;
  const cancelledCount = waited.tasks.filter((task) => task.status === "cancelled").length;
  const pendingTaskIds = waited.tasks.filter((task) => !isFinalTaskStatus(task.status)).map((task) => task.taskId);
  const batchClosed = pendingTaskIds.length === 0 && waited.waitFor === "all";
  const output = pruneUndefined({
    batch_id: batchId,
    batchId,
    task_states: waited.tasks.map((task) => ({ task_id: task.taskId, status: task.status })),
    wait_for: waited.waitFor,
    waitFor: waited.waitFor,
    satisfied: waited.satisfied,
    timed_out: waited.timedOut,
    timedOut: waited.timedOut,
    count: waited.tasks.length,
    final_count: finalCount,
    failed_count: failedCount,
    incomplete_count: incompleteCount,
    cancelled_count: cancelledCount,
    pending_count: pendingTaskIds.length,
    pending_task_ids: pendingTaskIds,
    required_open_batch: !batchClosed,
    batch_closed: batchClosed,
    next_action: waited.timedOut
      ? "Review newly terminal results, preserve the remaining task IDs, and call task_wait_batch again. For supervised work, use wait_for=any while reviewing/following up, then wait_for=all before the final integration."
      : pendingTaskIds.length > 0
        ? "Review terminal results and continue task_wait_batch(wait_for=any) on remaining IDs; follow up where needed, then wait_for=all before the final integration."
        : waited.waitFor !== "all"
          ? "All observed tasks are terminal, but supervised work still requires task_wait_batch(wait_for=all) over the complete batch before final integration."
          : "All requested tasks are terminal. Read every summary, follow up or verify gaps, and produce one substantive integrated answer.",
    tasks: waited.tasks.map(taskRecordOutput),
  });
  return {
    title: `task_wait_batch ${waited.tasks.length}`,
    output: JSON.stringify(output),
    metadata: {
      ...(batchId ? { batchId, batch_id: batchId } : {}),
      waitFor: waited.waitFor,
      satisfied: waited.satisfied,
      timedOut: waited.timedOut,
      count: waited.tasks.length,
      finalCount,
      failedCount,
      incompleteCount,
      cancelledCount,
      pendingTaskIds,
      requiredOpenBatch: !batchClosed,
      batchClosed,
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
    task_state: { task_id: task.taskId, status: task.status },
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
    case "incomplete":
    case "needs_attention":
      return { ok: true, value: "incomplete" };
    case "cancelled":
    case "canceled":
    case "cancel":
      return { ok: true, value: "cancelled" };
    default:
      return { ok: false, message: "status must be completed, incomplete, failed, or cancelled" };
  }
}

function normalizeTaskStatus(value: unknown): ValidationResult<SubagentTaskStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "status must be a string" };
  switch (value.trim().toLowerCase()) {
    case "pending":
    case "running":
    case "completed":
    case "incomplete":
    case "failed":
    case "cancelled":
      return { ok: true, value: value.trim().toLowerCase() as SubagentTaskStatus };
    case "canceled":
      return { ok: true, value: "cancelled" };
    default:
      return { ok: false, message: "status must be pending, running, completed, incomplete, failed, or cancelled" };
  }
}

function normalizeTaskCompletionPolicy(value: unknown): ValidationResult<TaskCompletionPolicy | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "completionPolicy must be a string" };
  switch (value.trim().toLowerCase()) {
    case "join":
    case "notify":
    case "detached":
    case "supervised":
      return { ok: true, value: value.trim().toLowerCase() as TaskCompletionPolicy };
    default:
      return { ok: false, message: "completionPolicy must be join, notify, detached, or supervised" };
  }
}

function normalizeTaskWaitMode(value: unknown): ValidationResult<"any" | "all" | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "waitFor must be a string" };
  switch (value.trim().toLowerCase()) {
    case "any":
    case "all":
      return { ok: true, value: value.trim().toLowerCase() as "any" | "all" };
    default:
      return { ok: false, message: "waitFor must be any or all" };
  }
}

function normalizeMailboxStatus(
  value: unknown,
): ValidationResult<"queued" | "delivering" | "consumed" | "discarded" | undefined> {
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
    case "discarded":
    case "skipped":
      return { ok: true, value: "discarded" };
    default:
      return { ok: false, message: "status must be queued, delivering, consumed, or discarded" };
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

function optionalNonEmptyString(
  picked: { ok: true; value?: string } | { ok: false },
  name: string,
): ValidationResult<string | undefined> {
  if (!picked.ok) return { ok: false, message: `${name} must be a string` };
  if (picked.value === undefined) return { ok: true, value: undefined };
  const value = nonEmptyString(picked.value);
  if (value === undefined) return { ok: false, message: `${name} must be a non-empty string` };
  return { ok: true, value };
}

function optionalTaskIds(value: unknown, name: string): ValidationResult<string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return { ok: false, message: `${name} must be an array` };
  const taskIds: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || nonEmptyString(item) === undefined) {
      return { ok: false, message: `${name}[${index}] must be a non-empty string` };
    }
    const taskId = item.trim();
    if (!seen.has(taskId)) {
      seen.add(taskId);
      taskIds.push(taskId);
    }
  }
  return { ok: true, value: taskIds };
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

async function runTaskBatch(
  tasks: readonly TaskToolInput[],
  maxConcurrency: number,
  spawn: (task: TaskToolInput) => Promise<SubagentTaskHandle>,
): Promise<TaskBatchSpawnResult> {
  const results: Array<SubagentTaskHandle | undefined> = new Array(tasks.length);
  const failures: TaskBatchSpawnFailure[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(maxConcurrency, tasks.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      const task = tasks[index];
      if (!task) throw new Error(`Missing task at index ${index}`);
      try {
        results[index] = await spawn(task);
      } catch (error) {
        failures.push({
          batchIndex: index,
          description: task.description,
          error: preview(errorMessage(error)),
        });
      }
    }
  }));

  return {
    tasks: results.filter((task): task is SubagentTaskHandle => task !== undefined),
    failures: failures.sort((left, right) => left.batchIndex - right.batchIndex),
  };
}

function isFinalTaskStatus(status: SubagentTaskStatus): boolean {
  return status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled";
}

function batchNextAction(
  completionPolicy: TaskCompletionPolicy,
  state: {
    finalCount: number;
    joinAvailable?: boolean;
    spawnFailureCount: number;
    taskCount: number;
    timedOut: boolean;
  },
): string {
  if (completionPolicy === "supervised" && state.taskCount > 0) {
    return state.finalCount < state.taskCount
      ? "This supervised batch remains required by the current parent turn. Call task_wait_batch(wait_for=any) on remaining task IDs, review each terminal result and use task_followup when needed, then confirm task_wait_batch(wait_for=all) before one integrated answer."
      : "These supervised handles are already terminal, but the parent must still confirm the complete batch with task_wait_batch(wait_for=all), then verify every result and provide one integrated answer.";
  }
  if (completionPolicy === "join" && state.joinAvailable === false) {
    if (state.spawnFailureCount > 0) {
      return "Join is unavailable in this runtime; report every spawn failure and call task_wait_batch with successful task IDs before results are needed.";
    }
    return "Join is unavailable in this runtime; preserve the task IDs and call task_wait_batch before results are needed.";
  }
  if (state.spawnFailureCount > 0 && (state.timedOut || state.finalCount < state.taskCount)) {
    return "Report every spawn failure, preserve successful task IDs, and call task_wait_batch before responding whenever pending results are required.";
  }
  if (state.timedOut || state.finalCount < state.taskCount) {
    return "Preserve the task IDs and call task_wait_batch before responding whenever pending results are required.";
  }
  if (state.spawnFailureCount > 0) {
    return "Integrate results from spawned tasks and explicitly report every spawn failure; failed spawn attempts have no task handle.";
  }
  if (completionPolicy === "join") {
    return "Read every terminal summary, follow up or verify gaps, and answer the original request with one substantive integration; explicitly report failed, incomplete, or cancelled tasks.";
  }
  if (completionPolicy === "notify") {
    return "This is only an interim handle set. The parent will be woken when the batch is terminal; then read every result and finish the original request instead of only announcing completion.";
  }
  if (completionPolicy === "supervised") return "Report every spawn failure and integrate the available evidence; no supervised task handle was created to wait on.";
  return "This batch is intentionally detached and will not wake the parent; do not promise its results in the current response.";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isBackgroundTaskInput(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const mode = pickOptionalString(input, ["mode", "subagent_type", "subagentType", "agentType", "type"]);
  if (!mode.ok) return false;
  return normalizeTaskMode(mode.value) === "background";
}

function normalizeTaskMode(value: string | undefined): string | undefined {
  return nonEmptyString(value)?.toLowerCase();
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
