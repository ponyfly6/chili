import type { ToolResult } from "@chili/protocol";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import type {
  CompleteTaskStatus,
  CompleteTaskToolInput,
  SubagentController,
  SubagentTaskCompletion,
  SubagentTaskHandle,
  TaskToolInput,
} from "../subagent.js";

export interface SubagentToolMetadata extends Record<string, unknown> {
  task_id: string;
  taskId: string;
  summary: string;
  status: string;
  mode?: string;
}

export interface SubagentToolResult extends ToolResult {
  metadata: SubagentToolMetadata;
}

export function createTaskTool(controller: SubagentController): ChiliToolDefinition<TaskToolInput, SubagentToolResult> {
  return {
    name: "task",
    aliases: ["agent"],
    description: "Spawn a local subagent task through the injected subagent controller.",
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
