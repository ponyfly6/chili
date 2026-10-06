import type { AgentMessageListToolInput, AgentMessageSendToolInput, AgentMessageToolController } from "../agent-message.js";
import type {
  SubagentController,
  SubagentControlController,
  TaskBatchToolInput,
  TaskCloseToolInput,
  TaskFollowupToolInput,
  TaskListToolInput,
  TaskToolInput,
  TaskWaitBatchToolInput,
} from "../subagent.js";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import { createAgentMessageListTool, createAgentMessageSendTool } from "./agent-message.js";
import {
  createTaskBatchTool,
  createTaskCloseTool,
  createTaskFollowupTool,
  createTaskListTool,
  createTaskTool,
  createTaskWaitBatchTool,
  type SubagentToolResult,
} from "./task.js";

export type AgentSpawnToolInput = TaskToolInput | TaskBatchToolInput;
export type AgentListToolInput =
  | (TaskListToolInput & { view: "agents" })
  | (AgentMessageListToolInput & { view: "messages" });
export type AgentStopToolInput = Pick<TaskCloseToolInput, "taskId" | "summary">;

const taskStatusSchema = { type: "string", enum: ["pending", "running", "completed", "incomplete", "failed", "cancelled"] };
const messageStatusSchema = { type: "string", enum: ["queued", "delivering", "consumed", "discarded"] };
const taskIdSchema = { type: "string", minLength: 1 };
const taskIdsSchema = { type: "array", minItems: 1, maxItems: 64, items: taskIdSchema };
const timeoutSchema = { type: "integer", minimum: 1 };
const taskRecordSchema = {
  type: "object",
  required: ["task_id", "status"],
  properties: {
    task_id: taskIdSchema,
    taskId: taskIdSchema,
    status: taskStatusSchema,
    summary: { type: "string" },
    path: { type: "string" },
    mode: { type: "string" },
  },
};
const taskSetSchema = {
  type: "object",
  required: ["tasks", "count"],
  properties: {
    tasks: { type: "array", items: taskRecordSchema },
    count: { type: "integer" },
    batchId: taskIdSchema,
    satisfied: { type: "boolean" },
    timedOut: { type: "boolean" },
    pending_task_ids: { type: "array", items: taskIdSchema },
    next_action: { type: "string" },
  },
};
const messageRecordSchema = {
  type: "object",
  required: ["message_id", "from_path", "to_path", "delivery", "status"],
  properties: {
    message_id: { type: "string" },
    messageId: { type: "string" },
    from_path: { type: "string" },
    to_path: { type: "string" },
    delivery: { type: "string", enum: ["queueOnly", "triggerTurn"] },
    status: messageStatusSchema,
    content: { type: "string" },
    task_id: taskIdSchema,
  },
};

/** Canonical model-facing tools share the existing lifecycle and message controllers. */
export function createAgentSpawnTool(
  controller: SubagentController,
  lifecycle?: SubagentControlController,
): ChiliToolDefinition<AgentSpawnToolInput, SubagentToolResult> {
  const single = createTaskTool(controller);
  const batch = createTaskBatchTool(controller, lifecycle);
  return {
    name: "agent_spawn",
    description:
      "Create one agent with description/prompt, or parallel agents with tasks. Single mode defaults to one_shot (inline); use resumable (inline with history) or background (immediate handle) for later agent_resume. Batch tasks run in background and default to completionPolicy=join, waiting inline. supervised returns handles for an agent_wait/agent_resume review loop; notify wakes the parent on completion; detached never wakes. Read and integrate required results before finishing the original request.",
    resourcePolicy: "internal",
    risk: "execute",
    codeMode: true,
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["one_shot", "resumable", "background"] },
        tasks: {
          type: "array", minItems: 1, maxItems: 64,
          items: {
            type: "object", required: ["description", "prompt"],
            properties: {
              description: { type: "string", minLength: 1 },
              prompt: { type: "string", minLength: 1 },
              mode: { type: "string", enum: ["background"] },
            },
          },
        },
        completionPolicy: { type: "string", enum: ["join", "notify", "detached", "supervised"], description: "supervised is only supported with tasks." },
        maxConcurrency: { type: "integer", minimum: 1, maximum: 32, description: "Batch only. Defaults to 3; runtime limits also apply." },
        timeoutMs: { ...timeoutSchema, description: "Batch join timeout. Returns partial results on timeout." },
        batchId: { ...taskIdSchema, description: "Batch only. Optional stable batch identifier." },
      },
      oneOf: [
        { required: ["description", "prompt"], not: { anyOf: ["tasks", "maxConcurrency", "timeoutMs", "batchId"].map((key) => ({ required: [key] })) } },
        { required: ["tasks"], not: { anyOf: ["description", "prompt", "mode"].map((key) => ({ required: [key] })) } },
      ],
    },
    outputSchema: { anyOf: [taskRecordSchema, taskSetSchema] },
    async validate(input): Promise<ValidationResult<AgentSpawnToolInput>> {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      if (input.tasks !== undefined) {
        if (hasAny(input, ["description", "prompt", "mode", "title", "name", "summary", "task", "instructions", "instruction", "message", "subagent_type", "subagentType", "agentType", "type"])) {
          return { ok: false, message: "Use either tasks or a single description/prompt/mode, not both" };
        }
        return batch.validate!(input);
      }
      if (hasAny(input, ["maxConcurrency", "max_concurrency", "timeoutMs", "timeout_ms", "batchId", "batch_id"])) {
        return { ok: false, message: "maxConcurrency, timeoutMs, and batchId require tasks" };
      }
      const validated = await single.validate!(input);
      if (!validated.ok) return renameValidation(validated);
      if (validated.value.mode !== undefined && !["one_shot", "resumable", "background"].includes(validated.value.mode)) {
        return { ok: false, message: "mode must be one_shot, resumable, or background" };
      }
      return validated;
    },
    isConcurrencySafe(input) {
      return "tasks" in input || input.mode === "background";
    },
    approval(input) {
      return "tasks" in input ? batch.approval!(input) : single.approval!(input);
    },
    async execute(input, context) {
      const result = "tasks" in input ? await batch.execute(input, context) : await single.execute(input, context);
      return agentResult("agent_spawn", result);
    },
  };
}

export function createAgentListTool(
  lifecycle: SubagentControlController,
  messages: AgentMessageToolController,
): ChiliToolDefinition<AgentListToolInput, SubagentToolResult> {
  const agents = createTaskListTool(lifecycle);
  const mailbox = createAgentMessageListTool(messages);
  return {
    name: "agent_list",
    description: "Inspect agents and their results (default view=agents), or durable messages in FIFO order (view=messages). The host enforces agent ownership and message visibility even with all=true. Use taskIds for agent filters, and taskId/path/from for message filters.",
    resourcePolicy: "internal",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    codeMode: true,
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["agents", "messages"], default: "agents" },
        status: { type: "string", enum: [...taskStatusSchema.enum, ...messageStatusSchema.enum] },
        taskId: { ...taskIdSchema, description: "Messages view only." },
        taskIds: { ...taskIdsSchema, description: "Agents view only." },
        path: { type: "string", description: "Messages view only. Canonical recipient agent path." },
        from: { type: "string", description: "Messages view only. Canonical sender agent path." },
        limit: { type: "integer", minimum: 1 },
        all: { type: "boolean" },
      },
    },
    outputSchema: { anyOf: [taskSetSchema, { type: "object", required: ["count", "messages"], properties: { count: { type: "integer" }, messages: { type: "array", items: messageRecordSchema } } }] },
    async validate(input): Promise<ValidationResult<AgentListToolInput>> {
      const record = input ?? {};
      if (!isRecord(record)) return { ok: false, message: "expected an object" };
      const view = record.view ?? "agents";
      if (view !== "agents" && view !== "messages") return { ok: false, message: "view must be agents or messages" };
      if (view === "agents") {
        if (hasAny(record, ["taskId", "task_id", "path", "from"])) return { ok: false, message: "taskId, path, and from require view=messages; use taskIds to filter agents" };
        const validated = await agents.validate!(record);
        return validated.ok ? { ok: true, value: { ...validated.value, view } } : validated;
      }
      if (hasAny(record, ["taskIds", "task_ids"])) return { ok: false, message: "taskIds requires view=agents; use taskId to filter messages" };
      const validated = await mailbox.validate!(record);
      return validated.ok ? { ok: true, value: { ...validated.value, view } } : validated;
    },
    approval: () => false,
    async execute(input, context) {
      if (input.view === "messages") {
        const { view: _view, ...filters } = input;
        return agentResult("agent_list", await mailbox.execute(filters, context));
      }
      const { view: _view, ...filters } = input;
      return agentResult("agent_list", await agents.execute(filters, context));
    },
  };
}

export function createAgentSendTool(
  controller: AgentMessageToolController,
): ChiliToolDefinition<AgentMessageSendToolInput, SubagentToolResult> {
  return canonicalTool(
    createAgentMessageSendTool(controller),
    "agent_send",
    "Send a durable message to an agent by task id, canonical path, task name, or 'parent', without interrupting its work. delivery=queueOnly (default) stores it for recipient inspection without starting a turn; triggerTurn wakes a live idle recipient. Neither restarts a stopped or completed agent: use agent_resume for that. Use agent_list(view=messages) to inspect delivery.",
    messageRecordSchema,
  );
}

export function createAgentWaitTool(
  controller: SubagentControlController,
): ChiliToolDefinition<TaskWaitBatchToolInput, SubagentToolResult> {
  const base = createTaskWaitBatchTool(controller);
  return {
    ...canonicalTool(base, "agent_wait", "Wait for one taskId or multiple taskIds. waitFor=all (default) waits for all terminal results; any returns after one finishes. Timeout returns the latest partial snapshot, including every requested handle. Read terminal summaries, resume work if needed, and integrate required results before finishing.", taskSetSchema),
    inputSchema: {
      type: "object",
      properties: {
        taskId: taskIdSchema,
        taskIds: taskIdsSchema,
        waitFor: { type: "string", enum: ["any", "all"], default: "all" },
        timeoutMs: timeoutSchema,
        batchId: taskIdSchema,
      },
      oneOf: [{ required: ["taskId"], not: { required: ["taskIds"] } }, { required: ["taskIds"], not: { required: ["taskId"] } }],
    },
    async validate(input) {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      const hasSingle = hasAny(input, ["taskId", "task_id", "id"]);
      const hasMultiple = hasAny(input, ["taskIds", "task_ids", "ids"]);
      if (hasSingle === hasMultiple) return { ok: false, message: "Provide either taskId or taskIds, not both" };
      return base.validate!(hasSingle ? { ...input, taskIds: [input.taskId ?? input.task_id ?? input.id] } : input);
    },
  };
}

export function createAgentStopTool(
  controller: SubagentControlController,
): ChiliToolDefinition<AgentStopToolInput, SubagentToolResult> {
  const base = createTaskCloseTool(controller);
  return {
    ...canonicalTool<AgentStopToolInput>(base, "agent_stop", "Interrupt an agent's active work and mark it cancelled, preserving its session history. Already terminal agents retain their existing status. Stopping does not delete the agent. Use agent_resume to continue a resumable or background agent later.", taskRecordSchema),
    inputSchema: { type: "object", required: ["taskId"], properties: { taskId: taskIdSchema, summary: { type: "string" } } },
    async validate(input) {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      if (hasAny(input, ["status", "state", "outcome", "interrupt", "error"])) return { ok: false, message: "agent_stop always cancels and interrupts; provide only taskId and optional summary" };
      const validated = await base.validate!(input);
      if (!validated.ok) return validated;
      const { taskId, summary } = validated.value;
      return { ok: true, value: { taskId, ...(summary !== undefined ? { summary } : {}) } };
    },
    async execute(input, context) {
      return agentResult("agent_stop", await base.execute({ taskId: input.taskId, ...(input.summary !== undefined ? { summary: input.summary } : {}), status: "cancelled", interrupt: true }, context));
    },
  };
}

export function createAgentResumeTool(
  controller: SubagentControlController,
): ChiliToolDefinition<TaskFollowupToolInput, SubagentToolResult> {
  const base = createTaskFollowupTool(controller);
  return {
    ...canonicalTool(base, "agent_resume", "Continue a stopped or terminal resumable/background agent using its existing history. Optionally supply a new prompt and maxTurns. Omitted prompt continues the previous task. If stop cleanup is still running, retry after it finishes. For an agent already running, use agent_send without interrupting it.", taskRecordSchema),
    inputSchema: { type: "object", required: ["taskId"], properties: { taskId: taskIdSchema, prompt: { type: "string", minLength: 1 }, maxTurns: { type: "integer", minimum: 1 } } },
    async validate(input) {
      if (!isRecord(input)) return { ok: false, message: "expected an object" };
      return base.validate!(hasAny(input, ["prompt", "text", "message", "instructions"]) ? input : { ...input, prompt: "Continue the previous task from where you stopped." });
    },
  };
}

function canonicalTool<Input>(
  base: ChiliToolDefinition<Input, SubagentToolResult>,
  name: string,
  description: string,
  outputSchema: unknown,
): ChiliToolDefinition<Input, SubagentToolResult> {
  const { aliases: _aliases, ...definition } = base;
  return {
    ...definition,
    name,
    description,
    codeMode: true,
    outputSchema,
    async execute(input, context) {
      return agentResult(name, await base.execute(input, context));
    },
  };
}

function agentResult(name: string, result: SubagentToolResult): SubagentToolResult {
  const structuredData = JSON.parse(result.output) as Record<string, unknown>;
  // Only generated guidance is renamed; user summaries and message content are untouched.
  if (typeof structuredData.next_action === "string") structuredData.next_action = agentGuidance(structuredData.next_action);
  const metadata = { ...result.metadata };
  if (typeof metadata.nextAction === "string") metadata.nextAction = agentGuidance(metadata.nextAction);
  return { ...result, title: result.title?.replace(/^\S+/, name), output: JSON.stringify(structuredData), structuredData, metadata };
}

function agentGuidance(text: string): string {
  return text.replace(/\btask_wait_batch\b|\btask_wait\b/g, "agent_wait").replace(/\btask_followup\b/g, "agent_resume").replace(/\bwait_for=/g, "waitFor=");
}

function renameValidation<T>(result: ValidationResult<T>): ValidationResult<T> {
  return result.ok ? result : { ...result, message: result.message.replace(/\btask_batch\b/g, "agent_spawn with tasks") };
}

function hasAny(input: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => input[key] !== undefined);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
