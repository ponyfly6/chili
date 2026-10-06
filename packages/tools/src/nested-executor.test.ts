import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChiliEvent, SessionId, TurnId } from "@chili/protocol";
import { ToolDispatchScope } from "./dispatch-scope.js";
import { createCodeModeTool } from "./builtins/code-mode.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import { MAX_STRUCTURED_TOOL_RESULT_BYTES, validateStructuredToolData } from "./structured-data.js";
import type { ApprovalBroker, ChiliToolDefinition, ChiliToolExecutionContext, ToolAccessPolicyResolver } from "./types.js";

function tool(name: string, execute: ChiliToolDefinition["execute"], safe = true): ChiliToolDefinition {
  return { name, description: name, risk: "read", codeMode: true,
    inputSchema: { type: "object" }, isConcurrencySafe: safe, approval: () => false, execute };
}

function setup(children: ChiliToolDefinition[], run: (context: ChiliToolExecutionContext) => Promise<void>, options: {
  approvals?: ApprovalBroker; policyResolver?: ToolAccessPolicyResolver; scope?: ToolDispatchScope; signal?: AbortSignal;
} = {}) {
  const events: ChiliEvent[] = [];
  const registry = new InMemoryToolRegistry();
  for (const child of children) registry.register(child);
  registry.register({ ...tool("script", async (_, context) => {
    await run(context);
    return { title: "script", output: "done" };
  }, false), codeMode: false, isOrchestrator: true });
  const executor = new ToolExecutor({ registry, events: { publish: async (event) => { events.push(event); } },
    approvals: options.approvals ?? { decide: async () => ({ action: "allow_once" }) },
    ...(options.policyResolver ? { policyResolver: options.policyResolver } : {}),
  });
  const execute = () => executor.execute({ sessionId: "s" as SessionId, turnId: "t" as TurnId,
    toolName: "script", input: {}, cwd: process.cwd(),
    ...(options.scope ? { dispatchScope: options.scope } : {}), ...(options.signal ? { signal: options.signal } : {}),
  });
  return { executor, registry, events, execute };
}

test("nested calls inherit policy, validate schemas, and require an explicit callable capability", async () => {
  let executed = 0;
  const child = tool("child", async () => { executed++; return { title: "child", output: "yes" }; });
  child.inputSchema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };
  const { execute, events } = setup([child, { ...child, name: "direct_only", codeMode: false }], async (context) => {
    await expect(context.invokeTool!("child", { count: "bad" })).rejects.toThrow("integer");
    await expect(context.invokeTool!("direct_only", { count: 1 })).rejects.toThrow("catalog");
    await expect(context.invokeTool!("script", {})).rejects.toThrow("catalog");
    await context.invokeTool!("child", { count: 1 });
  });
  expect((await execute()).status).toBe("completed");
  expect(executed).toBe(1);
  const starts = events.filter((event) => event.type === "tool.call_started");
  expect(starts).toHaveLength(3);
  expect(starts[1]?.payload.parentCallId).toBe(starts[0]?.payload.callId);
  expect(starts[2]?.payload.parentCallId).toBe(starts[0]?.payload.callId);
});

test("nested calls recheck worker policy after approval and never broaden it", async () => {
  let denied = false;
  let executed = false;
  const child = { ...tool("write_child", async () => { executed = true; return { title: "write", output: "done" }; }),
    approval: () => ({ permission: "write", patterns: ["a"] }) };
  const { execute } = setup([child], async (context) => {
    await expect(context.invokeTool!("write_child", {})).rejects.toThrow("not allowed");
  }, {
    policyResolver: { resolve: () => denied ? { deniedTools: ["write_child"] } : undefined },
    approvals: { decide: async () => { denied = true; return { action: "allow_once" }; } },
  });
  expect((await execute()).status).toBe("completed");
  expect(executed).toBe(false);
});

test("nested calls recheck worker policy after waiting for an execution permit", async () => {
  const scope = new ToolDispatchScope({ maxConcurrentCalls: 1 });
  const release = await scope.acquire(false);
  let prepared!: () => void;
  const preparation = new Promise<void>((resolve) => { prepared = resolve; });
  let denied = false;
  let executions = 0;
  const child: ChiliToolDefinition = {
    ...tool("child", async () => { executions++; return { title: "child", output: "done" }; }),
    isConcurrencySafe: () => { prepared(); return true; },
  };
  const { execute } = setup([child], async (context) => {
    await expect(context.invokeTool!("child", {})).rejects.toThrow("not allowed");
  }, { scope, policyResolver: { resolve: () => denied ? { deniedTools: ["child"] } : undefined } });
  const pending = execute();
  await preparation;
  denied = true;
  release();
  expect((await pending).status).toBe("completed");
  expect(executions).toBe(0);
});

test("a script's catalog cannot silently change while a child waits for approval", async () => {
  let executed = false;
  const child = { ...tool("child", async () => { executed = true; return { title: "child", output: "old" }; }),
    approval: () => ({ permission: "read", patterns: ["*"] }) };
  const state = setup([child], async (context) => {
    await expect(context.invokeTool!("child", {})).rejects.toThrow("catalog changed");
  }, { approvals: { decide: async () => {
    state.registry.register(tool("child", async () => ({ title: "child", output: "replacement" })), { replace: true });
    return { action: "allow_once" };
  } } });
  expect((await state.execute()).status).toBe("completed");
  expect(executed).toBe(false);
});

test("contextual tools withdrawn without a registry replacement cannot execute from an old script catalog", async () => {
  let available = true;
  let executed = false;
  const ephemeral = tool("ephemeral", async () => { executed = true; return { title: "ephemeral", output: "done" }; });
  const state = setup([tool("revoke", async () => { available = false; return { title: "revoke", output: "done" }; })], async (context) => {
    await context.invokeTool!("revoke", {});
    await expect(context.invokeTool!("ephemeral", {})).rejects.toThrow("catalog changed");
  });
  state.registry.replaceContextualSource("remote", async () => available ? [ephemeral] : []);
  expect((await state.execute()).status).toBe("completed");
  expect(executed).toBe(false);
});

test("nested and direct tools share bounded parallel reads and fair exclusive writes", async () => {
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const read = tool("read", async (input) => {
    active++; peak = Math.max(peak, active); order.push(`start:${input.id}`);
    await Bun.sleep(5);
    order.push(`end:${input.id}`); active--;
    return { title: "read", output: String(input.id) };
  });
  const write = tool("write", async () => {
    expect(active).toBe(0); order.push("write");
    return { title: "write", output: "written" };
  }, false);
  const { execute } = setup([read, write], async (context) => {
    await Promise.all([
      context.invokeTool!("read", { id: 1 }), context.invokeTool!("read", { id: 2 }),
      context.invokeTool!("write", {}), context.invokeTool!("read", { id: 3 }),
    ]);
  }, { scope: new ToolDispatchScope({ maxConcurrentCalls: 2 }) });
  expect((await execute()).status).toBe("completed");
  expect(peak).toBe(2);
  expect(order.indexOf("write")).toBeGreaterThan(order.indexOf("end:2"));
  expect(order.indexOf("start:3")).toBeGreaterThan(order.indexOf("write"));
});

test("nested call budget latches and cannot be bypassed by catching the error", async () => {
  let checked = 0;
  let effects = 0;
  const scope = new ToolDispatchScope({ beforeCall: () => { if (++checked > 1) throw new Error("budget exhausted"); } });
  const { execute } = setup([tool("child", async () => { effects++; return { title: "child", output: "ok" }; })], async (context) => {
    await context.invokeTool!("child", {});
    await expect(context.invokeTool!("child", {})).rejects.toThrow("budget exhausted");
    await expect(context.invokeTool!("child", {})).rejects.toThrow("budget exhausted");
  }, { scope });
  expect((await execute()).status).toBe("completed");
  expect(effects).toBe(1);
  expect(checked).toBe(2);
});

test("aborting a queued child produces a terminal event without running its handler", async () => {
  const scope = new ToolDispatchScope({ maxConcurrentCalls: 1 });
  const release = await scope.acquire(false);
  const controller = new AbortController();
  let invoked = false;
  const { execute, events } = setup([tool("child", async () => { invoked = true; return { title: "child", output: "" }; })], async (context) => {
    await context.invokeTool!("child", {});
  }, { scope, signal: controller.signal });
  const promise = execute();
  await Bun.sleep(10);
  controller.abort();
  expect((await promise).status).toBe("cancelled");
  release();
  expect(invoked).toBe(false);
  expect(events.filter((event) => event.type === "tool.call_finished" && event.payload.status === "cancelled")).toHaveLength(2);
});

test("program data survives display truncation without leaking into tool events", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-code-data-"));
  try {
    const registry = new InMemoryToolRegistry();
    registry.register({ ...tool("data", async () => ({ title: "data", output: "long output".repeat(100), structuredData: { values: [1, 2, 3] } })), maxResultOutputBytes: 10 });
    const events: ChiliEvent[] = [];
    const executor = new ToolExecutor({ registry, events: { publish: async (event) => { events.push(event); } }, approvals: { decide: async () => ({ action: "allow_once" }) } });
    const result = await executor.execute({ sessionId: "s" as SessionId, turnId: "t" as TurnId, cwd, toolName: "data", input: {} });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.result.structuredData).toEqual({ values: [1, 2, 3] });
      expect(result.result.output).toContain("truncated");
    }
    expect(JSON.stringify(events)).not.toContain('"values"');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("structured data rejects cycles, getters, non-JSON values and oversized results", () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  let accessed = false;
  const getter = { get value() { accessed = true; return 1; } };
  for (const value of [cyclic, getter, NaN, () => 1, new Date(), { text: "x".repeat(4 * 1024 * 1024 + 1) }]) {
    expect(() => validateStructuredToolData(value)).toThrow();
  }
  expect(accessed).toBe(false);
});

test("oversized program data fails explicitly after the handler effect without silently omitting data", async () => {
  const registry = new InMemoryToolRegistry();
  let effects = 0;
  registry.register(tool("large", async () => {
    effects++;
    return { title: "large", output: "operation succeeded", structuredData: { output: "x".repeat(5 * 1024 * 1024) } };
  }));
  const executor = new ToolExecutor({ registry, events: { publish: async () => {} }, approvals: { decide: async () => ({ action: "allow_once" }) } });
  const result = await executor.execute({ sessionId: "s" as SessionId, turnId: "t" as TurnId, cwd: process.cwd(), toolName: "large", input: {} });
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toContain("4 MiB");
  expect(effects).toBe(1);
});

test("direct execution preserves program data above 1 MiB through the exact 4 MiB JSON boundary", async () => {
  for (const bytes of [1536 * 1024, MAX_STRUCTURED_TOOL_RESULT_BYTES]) {
    const structuredData = "x".repeat(bytes - 2);
    const registry = new InMemoryToolRegistry();
    registry.register(tool("large", async () => ({ title: "large", output: "summary", structuredData })));
    const executor = new ToolExecutor({ registry, events: { publish: async () => {} }, approvals: { decide: async () => ({ action: "allow_once" }) } });
    const result = await executor.execute({ sessionId: "s" as SessionId, turnId: "t" as TurnId, cwd: process.cwd(), toolName: "large", input: {} });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.result.structuredData).toBe(structuredData);
  }
});

test("nested execution preserves prepared normalization and validated scheduling inputs", async () => {
  let validations = 0;
  let preparations = 0;
  const child: ChiliToolDefinition = {
    ...tool("child", async (input) => {
      expect(input).toEqual({ count: 2 });
      expect(Object.isFrozen(input)).toBe(true);
      return { title: "child", output: "done" };
    }),
    validate: (input) => { validations++; return { ok: true, value: { count: Number((input as { count: unknown }).count) } }; },
    prepareInput: (input) => { preparations++; return { count: input.count + 1 }; },
    isConcurrencySafe: (input) => {
      expect(input).toEqual({ count: 2 });
      return true;
    },
    inputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
  };
  const { execute } = setup([child], async (context) => { await context.invokeTool!("child", { count: "1" }); });
  expect((await execute()).status).toBe("completed");
  expect(validations).toBe(1);
  expect(preparations).toBe(1);
});

test("nested catalog snapshots detect input schema mutation without a registry replacement", async () => {
  let executions = 0;
  const child = tool("child", async () => { executions++; return { title: "child", output: "done" }; });
  child.inputSchema = { type: "object", properties: { count: { type: "integer" } } };
  const { execute } = setup([child], async (context) => {
    await context.visibleTools!();
    (child.inputSchema as { properties: { count: { type: string } } }).properties.count.type = "string";
    await expect(context.invokeTool!("child", { count: "1" })).rejects.toThrow("catalog changed");
  });
  expect((await execute()).status).toBe("completed");
  expect(executions).toBe(0);
});

test("prepared calls reject changes to code mode capabilities and schema trust", async () => {
  const changes: Partial<ChiliToolDefinition>[] = [
    { codeMode: false }, { isOrchestrator: true }, { inputSchemaSource: "external" }, { outputSchema: { type: "string" } },
  ];
  for (const change of changes) {
    let executions = 0;
    const original = tool("child", async () => { executions++; return { title: "child", output: "done" }; });
    let current = original;
    const registry = new InMemoryToolRegistry();
    registry.replaceContextualSource("test", () => [current]);
    const executor = new ToolExecutor({ registry, events: { publish: async () => {} }, approvals: { decide: async () => ({ action: "allow_once" }) } });
    const request = { sessionId: "s" as SessionId, turnId: "t" as TurnId, cwd: process.cwd(), toolName: "child", input: {} };
    const prepared = await executor.prepare(request);
    current = { ...original, ...change };
    const result = await executor.execute({ ...request, prepared });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error.message).toContain("catalog changed");
    expect(executions).toBe(0);
  }
});

test("orchestrator and nested tools retain the runtime owner context", async () => {
  const owner = new AsyncLocalStorage<string>();
  const seen: (string | undefined)[] = [];
  const registry = new InMemoryToolRegistry();
  registry.register(tool("child", async () => {
    seen.push(owner.getStore());
    return { title: "child", output: "done" };
  }));
  registry.register({ ...tool("script", async (_, context) => {
    seen.push(owner.getStore());
    await context.invokeTool!("child", {});
    return { title: "script", output: "done" };
  }, false), isOrchestrator: true, codeMode: false });
  const executor = new ToolExecutor({ registry, executionContext: (operation) => owner.run("runtime-owner", operation),
    events: { publish: async () => {} }, approvals: { decide: async () => ({ action: "allow_once" }) },
  });
  const result = await executor.execute({ sessionId: "s" as SessionId, turnId: "t" as TurnId, cwd: process.cwd(), toolName: "script", input: {} });
  expect(result.status).toBe("completed");
  expect(seen).toEqual(["runtime-owner", "runtime-owner"]);
});

test("scripts cannot catch an audit storage failure and continue producing effects", async () => {
  const registry = new InMemoryToolRegistry();
  let secondRan = false;
  let firstId: string | undefined;
  let failedPublish = false;
  registry.register(createCodeModeTool());
  registry.register(tool("first", async () => ({ title: "first", output: "done" })));
  registry.register(tool("second", async () => { secondRan = true; return { title: "second", output: "done" }; }));
  const executor = new ToolExecutor({ registry, approvals: { decide: async () => ({ action: "allow_once" }) }, events: {
    publish: async (event) => {
      if (event.type === "tool.call_started" && event.payload.toolName === "first") firstId = event.payload.callId;
      if (!failedPublish && event.type === "tool.call_finished" && event.payload.callId === firstId) {
        failedPublish = true;
        throw new Error("audit storage unavailable");
      }
    },
  } });
  await expect(executor.execute({ sessionId: "s" as SessionId, turnId: "t" as TurnId, cwd: process.cwd(), toolName: "code_mode",
    input: { code: 'try { await tools.first({}); } catch (error) { text(error.message); } await tools.second({});' },
  })).rejects.toThrow("audit storage unavailable");
  expect(secondRan).toBe(false);
});
