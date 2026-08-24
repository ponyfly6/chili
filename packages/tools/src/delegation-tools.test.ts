import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  DelegationPolicy,
  RuntimeDelegationConfig,
  SessionId,
  ThreadId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import {
  createDelegationSetTool,
  createDelegationStatusTool,
  type DelegationSetToolInput,
  type DelegationToolController,
} from "./builtins/delegation.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ChiliToolExecutionContext, ExecuteToolInput } from "./types.js";

test("delegation tools expose deterministic status and persist a session policy", async () => {
  const controller = new FakeDelegationController();
  const executor = createExecutor(controller);

  const status = await executor.execute(toolInput("delegation_status", {}));
  expect(status.status).toBe("completed");
  if (status.status === "completed") {
    expect(JSON.parse(status.result.output)).toEqual({
      sessionId: "session_delegation_tools",
      policy: "explicit",
      source: "default",
    });
  }

  const updated = await executor.execute(toolInput("delegation_set", { policy: "proactive" }));
  expect(updated.status).toBe("completed");
  expect(controller.setInputs).toEqual([{ policy: "proactive" }]);
  if (updated.status === "completed") {
    expect(updated.result.metadata).toMatchObject({ policy: "proactive", source: "session" });
  }
});

test("delegation_set validates policy and documents one-turn versus ongoing intent", async () => {
  const controller = new FakeDelegationController();
  const statusTool = createDelegationStatusTool(controller);
  const setTool = createDelegationSetTool(controller);

  expect(statusTool.alwaysLoad).toBe(true);
  expect(setTool.alwaysLoad).toBe(true);
  expect(setTool.description).toContain("开启代理");
  expect(setTool.description).toContain("以后主动委派");
  expect(setTool.description).toContain("本次开多个 sub");
  expect(setTool.description).toContain("leave policy unchanged");

  const invalid = await createExecutor(controller).execute(toolInput("delegation_set", { policy: "sometimes" }));
  expect(invalid.status).toBe("failed");
  if (invalid.status === "failed") {
    expect(invalid.error.message).toContain("policy must be off, explicit, or proactive");
  }
  expect(controller.setInputs).toEqual([]);
});

class FakeDelegationController implements DelegationToolController {
  policy: DelegationPolicy = "explicit";
  source: RuntimeDelegationConfig["source"] = "default";
  readonly setInputs: DelegationSetToolInput[] = [];

  async getDelegationConfig(context: ChiliToolExecutionContext): Promise<RuntimeDelegationConfig> {
    return { sessionId: context.sessionId, policy: this.policy, source: this.source };
  }

  async setDelegationPolicy(
    input: DelegationSetToolInput,
    context: ChiliToolExecutionContext,
  ): Promise<RuntimeDelegationConfig> {
    this.setInputs.push(input);
    this.policy = input.policy;
    this.source = "session";
    return this.getDelegationConfig(context);
  }
}

function createExecutor(controller: DelegationToolController): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  registry.register(createDelegationStatusTool(controller));
  registry.register(createDelegationSetTool(controller));
  return new ToolExecutor({
    registry,
    events: { publish: async (_event: ChiliEvent) => undefined },
    approvals: { decide: async () => ({ action: "deny" }) },
    createId: (prefix) => `${prefix}_delegation_test`,
    now: () => 1 as TimestampMs,
  });
}

function toolInput(toolName: string, input: unknown): ExecuteToolInput {
  return {
    sessionId: "session_delegation_tools" as SessionId,
    threadId: "thread_delegation_tools" as ThreadId,
    turnId: "turn_delegation_tools" as TurnId,
    toolName,
    input,
    cwd: process.cwd(),
  };
}
