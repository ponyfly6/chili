import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { PolicyApprovalBroker } from "./approval.js";
import { DeferredApprovalQueue } from "./deferred-approval.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ApprovalBroker, ChiliToolDefinition, ExecuteToolInput } from "./types.js";

test("policy allow preflight runs without creating approval events", async () => {
  const events: ChiliEvent[] = [];
  let asked = 0;
  const executor = createExecutor({
    events,
    tool: fakeTool({ permission: "read", patterns: ["README.md"] }),
    broker: new PolicyApprovalBroker({
      rulesets: [[{ permission: "read(*)", pattern: "*", action: "allow" }]],
      ask: async () => {
        asked += 1;
        return { action: "allow_once" };
      },
    }),
  });

  const result = await executor.execute(toolInput("fake"));

  expect(result.status).toBe("completed");
  expect(asked).toBe(0);
  expect(events.map((event) => event.type)).not.toContain("approval.requested");
  expect(events.map((event) => event.type)).not.toContain("approval.resolved");
  expect(events.some((event) => event.type === "tool.call_updated" && event.payload.status === "waiting_for_approval")).toBe(false);
});

test("empty approval patterns fail before creating approval events", async () => {
  const events: ChiliEvent[] = [];
  let asked = 0;
  const executor = createExecutor({
    events,
    tool: fakeTool({ permission: "bash", patterns: [] }),
    broker: new PolicyApprovalBroker({
      rulesets: [[{ permission: "*", pattern: "*", action: "allow" }]],
      ask: async () => {
        asked += 1;
        return { action: "allow_once" };
      },
    }),
  });

  const result = await executor.execute(toolInput("fake"));

  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("at least one pattern");
  expect(asked).toBe(0);
  expect(events.map((event) => event.type)).not.toContain("approval.requested");
  expect(events.map((event) => event.type)).not.toContain("approval.resolved");
});

test("blank approval pattern entries fail before creating approval events", async () => {
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    events,
    tool: fakeTool({ permission: "bash", patterns: [" "] }),
    broker: new PolicyApprovalBroker({
      rulesets: [[{ permission: "*", pattern: "*", action: "allow" }]],
      ask: async () => ({ action: "allow_once" }),
    }),
  });

  const result = await executor.execute(toolInput("fake"));

  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("non-empty string");
  expect(events.map((event) => event.type)).not.toContain("approval.requested");
  expect(events.map((event) => event.type)).not.toContain("approval.resolved");
});

test("unknown approval decision actions fail closed", async () => {
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    events,
    tool: fakeTool({ permission: "bash", patterns: ["npm test"] }),
    broker: {
      preflight: async () => ({
        action: "ask",
        source: "test",
        reason: "test ask",
        metadata: {},
      }),
      decide: async () => ({ action: "surprise" } as never),
    },
  });

  const result = await executor.execute(toolInput("fake"));

  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("Invalid approval decision action");
  const resolved = events.find((event): event is Extract<ChiliEvent, { type: "approval.resolved" }> => event.type === "approval.resolved");
  expect(resolved?.payload.decision).toBe("deny");
  expect(resolved?.payload.feedback).toContain("Invalid approval decision action");
});

test("allow_always preflights later matching requests in the same session", async () => {
  const events: ChiliEvent[] = [];
  let asked = 0;
  const executor = createExecutor({
    events,
    tool: fakeTool({ permission: "bash", patterns: ["npm test"] }),
    broker: new PolicyApprovalBroker({
      ask: async () => {
        asked += 1;
        return { action: "allow_always" };
      },
    }),
  });

  const first = await executor.execute(toolInput("fake", "toolcall_first" as ToolCallId));
  const second = await executor.execute(toolInput("fake", "toolcall_second" as ToolCallId));

  expect(first.status).toBe("completed");
  expect(second.status).toBe("completed");
  expect(asked).toBe(1);
  expect(events.filter((event) => event.type === "approval.requested")).toHaveLength(1);
  expect(events.some((event) =>
    event.type === "tool.call_updated"
    && event.payload.callId === "toolcall_second"
    && event.payload.status === "waiting_for_approval"
  )).toBe(false);
});

test("policy ask preflight creates an approval request", async () => {
  const events: ChiliEvent[] = [];
  let asked = 0;
  const executor = createExecutor({
    events,
    tool: fakeTool({ permission: "bash", patterns: ["npm test"] }),
    broker: new PolicyApprovalBroker({
      rulesets: [[{ permission: "bash(*)", pattern: "*", action: "ask" }]],
      ask: async () => {
        asked += 1;
        return { action: "allow_once" };
      },
    }),
  });

  const result = await executor.execute(toolInput("fake"));

  expect(result.status).toBe("completed");
  expect(asked).toBe(1);
  expect(events.some((event) => event.type === "tool.call_updated" && event.payload.status === "waiting_for_approval")).toBe(true);
  expect(events.map((event) => event.type)).toContain("approval.requested");
  expect(events.map((event) => event.type)).toContain("approval.resolved");
  const requested = events.find((event): event is Extract<ChiliEvent, { type: "approval.requested" }> => event.type === "approval.requested");
  expect(requested?.payload.metadata).toMatchObject({
    source: "policy_rule",
    reason: "Matched ask rule for bash:npm test.",
    preflightDecision: { action: "ask", source: "policy_rule" },
    patternDecisions: [{ action: "ask", source: "policy_rule" }],
  });
});

test("policy deny preflight fails without creating approval events", async () => {
  const events: ChiliEvent[] = [];
  let asked = 0;
  const executor = createExecutor({
    events,
    tool: fakeTool({ permission: "read", patterns: ["~/.ssh/id_rsa"] }),
    broker: new PolicyApprovalBroker({
      rulesets: [[{ permission: "read(~/.ssh/**)", pattern: "*", action: "deny" }]],
      ask: async () => {
        asked += 1;
        return { action: "allow_once" };
      },
    }),
  });

  const result = await executor.execute(toolInput("fake"));

  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("Denied by policy");
  expect(asked).toBe(0);
  expect(events.map((event) => event.type)).not.toContain("approval.requested");
  expect(events.map((event) => event.type)).not.toContain("approval.resolved");
  expect(events.some((event) => event.type === "tool.call_updated" && event.payload.status === "waiting_for_approval")).toBe(false);
});

test("allow_session rechecks and resolves matching pending approvals", async () => {
  const events: ChiliEvent[] = [];
  const queue = new DeferredApprovalQueue();
  let broker: PolicyApprovalBroker;
  broker = new PolicyApprovalBroker({
    ask: (request) => queue.ask(request),
    onSessionGrant: async () => {
      await queue.recheckPending((request) => broker.preflight(request));
    },
  });
  const executor = createExecutor({
    events,
    tool: fakeTool({ permission: "edit", patterns: ["src/a.ts"] }),
    broker,
  });

  const first = executor.execute(toolInput("fake", "toolcall_pending_one" as ToolCallId));
  const second = executor.execute(toolInput("fake", "toolcall_pending_two" as ToolCallId));

  await waitForPending(queue, 2);
  const pending = queue.list();
  expect(pending).toHaveLength(2);
  expect(queue.resolve({ approvalId: pending[0]!.approvalId, decision: "allow_session" })).toBe(true);

  const results = await Promise.all([first, second]);
  expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
  expect(queue.list()).toHaveLength(0);

  const resolved = events.filter((event): event is Extract<ChiliEvent, { type: "approval.resolved" }> => event.type === "approval.resolved");
  expect(resolved.map((event) => event.payload.decision).sort()).toEqual(["allow_once", "allow_session"]);
});

function fakeTool(spec: { permission: string; patterns: string[] }): ChiliToolDefinition {
  return {
    name: "fake",
    description: "Fake approval test tool.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => ({
      permission: spec.permission,
      patterns: spec.patterns,
    }),
    execute: async () => ({ title: "fake", output: "ok" }),
  };
}

function createExecutor(input: {
  events: ChiliEvent[];
  tool: ChiliToolDefinition;
  broker: ApprovalBroker;
}): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  registry.register(input.tool);
  return new ToolExecutor({
    registry,
    events: { publish: async (event: ChiliEvent) => { input.events.push(event); } },
    approvals: input.broker,
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
}

function toolInput(
  toolName: string,
  callId: ToolCallId = "toolcall_executor_approval" as ToolCallId,
  sessionId: SessionId = "session_executor_approval" as SessionId,
): ExecuteToolInput {
  return {
    sessionId,
    turnId: "turn_executor_approval" as TurnId,
    callId,
    toolName,
    input: {},
    cwd: process.cwd(),
  };
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

async function waitForPending(queue: DeferredApprovalQueue, count: number): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (queue.list().length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} pending approvals`);
}
