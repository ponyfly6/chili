import type { ThreadGoal, ThreadGoalStatus, ToolResult } from "@chili/protocol";
import type { ChiliToolDefinition, ChiliToolExecutionContext, ValidationResult } from "../types.js";

export interface GoalToolController {
  getGoal(context: ChiliToolExecutionContext): Promise<ThreadGoal | undefined>;
  createGoal(input: GoalCreateToolInput, context: ChiliToolExecutionContext): Promise<ThreadGoal>;
  updateGoal(input: GoalUpdateToolInput, context: ChiliToolExecutionContext): Promise<ThreadGoal>;
}

export interface GoalCreateToolInput {
  objective: string;
  tokenBudget?: number;
}

export interface GoalUpdateToolInput {
  status: Extract<ThreadGoalStatus, "complete">;
  summary?: string;
}

export function createGoalTools(controller: GoalToolController): ChiliToolDefinition[] {
  return [
    createGetGoalTool(controller),
    createCreateGoalTool(controller),
    createUpdateGoalTool(controller),
  ];
}

export function createGetGoalTool(controller: GoalToolController): ChiliToolDefinition<Record<string, never>, ToolResult> {
  return {
    name: "get_goal",
    description: "Read the persistent goal for this thread, including status, budget, and usage.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      properties: {},
    },
    approval: () => false,
    async execute(_input, context) {
      const goal = await controller.getGoal(context);
      return goalToolResult("get_goal", goal ? { goal } : { goal: null });
    },
  };
}

export function createCreateGoalTool(controller: GoalToolController): ChiliToolDefinition<GoalCreateToolInput, ToolResult> {
  return {
    name: "create_goal",
    description:
      "Create a persistent goal only when the user explicitly asks for one. Fails if a goal already exists for the thread.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["objective"],
      properties: {
        objective: { type: "string" },
        tokenBudget: { type: "number" },
        token_budget: { type: "number" },
      },
    },
    validate(input): ValidationResult<GoalCreateToolInput> {
      return validateGoalCreateInput(input);
    },
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { objectivePreview: preview(input.objective), tokenBudget: input.tokenBudget } });
      const goal = await controller.createGoal(input, context);
      return goalToolResult("create_goal", { goal });
    },
  };
}

export function createUpdateGoalTool(controller: GoalToolController): ChiliToolDefinition<GoalUpdateToolInput, ToolResult> {
  return {
    name: "update_goal",
    description:
      "Update the persistent goal. The model may only mark it complete after verifying the objective is actually satisfied.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["complete"] },
        summary: { type: "string" },
      },
    },
    validate(input): ValidationResult<GoalUpdateToolInput> {
      return validateGoalUpdateInput(input);
    },
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { status: input.status, summary: input.summary } });
      const goal = await controller.updateGoal(input, context);
      return goalToolResult("update_goal", { goal, summary: input.summary ?? null });
    },
  };
}

function validateGoalCreateInput(input: unknown): ValidationResult<GoalCreateToolInput> {
  const record = recordValue(input);
  if (!record) return { ok: false, message: "input must be an object" };
  const objective = stringValue(record.objective)?.trim();
  if (!objective) return { ok: false, message: "objective is required" };
  const tokenBudget = numberValue(record.tokenBudget ?? record.token_budget);
  if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
    return { ok: false, message: "tokenBudget must be a positive integer when provided" };
  }
  return { ok: true, value: { objective, ...(tokenBudget !== undefined ? { tokenBudget } : {}) } };
}

function validateGoalUpdateInput(input: unknown): ValidationResult<GoalUpdateToolInput> {
  const record = recordValue(input);
  if (!record) return { ok: false, message: "input must be an object" };
  if (record.status !== "complete") return { ok: false, message: "status must be complete" };
  const summary = stringValue(record.summary)?.trim();
  return { ok: true, value: { status: "complete", ...(summary ? { summary } : {}) } };
}

function goalToolResult(title: string, value: unknown): ToolResult {
  return {
    title,
    output: JSON.stringify(value, null, 2),
    metadata: recordValue(value) ?? {},
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function preview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 119)}...`;
}
