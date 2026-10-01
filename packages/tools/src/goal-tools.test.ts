import { expect, test } from "bun:test";
import type { ChiliEvent, SessionGoal, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import {
  createCreateGoalTool,
  createGetGoalTool,
  createUpdateGoalTool,
  type GoalCreateToolInput,
  type GoalToolController,
  type GoalUpdateToolInput,
} from "./builtins/goal.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ChiliToolExecutionContext, ExecuteToolInput } from "./types.js";

test("goal tools own one persistent goal per session", async () => {
  const controller = new FakeGoalController();
  const getGoal = createGetGoalTool(controller);
  const createGoal = createCreateGoalTool(controller);
  const updateGoal = createUpdateGoalTool(controller);
  const executor = createExecutor([getGoal, createGoal, updateGoal]);

  expect(getGoal.description).toContain("session");
  expect(createGoal.description).toContain("session");

  const created = await executor.execute(toolInput("create_goal", {
    objective: "Finish the migration",
    token_budget: 1_000,
  }));
  expect(created.status).toBe("completed");
  if (created.status === "completed") {
    expect(JSON.parse(created.result.output)).toMatchObject({
      goal: {
        sessionId: "session_goal_tools",
        objective: "Finish the migration",
        status: "active",
        tokenBudget: 1_000,
      },
    });
  }

  const read = await executor.execute(toolInput("get_goal", {}));
  expect(read.status).toBe("completed");
  if (read.status === "completed") {
    expect(JSON.parse(read.result.output).goal.sessionId).toBe("session_goal_tools");
  }

  const completed = await executor.execute(toolInput("update_goal", { status: "complete", summary: "verified" }));
  expect(completed.status).toBe("completed");
  if (completed.status === "completed") {
    expect(JSON.parse(completed.result.output)).toMatchObject({
      goal: { sessionId: "session_goal_tools", status: "complete" },
      summary: "verified",
    });
  }

  expect(controller.sessionIds).toEqual([
    "session_goal_tools",
    "session_goal_tools",
    "session_goal_tools",
  ]);
});

class FakeGoalController implements GoalToolController {
  readonly sessionIds: string[] = [];
  private goal: SessionGoal | undefined;

  async getGoal(context: ChiliToolExecutionContext): Promise<SessionGoal | undefined> {
    this.sessionIds.push(context.sessionId);
    return this.goal;
  }

  async createGoal(input: GoalCreateToolInput, context: ChiliToolExecutionContext): Promise<SessionGoal> {
    this.sessionIds.push(context.sessionId);
    this.goal = {
      sessionId: context.sessionId,
      objective: input.objective,
      status: "active",
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1 as TimestampMs,
      updatedAt: 1 as TimestampMs,
    };
    return this.goal;
  }

  async updateGoal(input: GoalUpdateToolInput, context: ChiliToolExecutionContext): Promise<SessionGoal> {
    this.sessionIds.push(context.sessionId);
    if (!this.goal) throw new Error("No goal");
    this.goal = {
      ...this.goal,
      status: input.status,
      updatedAt: 2 as TimestampMs,
      completedAt: 2 as TimestampMs,
    };
    return this.goal;
  }
}

function createExecutor(tools: Parameters<InMemoryToolRegistry["register"]>[0][]): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  for (const tool of tools) registry.register(tool);
  return new ToolExecutor({
    registry,
    events: { publish: async (_event: ChiliEvent) => undefined },
    approvals: { decide: async () => ({ action: "deny" }) },
    createId: (prefix) => `${prefix}_goal_test`,
    now: () => 1 as TimestampMs,
  });
}

function toolInput(toolName: string, input: unknown): ExecuteToolInput {
  return {
    sessionId: "session_goal_tools" as SessionId,
    turnId: "turn_goal_tools" as TurnId,
    toolName,
    input,
    cwd: process.cwd(),
  };
}
