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

test("fails closed on oversized approval permissions and patterns without malformed events", async () => {
  const huge = "\u0000".repeat(4 * 1024 * 1024);
  const cases = [
    { permission: huge, patterns: ["safe"] },
    { permission: "safe.permission", patterns: [huge] },
    { permission: "safe.permission", patterns: Array.from({ length: 65 }, (_, index) => `pattern-${index}`) },
  ];
  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  for (const [index, spec] of cases.entries()) {
    const events: ChiliEvent[] = [];
    const executor = createExecutor({
      events,
      tool: fakeTool(spec),
      broker: { decide: async () => ({ action: "allow_once" }) },
    });
    const result = await executor.execute(toolInput("fake", `toolcall_invalid_spec_${index}` as ToolCallId));
    expect(result.status).toBe("failed");
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
    for (const event of events) {
      expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(520_000);
      expect(() => parseDesktopEvent({ type: "runtime.event", event })).not.toThrow();
    }
  }
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

test("executor rejects a broker decision above the tool approval scope", async () => {
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    events,
    tool: fakeTool({ permission: "bash.unsandboxed", patterns: ["open README.md"], maxApprovalScope: "once" }),
    broker: {
      preflight: async () => ({ action: "ask", source: "test", reason: "test ask", metadata: {} }),
      decide: async () => ({ action: "allow_session" }),
    },
  });

  const result = await executor.execute(toolInput("fake"));

  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("exceeds the maximum approval scope once");
  const requested = events.find((event): event is Extract<ChiliEvent, { type: "approval.requested" }> => event.type === "approval.requested");
  expect(requested?.payload.maxApprovalScope).toBe("once");
  const resolved = events.find((event): event is Extract<ChiliEvent, { type: "approval.resolved" }> => event.type === "approval.resolved");
  expect(resolved?.payload).toMatchObject({ decision: "deny" });
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

test("aborting while waiting for approval cancels the tool and ignores a late allow", async () => {
  const events: ChiliEvent[] = [];
  const controller = new AbortController();
  let executed = 0;
  let resolveDecision!: (decision: { action: "allow_once" }) => void;
  const decision = new Promise<{ action: "allow_once" }>((resolve) => {
    resolveDecision = resolve;
  });
  const tool: ChiliToolDefinition = {
    ...fakeTool({ permission: "bash", patterns: ["npm test"] }),
    execute: async () => {
      executed += 1;
      return { title: "fake", output: "ok" };
    },
  };
  const executor = createExecutor({
    events,
    tool,
    broker: {
      preflight: async () => ({ action: "ask", source: "test", reason: "test ask", metadata: {} }),
      decide: async () => decision,
    },
  });

  const execution = executor.execute({ ...toolInput("fake"), signal: controller.signal });
  await waitForEvent(events, (event) => event.type === "approval.requested");
  controller.abort(new DOMException("Tool approval aborted", "AbortError"));
  setTimeout(() => resolveDecision({ action: "allow_once" }), 20);

  const result = await execution;
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(result.status).toBe("cancelled");
  expect(executed).toBe(0);
  expect(events.filter((event) => event.type === "approval.resolved")).toHaveLength(1);
  expect(events.filter((event) => event.type === "tool.call_finished")).toMatchObject([
    { payload: { status: "cancelled" } },
  ]);
});

test("aborting a deferred approval removes it from the queue", async () => {
  const events: ChiliEvent[] = [];
  const queue = new DeferredApprovalQueue();
  const controller = new AbortController();
  const executor = createExecutor({
    events,
    tool: fakeTool({ permission: "bash", patterns: ["npm test"] }),
    broker: new PolicyApprovalBroker({
      ask: (request, signal) => queue.ask(request, signal),
    }),
  });

  const execution = executor.execute({ ...toolInput("fake"), signal: controller.signal });
  await waitForPending(queue, 1);
  const approvalId = queue.list()[0]!.approvalId;
  controller.abort(new DOMException("Deferred approval aborted", "AbortError"));

  expect((await execution).status).toBe("cancelled");
  expect(queue.list()).toHaveLength(0);
  expect(queue.resolve({ approvalId, decision: "allow_once" })).toBe(false);
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

test("bounds static, dynamic, and preflight approval metadata before desktop IPC", async () => {
  const hugeMetadata = "\u0000".repeat(5 * 1024 * 1024);
  const events: ChiliEvent[] = [];
  const tool: ChiliToolDefinition = {
    name: "approval_metadata",
    description: "Exercises every approval metadata source.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => ({
      permission: "static.approval",
      patterns: ["static-pattern"],
      metadata: { staticPayload: hugeMetadata, useful: "static-kept" },
    }),
    execute: async (_input, context) => {
      await context.requestApproval({
        permission: "dynamic.approval",
        patterns: ["dynamic-pattern"],
        metadata: { dynamicPayload: hugeMetadata, useful: "dynamic-kept" },
      });
      return { title: "approval metadata", output: "ok" };
    },
  };
  const executor = createExecutor({
    events,
    tool,
    broker: {
      preflight: async () => ({
        action: "ask",
        source: "metadata-test",
        reason: "bounded preflight metadata",
        metadata: {
          patternDecisions: [{ payload: hugeMetadata }],
          risks: [{ payload: hugeMetadata }],
        },
      }),
      decide: async () => ({ action: "allow_once" }),
    },
  });

  const result = await executor.execute(toolInput("approval_metadata"));
  expect(result.status).toBe("completed");
  const requested = events.filter(
    (event): event is Extract<ChiliEvent, { type: "approval.requested" }> => event.type === "approval.requested",
  );
  expect(requested).toHaveLength(2);
  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  for (const event of requested) {
    expect(Buffer.byteLength(JSON.stringify(event.payload.metadata), "utf8")).toBeLessThanOrEqual(512_000);
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(520_000);
    expect(() => parseDesktopEvent({ type: "runtime.event", event })).not.toThrow();
  }
});

test("redacts nested preflight diagnostics while preserving ordinary approval patterns", async () => {
  const worstEscapedReason = `password=abc\n${"\u0000".repeat(5 * 1024 * 1024)}`;
  const events: ChiliEvent[] = [];
  const tool = fakeTool({ permission: "write", patterns: ["token=x"] });
  const executor = createExecutor({
    events,
    tool,
    broker: {
      preflight: async () => ({
        action: "ask",
        source: "hostile-preflight",
        reason: worstEscapedReason,
        feedback: "Bearer TOP_LEVEL_FEEDBACK_SECRET",
        metadata: {
          ordinary: "keep this non-diagnostic policy description",
          patternDecisions: [{
            pattern: "token=x",
            reason: "client_secret=NESTED_REASON_SECRET",
            feedback: "password=NESTED_FEEDBACK_SECRET",
          }],
          risks: [{
            error: "token=NESTED_ERROR_SECRET",
            failureReason: "Authorization Basic NESTED_FAILURE_SECRET",
          }],
        },
      }),
      decide: async () => ({ action: "allow_once" }),
    },
  });

  const result = await executor.execute(toolInput("fake"));
  expect(result.status).toBe("completed");
  const requested = events.find(
    (event): event is Extract<ChiliEvent, { type: "approval.requested" }> =>
      event.type === "approval.requested",
  );
  expect(requested).toBeDefined();
  expect(requested?.payload.patterns).toEqual(["token=x"]);
  expect(requested?.payload.metadata).toMatchObject({
    patternDecisions: [{ pattern: "token=x" }],
    preflightDecision: {
      metadata: { ordinary: "keep this non-diagnostic policy description" },
    },
  });
  const serialized = JSON.stringify(requested);
  for (const secret of [
    "password=abc",
    "TOP_LEVEL_FEEDBACK_SECRET",
    "NESTED_REASON_SECRET",
    "NESTED_FEEDBACK_SECRET",
    "NESTED_ERROR_SECRET",
    "NESTED_FAILURE_SECRET",
  ]) {
    expect(serialized).not.toContain(secret);
  }
  expect(serialized).toContain("[REDACTED]");
  expect(Buffer.byteLength(JSON.stringify(requested?.payload.metadata), "utf8"))
    .toBeLessThanOrEqual(512_000);
  expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(600_000);

  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  expect(() => parseDesktopEvent({ type: "runtime.event", event: requested })).not.toThrow();
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

function fakeTool(spec: { permission: string; patterns: string[]; maxApprovalScope?: "once" | "session" | "persistent" }): ChiliToolDefinition {
  return {
    name: "fake",
    description: "Fake approval test tool.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => ({
      permission: spec.permission,
      patterns: spec.patterns,
      ...(spec.maxApprovalScope ? { maxApprovalScope: spec.maxApprovalScope } : {}),
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

async function waitForEvent(events: ChiliEvent[], predicate: (event: ChiliEvent) => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (events.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for tool event");
}
