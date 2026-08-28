import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PERSISTED_ERROR_LIMITS,
  type ChiliEvent,
  type SessionId,
  type SnapshotId,
  type TimestampMs,
  type ToolCallId,
  type TurnId,
} from "@chili/protocol";
import { createActivateSkillTool } from "./builtins/activate-skill.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import type { ChiliToolDefinition, ExecuteToolInput } from "./types.js";

test("bounds oversized image content, title, and metadata before returning or publishing", async () => {
  const hugeImage = "A".repeat(4_000_001);
  const hugeMetadata = "METADATA_SECRET_".repeat(100_000);
  const circular: Record<string, unknown> = { hugeMetadata };
  circular.self = circular;
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    name: "huge_content",
    description: "Returns hostile content.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({
      title: "T".repeat(20_000),
      output: "safe summary",
      content: [{ type: "image", data: hugeImage, mimeType: "image/png" }],
      metadata: { circular },
    }),
  }, events);

  const result = await executor.execute(toolInput("huge_content"));
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(Buffer.byteLength(result.result.title, "utf8")).toBeLessThanOrEqual(8_192);
  expect(result.result.content).toEqual([{
    type: "text",
    text: "[image omitted: 4000001 encoded bytes exceeds tool content limit]",
  }]);
  expect(result.result.metadata).toMatchObject({ contentTruncated: true });
  const serialized = JSON.stringify(result.result);
  expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(1_000_000);
  expect(serialized).not.toContain(hugeImage.slice(0, 1_000_000));
  expect(serialized).toContain("circular metadata");
  expect(JSON.stringify(events)).not.toContain(hugeImage.slice(0, 1_000_000));
});

test("enforces an aggregate byte cap across otherwise valid images", async () => {
  const image = "B".repeat(550_000);
  const executor = createExecutor({
    name: "aggregate_content",
    description: "Returns aggregate-heavy content.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({
      title: "aggregate",
      output: "safe summary",
      content: [
        { type: "image" as const, data: image, mimeType: "image/png" },
        { type: "image" as const, data: image, mimeType: "image/png" },
        { type: "image" as const, data: image, mimeType: "image/png" },
      ],
    }),
  });

  const result = await executor.execute(toolInput("aggregate_content"));
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(result.result.content).toHaveLength(3);
  expect(result.result.content?.[0]).toMatchObject({ type: "image" });
  expect(result.result.content?.[1]).toMatchObject({ type: "image" });
  expect(result.result.content?.[2]).toMatchObject({ type: "text" });
  expect(result.result.metadata).toMatchObject({ contentTruncated: true });
  expect(Buffer.byteLength(JSON.stringify(result.result.content), "utf8")).toBeLessThanOrEqual(1_250_000);
});

test("caps each streamed delta and aggregate SSE output for a tool call", async () => {
  const events: ChiliEvent[] = [];
  const delta = "D".repeat(300_000);
  const executor = createExecutor({
    name: "huge_stream",
    description: "Streams hostile output.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async (_input, context) => {
      for (let index = 0; index < 20; index += 1) {
        await context.streamOutput({ stream: "stdout", delta, bytes: delta.length });
      }
      return { title: "stream", output: "done" };
    },
  }, events);

  const result = await executor.execute(toolInput("huge_stream"));
  expect(result.status).toBe("completed");
  const deltas = events.filter(
    (event): event is Extract<ChiliEvent, { type: "tool.output_delta" }> => event.type === "tool.output_delta",
  );
  expect(deltas.length).toBeGreaterThan(0);
  expect(deltas.length).toBeLessThan(20);
  expect(deltas.every((event) => Buffer.byteLength(event.payload.delta, "utf8") <= 256_000)).toBe(true);
  expect(deltas.some((event) => event.payload.truncated === true)).toBe(true);
  expect(deltas.reduce((sum, event) => sum + Buffer.byteLength(event.payload.delta, "utf8"), 0))
    .toBeLessThanOrEqual(4_000_000);
});

test("bounds untrusted call input without changing the value executed by the tool", async () => {
  const hugeInput = "\u0000".repeat(4 * 1024 * 1024);
  let executedBytes = 0;
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    name: "huge_input",
    description: "Receives a large input.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async (input: { payload?: string }) => {
      executedBytes = Buffer.byteLength(input.payload ?? "", "utf8");
      return { title: "input", output: "done" };
    },
  }, events);

  const result = await executor.execute({
    ...toolInput("huge_input"),
    input: { payload: hugeInput },
  });
  expect(result.status).toBe("completed");
  expect(executedBytes).toBe(4 * 1024 * 1024);
  const started = events.find(
    (event): event is Extract<ChiliEvent, { type: "tool.call_started" }> => event.type === "tool.call_started",
  );
  expect(Buffer.byteLength(JSON.stringify(started?.payload.input), "utf8")).toBeLessThanOrEqual(512_000);
  expect(Buffer.byteLength(JSON.stringify(started), "utf8")).toBeLessThan(520_000);
  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  expect(() => parseDesktopEvent({ type: "runtime.event", event: started })).not.toThrow();
});

test("normalizes hostile call ids once across the complete executor lifecycle", async () => {
  for (const rawCallId of ["__proto__", "\u0000".repeat(4 * 1024 * 1024)]) {
    const events: ChiliEvent[] = [];
    const executor = createExecutor({
      name: "safe_call_id",
      description: "Returns a small result.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      execute: async () => ({ title: "safe", output: "done" }),
    }, events);

    const result = await executor.execute({
      ...toolInput("safe_call_id"),
      callId: rawCallId as ToolCallId,
    });
    expect(result.status).toBe("completed");
    expect(result.callId).not.toBe(rawCallId);
    expect(result.callId).toMatch(/^toolcall_invalid_[a-f0-9]{16}$/u);
    const lifecycle = events.filter((event): event is Extract<ChiliEvent, {
      type: "tool.call_started" | "tool.call_updated" | "tool.output_delta" | "tool.call_finished";
    }> => event.type === "tool.call_started"
      || event.type === "tool.call_updated"
      || event.type === "tool.output_delta"
      || event.type === "tool.call_finished");
    expect(lifecycle.length).toBeGreaterThanOrEqual(4);
    expect(new Set(lifecycle.map((event) => event.payload.callId))).toEqual(new Set([result.callId]));

    const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
    const { parseDesktopEvent } = await import(contractsModulePath) as {
      parseDesktopEvent(value: unknown): unknown;
    };
    for (const event of lifecycle) {
      expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(520_000);
      expect(() => parseDesktopEvent({ type: "runtime.event", event })).not.toThrow();
    }
  }
});

test("bounds hostile snapshot provider fields before lifecycle persistence", async () => {
  const hugePath = "\u0000".repeat(4 * 1024 * 1024);
  const registry = new InMemoryToolRegistry();
  registry.register({
    name: "snapshot_bound",
    description: "Creates a defensive snapshot event.",
    risk: "write",
    inputSchema: { type: "object" },
    approval: () => ({ permission: "write", patterns: ["README.md"] }),
    execute: async () => ({ title: "snapshot", output: "done" }),
  });
  const events: ChiliEvent[] = [];
  const executor = new ToolExecutor({
    registry,
    events: { publish: async (event) => { events.push(event); } },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    snapshotProvider: {
      create: async () => ({
        id: "snapshot_safe" as SnapshotId,
        cwd: process.cwd(),
        paths: [hugePath],
        createdAt: 1 as TimestampMs,
      }),
      revert: async (snapshotId) => ({ snapshotId, paths: [], restored: [], removed: [] }),
    },
    createId: (prefix) => `${prefix}_snapshot_bound`,
    now: () => 1 as TimestampMs,
  });

  const result = await executor.execute(toolInput("snapshot_bound"));
  expect(result.status).toBe("completed");
  const snapshotEvent = events.find(
    (event): event is Extract<ChiliEvent, { type: "snapshot.created" }> => event.type === "snapshot.created",
  );
  expect(snapshotEvent?.payload.snapshotId).toBe("snapshot_safe" as SnapshotId);
  expect(Buffer.byteLength(JSON.stringify(snapshotEvent), "utf8")).toBeLessThan(520_000);
  expect(JSON.stringify(snapshotEvent)).not.toContain(hugePath.slice(0, 1_000_000));

  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  expect(() => parseDesktopEvent({ type: "runtime.event", event: snapshotEvent })).not.toThrow();

  const invalidEvents: ChiliEvent[] = [];
  const invalidExecutor = new ToolExecutor({
    registry,
    events: { publish: async (event) => { invalidEvents.push(event); } },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    snapshotProvider: {
      create: async () => ({
        id: "__proto__" as SnapshotId,
        cwd: process.cwd(),
        paths: ["README.md"],
        createdAt: 1 as TimestampMs,
      }),
      revert: async (snapshotId) => ({ snapshotId, paths: [], restored: [], removed: [] }),
    },
    createId: (prefix) => `${prefix}_snapshot_invalid`,
    now: () => 1 as TimestampMs,
  });
  const invalidResult = await invalidExecutor.execute(toolInput("snapshot_bound"));
  expect(invalidResult.status).toBe("failed");
  expect(invalidEvents.some((event) => event.type === "snapshot.created")).toBe(false);
  for (const event of invalidEvents) {
    expect(() => parseDesktopEvent({ type: "runtime.event", event })).not.toThrow();
  }
});

test("redacts and bounds worst-case approval denial feedback before durable events", async () => {
  const bearerToken = "APPROVAL_SECRET_123456";
  const loopbackUrl = "http://localhost:47832/private?token=APPROVAL_URL_SECRET";
  const feedback = `Denied with Bearer ${bearerToken} at ${loopbackUrl}\n${"\u0000".repeat(5 * 1024 * 1024)}`;
  const registry = new InMemoryToolRegistry();
  let executed = false;
  registry.register({
    name: "approval_feedback_bound",
    description: "Requires approval.",
    risk: "write",
    inputSchema: { type: "object" },
    approval: () => ({ permission: "write", patterns: ["README.md"] }),
    execute: async () => {
      executed = true;
      return { title: "unexpected", output: "unexpected" };
    },
  });
  const events: ChiliEvent[] = [];
  const executor = new ToolExecutor({
    registry,
    events: { publish: async (event) => { events.push(event); } },
    approvals: { decide: async () => ({ action: "deny", feedback }) },
    createId: (prefix) => `${prefix}_approval_feedback`,
    now: () => 1 as TimestampMs,
  });

  const result = await executor.execute(toolInput("approval_feedback_bound"));
  expect(result.status).toBe("failed");
  expect(executed).toBe(false);
  const durable = events.filter((event) =>
    event.type === "approval.resolved" || event.type === "tool.call_finished"
  );
  expect(durable).toHaveLength(2);
  const serialized = JSON.stringify(durable);
  expect(serialized).not.toContain(bearerToken);
  expect(serialized).not.toContain(loopbackUrl);
  expect(serialized).not.toContain("APPROVAL_URL_SECRET");

  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  for (const event of durable) {
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(120_000);
    expect(() => parseDesktopEvent({ type: "runtime.event", event })).not.toThrow();
  }
});

test("normalizes an oversized control-character tool name in lifecycle events", async () => {
  const hugeToolName = "\u0000".repeat(4 * 1024 * 1024);
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    name: "known_tool",
    description: "Known tool.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "known", output: "done" }),
  }, events);

  const result = await executor.execute({
    ...toolInput("known_tool"),
    callId: "toolcall_huge_tool_name" as ToolCallId,
    toolName: hugeToolName,
  });
  expect(result.status).toBe("failed");
  const started = events.find(
    (event): event is Extract<ChiliEvent, { type: "tool.call_started" }> => event.type === "tool.call_started",
  );
  expect(started?.payload.toolName).toBe("unknown_tool");
  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  for (const event of events) {
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(120_000);
    expect(() => parseDesktopEvent({ type: "runtime.event", event })).not.toThrow();
  }
});

test("rejects invalid stream and metadata statuses before publishing malformed events", async () => {
  const invalidStream = "\u0000".repeat(4 * 1024 * 1024);
  const streamEvents: ChiliEvent[] = [];
  const streamExecutor = createExecutor({
    name: "invalid_stream",
    description: "Publishes an invalid stream name.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async (_input, context) => {
      await context.streamOutput({ stream: invalidStream as never, delta: "ok" });
      return { title: "unexpected", output: "unexpected" };
    },
  }, streamEvents);
  const streamResult = await streamExecutor.execute(toolInput("invalid_stream"));
  expect(streamResult.status).toBe("failed");
  expect(streamEvents.some((event) => event.type === "tool.output_delta")).toBe(false);

  const statusEvents: ChiliEvent[] = [];
  const statusExecutor = createExecutor({
    name: "invalid_metadata_status",
    description: "Publishes an invalid metadata status.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async (_input, context) => {
      await context.metadata({ status: invalidStream as never, metadata: { ignored: invalidStream } });
      return { title: "unexpected", output: "unexpected" };
    },
  }, statusEvents);
  const statusResult = await statusExecutor.execute(toolInput("invalid_metadata_status"));
  expect(statusResult.status).toBe("failed");
  expect(statusEvents.some((event) =>
    event.type === "tool.call_updated" && event.payload.metadata !== undefined
  )).toBe(false);

  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  for (const event of [...streamEvents, ...statusEvents]) {
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(520_000);
    expect(() => parseDesktopEvent({ type: "runtime.event", event })).not.toThrow();
  }
});

test("normalizes a 5 MiB multibyte tool rejection before returning or publishing it", async () => {
  const hugeMessage = "错".repeat(Math.ceil((5 * 1024 * 1024) / 3));
  const source = Object.assign(new Error(hugeMessage), {
    name: "RemoteToolError",
    code: "E_REMOTE_TOOL",
    cause: { secret: hugeMessage },
    persistedErrorDetails: { name: "Error", truncated: true as const, originalMessageBytes: 1 },
  });
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    name: "huge_error",
    description: "Rejects with a hostile error.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => { throw source; },
  }, events);

  const result = await executor.execute(toolInput("huge_error"));
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.error).not.toBe(source);
  expect(result.error.name).toBe("RemoteToolError");
  expect((result.error as Error & { code?: string }).code).toBe("E_REMOTE_TOOL");
  expect((result.error as Error & { cause?: unknown }).cause).toBeUndefined();
  expect(Buffer.byteLength(result.error.message, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
  expect(result.error.message).toContain("error message truncated from");
  expect(result.error.message).not.toContain("\uFFFD");

  const finished = events.find(
    (event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished",
  );
  expect(finished?.payload.error).toBe(result.error.message);
  expect(finished?.payload.errorDetails).toMatchObject({
    name: "RemoteToolError",
    code: "E_REMOTE_TOOL",
    truncated: true,
    originalMessageBytes: Buffer.byteLength(hugeMessage, "utf8"),
  });
  expect(Buffer.byteLength(JSON.stringify(finished), "utf8")).toBeLessThan(18_000);
});

test("redacts Bearer credentials and loopback URLs before tool errors reach desktop IPC", async () => {
  const bearerToken = "tool-secret-token._~+/==";
  const controlObfuscatedToken = "CONTROL_OBFUSCATED_TOOL_SECRET";
  const loopbackUrl = "http://127.0.0.1:49152/private/callback?token=tool-url-secret";
  const externalUrl = "https://api.example.com/public-status?id=42";
  const source = Object.assign(new Error(
    `Tool request failed: Bearer x; to\u001bken=${controlObfuscatedToken}; sk-x; `
      + `Bearer ${bearerToken} via ${loopbackUrl}; remote=${externalUrl}\n`
      + "错".repeat(Math.ceil((5 * 1024 * 1024) / 3)),
  ), { name: "ToolAuthError", code: "E_TOOL_AUTH" });
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    name: "sensitive_error",
    description: "Rejects with recognizable credentials and a local endpoint.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => { throw source; },
  }, events);

  const result = await executor.execute(toolInput("sensitive_error"));
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.error.message).toContain("Bearer [REDACTED]");
  expect(result.error.message).toContain("token=[REDACTED]");
  expect(result.error.message).toContain("sk-[REDACTED]");
  expect(result.error.message).toContain("[loopback URL redacted]");
  expect(result.error.message).toContain(externalUrl);
  expect(result.error.message).not.toContain("Bearer x");
  expect(result.error.message).not.toContain(controlObfuscatedToken);
  expect(result.error.message).not.toContain("sk-x");
  expect(result.error.message).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
  expect(result.error.message).not.toContain(bearerToken);
  expect(result.error.message).not.toContain(loopbackUrl);
  expect(Buffer.byteLength(result.error.message, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
  const finished = events.find(
    (event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished",
  );
  const serialized = JSON.stringify(finished);
  expect(serialized).not.toContain("Bearer x");
  expect(serialized).not.toContain(controlObfuscatedToken);
  expect(serialized).not.toContain("sk-x");
  expect(serialized).not.toContain(bearerToken);
  expect(serialized).not.toContain(loopbackUrl);
  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  expect(() => parseDesktopEvent({ type: "runtime.event", event: finished })).not.toThrow();
});

test("normalizes 5 MiB abort reasons as bounded cancellations", async () => {
  const hugeMessage = "停".repeat(Math.ceil((5 * 1024 * 1024) / 3));
  const error = Object.assign(new Error(hugeMessage), { name: "AbortError", code: "E_CANCELLED" });
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    name: "huge_abort",
    description: "Aborts with a hostile reason.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => { throw error; },
  }, events);

  const result = await executor.execute(toolInput("huge_abort"));
  expect(result.status).toBe("cancelled");
  if (result.status !== "cancelled") return;
  expect(result.error.name).toBe("AbortError");
  expect((result.error as Error & { code?: string }).code).toBe("E_CANCELLED");
  expect(Buffer.byteLength(result.error.message, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
  expect(result.error.message).not.toContain("\uFFFD");
  const finished = events.find(
    (event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished",
  );
  expect(finished?.payload.status).toBe("cancelled");
  expect(finished?.payload.errorDetails).toMatchObject({ name: "AbortError", code: "E_CANCELLED", truncated: true });
});

test("preserves truncation metadata for a 5 MiB AbortController reason", async () => {
  const hugeMessage = "停".repeat(Math.ceil((5 * 1024 * 1024) / 3));
  const originalBytes = Buffer.byteLength(hugeMessage, "utf8");
  const source = Object.assign(new Error(hugeMessage), {
    name: "RemoteCancelError",
    code: "E_SIGNAL_CANCEL",
  });
  const controller = new AbortController();
  let approvalStartedResolve: (() => void) | undefined;
  const approvalStarted = new Promise<void>((resolve) => { approvalStartedResolve = resolve; });
  const events: ChiliEvent[] = [];
  const registry = new InMemoryToolRegistry();
  registry.register({
    name: "signal_abort",
    description: "Waits for approval cancellation.",
    risk: "write",
    inputSchema: { type: "object" },
    approval: () => ({ patterns: ["signal-abort"] }),
    execute: async () => ({ title: "unexpected", output: "unexpected" }),
  });
  const executor = new ToolExecutor({
    registry,
    events: { publish: async (event) => { events.push(event); } },
    approvals: {
      decide: async () => {
        approvalStartedResolve?.();
        return new Promise(() => {});
      },
    },
    createId: (prefix) => `${prefix}_signal_abort`,
    now: () => 1 as TimestampMs,
  });
  const execution = executor.execute({ ...toolInput("signal_abort"), signal: controller.signal });
  await approvalStarted;
  controller.abort(source);

  const result = await execution;
  expect(result.status).toBe("cancelled");
  if (result.status !== "cancelled") return;
  expect(result.error.name).toBe("AbortError");
  expect((result.error as Error & { code?: string }).code).toBe("E_SIGNAL_CANCEL");
  const details = (result.error as Error & {
    persistedErrorDetails?: { truncated?: true; originalMessageBytes?: number };
  }).persistedErrorDetails;
  expect(details).toMatchObject({ truncated: true, originalMessageBytes: originalBytes });
  const finished = events.find(
    (event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished",
  );
  expect(finished?.payload.errorDetails).toMatchObject({
    name: "AbortError",
    code: "E_SIGNAL_CANCEL",
    truncated: true,
    originalMessageBytes: originalBytes,
  });
});

test("treats a custom execute-phase AbortController reason as a bounded cancellation", async () => {
  const hugeMessage = "停".repeat(Math.ceil((5 * 1024 * 1024) / 3));
  const originalBytes = Buffer.byteLength(hugeMessage, "utf8");
  const source = Object.assign(new Error(hugeMessage), {
    name: "RemoteCancelError",
    code: "E_REMOTE_CANCEL",
  });
  const controller = new AbortController();
  let executionStartedResolve: (() => void) | undefined;
  const executionStarted = new Promise<void>((resolve) => { executionStartedResolve = resolve; });
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    name: "execute_signal_abort",
    description: "Throws the custom signal reason after execution starts.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async (_input, context) => {
      executionStartedResolve?.();
      if (!context.signal.aborted) {
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      throw context.signal.reason;
    },
  }, events);

  const execution = executor.execute({ ...toolInput("execute_signal_abort"), signal: controller.signal });
  await executionStarted;
  controller.abort(source);

  const result = await execution;
  expect(result.status).toBe("cancelled");
  if (result.status !== "cancelled") return;
  expect(result.error.name).toBe("AbortError");
  expect((result.error as Error & { code?: string }).code).toBe("E_REMOTE_CANCEL");
  expect(Buffer.byteLength(result.error.message, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
  expect((result.error as Error & {
    persistedErrorDetails?: { truncated?: true; originalMessageBytes?: number };
  }).persistedErrorDetails).toMatchObject({ truncated: true, originalMessageBytes: originalBytes });
  const finished = events.find(
    (event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished",
  );
  expect(finished?.payload).toMatchObject({
    status: "cancelled",
    errorDetails: {
      name: "AbortError",
      code: "E_REMOTE_CANCEL",
      truncated: true,
      originalMessageBytes: originalBytes,
    },
  });
});

test("fences pre-aborted and signal-ignoring tools from reporting completion", async () => {
  const preAbortedController = new AbortController();
  preAbortedController.abort(Object.assign(new Error("cancel before execute"), {
    name: "RemoteCancelError",
    code: "E_PRE_ABORT",
  }));
  let preAbortedToolExecuted = false;
  const preAbortedExecutor = createExecutor({
    name: "pre_aborted",
    description: "Must not execute after its signal is already aborted.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => {
      preAbortedToolExecuted = true;
      return { title: "unexpected", output: "unexpected" };
    },
  });
  const preAbortedResult = await preAbortedExecutor.execute({
    ...toolInput("pre_aborted"),
    signal: preAbortedController.signal,
  });
  expect(preAbortedResult.status).toBe("cancelled");
  expect(preAbortedToolExecuted).toBe(false);

  const ignoredController = new AbortController();
  let executionStartedResolve: (() => void) | undefined;
  let finishExecutionResolve: (() => void) | undefined;
  const executionStarted = new Promise<void>((resolve) => { executionStartedResolve = resolve; });
  const finishExecution = new Promise<void>((resolve) => { finishExecutionResolve = resolve; });
  const events: ChiliEvent[] = [];
  const ignoredExecutor = createExecutor({
    name: "ignored_abort",
    description: "Returns success even after its signal is aborted.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => {
      executionStartedResolve?.();
      await finishExecution;
      return { title: "ignored", output: "must not complete" };
    },
  }, events);
  const execution = ignoredExecutor.execute({ ...toolInput("ignored_abort"), signal: ignoredController.signal });
  await executionStarted;
  ignoredController.abort(Object.assign(new Error("cancel ignored execution"), {
    name: "RemoteCancelError",
    code: "E_IGNORED_ABORT",
  }));
  finishExecutionResolve?.();

  const ignoredResult = await execution;
  expect(ignoredResult.status).toBe("cancelled");
  if (ignoredResult.status !== "cancelled") return;
  expect(ignoredResult.error.name).toBe("AbortError");
  expect((ignoredResult.error as Error & { code?: string }).code).toBe("E_IGNORED_ABORT");
  const finished = events.filter(
    (event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished",
  );
  expect(finished).toHaveLength(1);
  expect(finished[0]?.payload.status).toBe("cancelled");
});

test("signal cancellation wins while contextual tool selection rejects or resolves late", async () => {
  for (const phase of ["reject", "resolve"] as const) {
    const signalSecret = `context-selection-signal-secret-${phase}`;
    const selectionSecret = `context-selection-provider-secret-${phase}`;
    const rawMessage = `password=${signalSecret}\0\nAuthorization Basic ${signalSecret}\n`
      + "错".repeat(Math.ceil((5 * 1024 * 1024) / 3));
    const originalBytes = Buffer.byteLength(rawMessage, "utf8");
    const signalReason = Object.assign(new Error(rawMessage), {
      name: "RemoteContextSelectionAbortError",
      code: `E_CONTEXT_ABORT_${phase.toUpperCase()}`,
      cause: { signalSecret },
    });
    const selectionFailure = new Error(`password=${selectionSecret}\0`);
    let selectionStartedResolve: (() => void) | undefined;
    const selectionStarted = new Promise<void>((resolve) => { selectionStartedResolve = resolve; });
    let releaseSelectionResolve: (() => void) | undefined;
    const releaseSelection = new Promise<void>((resolve) => { releaseSelectionResolve = resolve; });
    let toolExecuted = false;
    const contextualTool: ChiliToolDefinition = {
      name: `late_contextual_${phase}`,
      description: "Must not execute after contextual selection is cancelled.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      execute: async () => {
        toolExecuted = true;
        return { title: "unexpected", output: "unexpected" };
      },
    };
    const registry = new InMemoryToolRegistry();
    registry.replaceContextualSource(`late_contextual_${phase}`, async () => {
      selectionStartedResolve?.();
      await releaseSelection;
      if (phase === "reject") throw selectionFailure;
      return [contextualTool];
    });
    const events: ChiliEvent[] = [];
    const executor = new ToolExecutor({
      registry,
      events: { publish: async (event) => { events.push(event); } },
      approvals: { decide: async () => ({ action: "allow_once" }) },
      createId: (prefix) => `${prefix}_context_selection_${phase}`,
      now: () => 1 as TimestampMs,
    });
    const controller = new AbortController();
    const execution = executor.execute({
      ...toolInput(contextualTool.name),
      signal: controller.signal,
    });
    await selectionStarted;
    controller.abort(signalReason);
    releaseSelectionResolve?.();

    const result = await execution;
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") continue;
    expect(result.error.name).toBe("AbortError");
    expect((result.error as Error & { code?: string }).code).toBe(signalReason.code);
    expect((result.error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(Buffer.byteLength(result.error.message, "utf8"))
      .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    expect(result.error.message).toContain("password=[REDACTED]");
    expect(result.error.message).toContain("Authorization Basic [REDACTED]");
    expect(result.error.message).not.toContain(signalSecret);
    expect(result.error.message).not.toContain(selectionSecret);
    expect(result.error.message).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
    expect((result.error as Error & {
      persistedErrorDetails?: { truncated?: true; originalMessageBytes?: number };
    }).persistedErrorDetails).toMatchObject({
      truncated: true,
      originalMessageBytes: originalBytes,
    });
    expect(toolExecuted).toBe(false);
    expect(events.filter((event) => event.type === "tool.call_updated")).toHaveLength(0);
    const finished = events.filter(
      (event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished",
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({
      status: "cancelled",
      errorDetails: {
        name: "AbortError",
        code: signalReason.code,
        truncated: true,
        originalMessageBytes: originalBytes,
      },
    });
    expect(JSON.stringify(events)).not.toContain(signalSecret);
    expect(JSON.stringify(events)).not.toContain(selectionSecret);
  }
});

test("bounds non-Error rejections and survives throwing error getters", async () => {
  const huge = "界".repeat(Math.ceil((5 * 1024 * 1024) / 3));
  const stringExecutor = createExecutor({
    name: "string_error",
    description: "Rejects with a string.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => { throw huge; },
  });
  const stringResult = await stringExecutor.execute(toolInput("string_error"));
  expect(stringResult.status).toBe("failed");
  if (stringResult.status !== "failed") return;
  expect(Buffer.byteLength(stringResult.error.message, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
  expect(stringResult.error.message).not.toContain("\uFFFD");

  const hostile = Object.create(null, {
    message: { get() { throw new Error("message getter"); } },
    name: { get() { throw new Error("name getter"); } },
    code: { get() { throw new Error("code getter"); } },
    toString: { value() { throw new Error("toString"); } },
  });
  const getterExecutor = createExecutor({
    name: "getter_error",
    description: "Rejects with throwing getters.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => { throw hostile; },
  });
  const getterResult = await getterExecutor.execute(toolInput("getter_error"));
  expect(getterResult.status).toBe("failed");
  if (getterResult.status !== "failed") return;
  expect(getterResult.error.name).toBe("Error");
  expect(getterResult.error.message).toBe("Unknown error");
});

test("caps safe machine-readable error names and codes independently", async () => {
  const error = Object.assign(new Error("short message"), {
    name: "N".repeat(1_000),
    code: "C".repeat(1_000),
  });
  const executor = createExecutor({
    name: "long_error_identity",
    description: "Rejects with long machine identifiers.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => { throw error; },
  });

  const result = await executor.execute(toolInput("long_error_identity"));
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(Buffer.byteLength(result.error.name, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.nameBytes);
  expect(Buffer.byteLength(String((result.error as Error & { code?: string }).code), "utf8"))
    .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.codeBytes);
  expect(result.error.message).toBe("short message");

  const unsafeNumber = Object.assign(new Error("unsafe numeric code"), {
    code: Number.MAX_SAFE_INTEGER + 1,
  });
  const numericExecutor = createExecutor({
    name: "unsafe_numeric_code",
    description: "Rejects with an unsafe numeric code.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => { throw unsafeNumber; },
  });
  const numericResult = await numericExecutor.execute(toolInput("unsafe_numeric_code"));
  expect(numericResult.status).toBe("failed");
  if (numericResult.status !== "failed") return;
  expect((numericResult.error as Error & { code?: number }).code).toBeUndefined();
});

test("preserves prototype-named metadata keys without mutating the output prototype", async () => {
  const metadata = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(metadata, "__proto__", { enumerable: true, value: { polluted: true } });
  Object.defineProperty(metadata, "constructor", { enumerable: true, value: "constructor-value" });
  Object.defineProperty(metadata, "prototype", { enumerable: true, value: "prototype-value" });
  metadata.large = "\u0000".repeat(600_000);
  const executor = createExecutor({
    name: "prototype_metadata",
    description: "Returns prototype-named metadata.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "metadata", output: "done", metadata }),
  });

  const result = await executor.execute(toolInput("prototype_metadata"));
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(Object.getPrototypeOf(result.result.metadata)).toBeNull();
  expect(Reflect.get(result.result.metadata ?? {}, "__proto__")).toEqual({ polluted: true });
  expect(Reflect.get(result.result.metadata ?? {}, "constructor")).toBe("constructor-value");
  expect(Reflect.get(result.result.metadata ?? {}, "prototype")).toBe("prototype-value");
  expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(result.result.metadata), "utf8")).toBeLessThanOrEqual(512_000);
});

test("caps the actual serialized metadata bytes including JSON escaping and keys", async () => {
  const metadata: Record<string, unknown> = {};
  for (let index = 0; index < 128; index += 1) {
    metadata[`${"K".repeat(500)}-${index}`] = "\u0000\n\t\"\\".repeat(40_000);
  }
  const executor = createExecutor({
    name: "escaped_metadata",
    description: "Returns JSON-expensive metadata.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "metadata", output: "done", metadata }),
  });

  const result = await executor.execute(toolInput("escaped_metadata"));
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(Buffer.byteLength(JSON.stringify(result.result.metadata), "utf8")).toBeLessThanOrEqual(512_000);
});

test("bounds context metadata updates before event persistence and desktop IPC", async () => {
  const hugeMetadata = "\u0000".repeat(5 * 1024 * 1024);
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    name: "metadata_update",
    description: "Publishes hostile progress metadata and completes.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async (_input, context) => {
      await context.metadata({ metadata: { payload: hugeMetadata, useful: "kept" } });
      return { title: "metadata update", output: "done" };
    },
  }, events);

  const result = await executor.execute(toolInput("metadata_update"));
  expect(result.status).toBe("completed");
  const update = events.find(
    (event): event is Extract<ChiliEvent, { type: "tool.call_updated" }> =>
      event.type === "tool.call_updated" && event.payload.metadata !== undefined,
  );
  expect(update?.payload.metadata).toMatchObject({ useful: "kept" });
  expect(Buffer.byteLength(JSON.stringify(update?.payload.metadata), "utf8")).toBeLessThanOrEqual(512_000);
  expect(Buffer.byteLength(JSON.stringify(update), "utf8")).toBeLessThan(520_000);
  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  expect(() => parseDesktopEvent({ type: "runtime.event", event: update })).not.toThrow();
});

test("normalizes only diagnostic tool metadata while preserving aliases and ordinary content", async () => {
  const directSecret = "DIRECT_METADATA_SECRET_123";
  const reasonSecret = "REASON_METADATA_SECRET_123";
  const failureSecret = "FAILURE_METADATA_SECRET_123";
  const feedbackSecret = "FEEDBACK_METADATA_SECRET_123";
  const getterSecret = "GETTER_METADATA_SECRET_123";
  const ordinaryFeedback = "password=ordinary-feedback-kept";
  const ordinaryContent = "client_secret=ordinary-content-kept";
  const hugeDiagnostic = `password=${directSecret}${"\u0000".repeat(5 * 1024 * 1024)}`;
  const shared = { feedback: ordinaryFeedback, useful: "shared alias" };
  const sharedDiagnostic = { feedback: `Bearer ${feedbackSecret}` };
  const cycle: Record<string, unknown> = { useful: "cycle root" };
  cycle.self = cycle;
  const throwingGetter = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(throwingGetter, "error", {
    enumerable: true,
    get() {
      throw new Error(`password=${getterSecret}`);
    },
  });
  const makeMetadata = () => ({
    error: hugeDiagnostic,
    nested: { reason: `token=${reasonSecret}` },
    "failure reason": `client_secret=${failureSecret}`,
    diagnostics: {
      first: sharedDiagnostic,
      second: sharedDiagnostic,
    },
    feedback: ordinaryFeedback,
    ordinary: { content: ordinaryContent, feedback: ordinaryFeedback },
    firstAlias: shared,
    secondAlias: shared,
    cycle,
    throwingGetter,
  });
  const events: ChiliEvent[] = [];
  const executor = createExecutor({
    name: "diagnostic_metadata",
    description: "Publishes and returns diagnostic metadata.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async (_input, context) => {
      await context.metadata({ metadata: makeMetadata() });
      return {
        title: "diagnostic metadata",
        output: ordinaryContent,
        content: [{ type: "text" as const, text: ordinaryContent }],
        metadata: makeMetadata(),
      };
    },
  }, events);

  const result = await executor.execute(toolInput("diagnostic_metadata"));
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  const update = events.find(
    (event): event is Extract<ChiliEvent, { type: "tool.call_updated" }> =>
      event.type === "tool.call_updated" && event.payload.metadata !== undefined,
  );
  const updateMetadata = update?.payload.metadata;
  const resultMetadata = result.result.metadata;
  expect(updateMetadata).toBeDefined();
  expect(resultMetadata).toBeDefined();
  if (!updateMetadata || !resultMetadata) return;

  for (const metadata of [updateMetadata, resultMetadata]) {
    const serialized = JSON.stringify(metadata);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(512_000);
    expect(serialized).toContain("[REDACTED]");
    for (const secret of [directSecret, reasonSecret, failureSecret, feedbackSecret, getterSecret]) {
      expect(serialized).not.toContain(secret);
    }
    expect(Reflect.get(metadata, "feedback")).toBe(ordinaryFeedback);
    expect(Reflect.get(metadata, "ordinary")).toEqual({
      content: ordinaryContent,
      feedback: ordinaryFeedback,
    });
    expect(Reflect.get(metadata, "firstAlias")).toEqual({
      feedback: ordinaryFeedback,
      useful: "shared alias",
    });
    expect(Reflect.get(metadata, "secondAlias")).toEqual(Reflect.get(metadata, "firstAlias"));
    expect(JSON.stringify(Reflect.get(metadata, "secondAlias"))).not.toContain("circular metadata");
    expect(JSON.stringify(Reflect.get(metadata, "cycle"))).toContain("circular metadata");
    expect(JSON.stringify(Reflect.get(metadata, "throwingGetter"))).toContain("getter threw");
  }
  expect(result.result.output).toBe(ordinaryContent);
  expect(result.result.content).toEqual([{ type: "text", text: ordinaryContent }]);

  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  expect(Buffer.byteLength(JSON.stringify(update), "utf8")).toBeLessThan(520_000);
  expect(() => parseDesktopEvent({ type: "runtime.event", event: update })).not.toThrow();
});

test("allowlists successful ToolResult fields and drops arbitrary enumerable payloads", async () => {
  const secret = "EXTRA_FIELD_SECRET_".repeat(300_000);
  const executor = createExecutor({
    name: "extra_result_field",
    description: "Returns an undeclared field.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "safe", output: "done", extraPayload: secret }),
  });

  const result = await executor.execute(toolInput("extra_result_field"));
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(Reflect.has(result.result, "extraPayload")).toBe(false);
  expect(JSON.stringify(result.result)).not.toContain("EXTRA_FIELD_SECRET_");
});

test("bounds artifact ids by type, UTF-8 bytes, count, and serialized aggregate size", async () => {
  const hugeId = "制".repeat(500_000);
  const invalidIds = [" __proto__ ", " constructor ", " prototype ", "artifact\u0000control"];
  const artifactIds = [hugeId, 42, ...invalidIds, ...Array.from({ length: 100 }, (_, index) => `artifact_${index}`)];
  const executor = createExecutor({
    name: "huge_artifact_ids",
    description: "Returns hostile artifact ids.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({ title: "artifacts", output: "done", artifactIds: artifactIds as never }),
  });

  const result = await executor.execute(toolInput("huge_artifact_ids"));
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(result.result.artifactIds?.length).toBeLessThanOrEqual(64);
  expect(result.result.artifactIds?.every((id) => typeof id === "string")).toBe(true);
  expect(result.result.artifactIds?.every((id) => id.length <= 512)).toBe(true);
  expect(result.result.artifactIds).not.toContain(hugeId);
  expect(result.result.artifactIds?.some((id) => invalidIds.includes(id))).toBe(false);
  expect(result.result.artifactIds?.some((id) => id.includes("artifact id truncated"))).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(result.result.artifactIds), "utf8")).toBeLessThanOrEqual(64_000);

  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { parseDesktopEvent } = await import(contractsModulePath) as {
    parseDesktopEvent(value: unknown): unknown;
  };
  expect(() => parseDesktopEvent({
    type: "runtime.event",
    event: {
      id: "event_artifact_ids",
      type: "message.part_added",
      time: 1,
      sessionId: "session_artifact_ids",
      payload: {
        messageId: "message_artifact_ids",
        part: {
          id: "part_artifact_ids",
          messageId: "message_artifact_ids",
          sessionId: "session_artifact_ids",
          type: "tool_result",
          callId: "toolcall_artifact_ids",
          output: "done",
          artifactIds: result.result.artifactIds,
        },
      },
    },
  })).not.toThrow();
});

test("bounds content by actual serialized JSON bytes for escape-heavy text", async () => {
  const escapedText = "\u0000".repeat(4_000_000);
  const escapedOutput = "\\".repeat(256_000);
  const escapedArtifactId = "\\\"".repeat(256);
  const executor = createExecutor({
    name: "escaped_content",
    description: "Returns JSON-expensive text content.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({
      title: "escaped",
      output: escapedOutput,
      content: [{ type: "text" as const, text: escapedText }],
      artifactIds: Array.from({ length: 100 }, () => escapedArtifactId as never),
    }),
  });

  const result = await executor.execute(toolInput("escaped_content"));
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(result.result.output).toBe(escapedOutput);
  expect(Buffer.byteLength(JSON.stringify(result.result.content), "utf8")).toBeLessThanOrEqual(1_250_000);
  expect(Buffer.byteLength(JSON.stringify(result.result.content?.[0]), "utf8")).toBeLessThanOrEqual(1_250_000);
  expect(Buffer.byteLength(JSON.stringify(result.result.artifactIds), "utf8")).toBeLessThanOrEqual(64_000);
  expect(result.result.metadata).toMatchObject({
    contentTruncated: true,
    contentLimitBytes: 1_250_000,
  });

  const messagePartAdded = {
    id: "event_escape_heavy_tool_result",
    type: "message.part_added",
    time: 1,
    sessionId: "session_content_limit",
    payload: {
      messageId: "message_escape_heavy_tool_result",
      part: {
        id: "part_escape_heavy_tool_result",
        messageId: "message_escape_heavy_tool_result",
        sessionId: "session_content_limit",
        type: "tool_result",
        callId: "toolcall_escaped_content",
        output: result.result.output,
        content: result.result.content,
        artifactIds: result.result.artifactIds,
        executionContext: {
          sandbox: "macos-seatbelt",
          executionMode: "sandboxed",
          exitCode: 0,
          timedOut: false,
          aborted: false,
          signal: null,
        },
      },
    },
  };
  const eventBytes = Buffer.byteLength(JSON.stringify(messagePartAdded), "utf8");
  expect(eventBytes).toBeGreaterThan(1_750_000);
  expect(eventBytes).toBeLessThan(2_000_000);

  const messageCreated = {
    id: "event_escape_heavy_message_created",
    type: "message.created",
    time: 1,
    sessionId: "session_content_limit",
    payload: {
      messageId: "message_escape_heavy_tool_result",
      role: "assistant",
    },
  };
  const approvalRow = (index: number, metadataChars: number) => ({
    id: `approval_escape_heavy_${String(index).padStart(4, "0")}`,
    sessionId: "session_content_limit",
    permission: "P".repeat(512),
    patterns: ["X".repeat(2_000)],
    maxApprovalScope: "persistent",
    metadata: { note: "M".repeat(metadataChars) },
    createdAt: index + 1,
  });
  const pendingApprovals: ReturnType<typeof approvalRow>[] = [];
  let pendingApprovalBytes = 2;
  for (let index = 0; index < 2_000; index += 1) {
    const row = approvalRow(index, 15_000);
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    expect(rowBytes).toBeLessThanOrEqual(64_000);
    const extraBytes = rowBytes + (pendingApprovals.length > 0 ? 1 : 0);
    if (pendingApprovalBytes + extraBytes > 1_000_000) break;
    pendingApprovals.push(row);
    pendingApprovalBytes += extraBytes;
  }
  let low = 0;
  let high = 15_000;
  const finalIndex = pendingApprovals.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const rowBytes = Buffer.byteLength(JSON.stringify(approvalRow(finalIndex, middle)), "utf8");
    const extraBytes = rowBytes + (pendingApprovals.length > 0 ? 1 : 0);
    if (pendingApprovalBytes + extraBytes <= 1_000_000) low = middle;
    else high = middle - 1;
  }
  const finalApproval = approvalRow(finalIndex, low);
  const finalApprovalBytes = Buffer.byteLength(JSON.stringify(finalApproval), "utf8")
    + (pendingApprovals.length > 0 ? 1 : 0);
  if (pendingApprovalBytes + finalApprovalBytes <= 1_000_000) {
    pendingApprovals.push(finalApproval);
    pendingApprovalBytes += finalApprovalBytes;
  }
  expect(pendingApprovalBytes).toBe(Buffer.byteLength(JSON.stringify(pendingApprovals), "utf8"));
  expect(pendingApprovalBytes).toBeGreaterThan(997_000);
  expect(pendingApprovalBytes).toBeLessThanOrEqual(1_000_000);

  const replayEvents = [messageCreated, messagePartAdded];
  const replayWindow = {
    events: replayEvents,
    pendingApprovals,
    truncated: true,
    bytes: Buffer.byteLength(JSON.stringify(replayEvents), "utf8"),
    pinnedEventIds: [messagePartAdded.id],
    warning: "W".repeat(2_000),
  };
  expect(Buffer.byteLength(JSON.stringify(replayWindow), "utf8")).toBeLessThanOrEqual(4_000_000);

  const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
  const { desktopJsonUtf8Bytes, parseDesktopEvent, parseDesktopEventEnvelope } = await import(contractsModulePath) as {
    desktopJsonUtf8Bytes(value: unknown): number;
    parseDesktopEvent(value: unknown): unknown;
    parseDesktopEventEnvelope(value: unknown): unknown;
  };
  const desktopEvent = { type: "runtime.event", event: messagePartAdded };
  const desktopEnvelope = {
    version: 1,
    streamId: "stream_escape_heavy_tool_result",
    sequence: Number.MAX_SAFE_INTEGER,
    event: desktopEvent,
  };
  expect(desktopJsonUtf8Bytes(desktopEnvelope)).toBeLessThan(2_000_000);
  expect(() => parseDesktopEvent(desktopEvent)).not.toThrow();
  expect(() => parseDesktopEventEnvelope(desktopEnvelope)).not.toThrow();
});

test("hard-caps and persists escape-heavy activate_skill output despite its Infinity override", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-activate-skill-wire-limit-"));
  try {
    const skillBaseDir = join(workspace, ".chili", "skills", "hostile-skill");
    await mkdir(skillBaseDir, { recursive: true });
    const hugeBody = "\u0000".repeat(5 * 1024 * 1024);
    const skill = {
      name: "hostile-skill",
      source: "project" as const,
      filePath: join(skillBaseDir, "SKILL.md"),
      baseDir: skillBaseDir,
      metadata: { name: "hostile-skill", description: "Escape-heavy skill." },
      body: hugeBody,
    };
    const activateSkill = createActivateSkillTool({
      get: (name) => name === skill.name ? skill : undefined,
      list: () => [{
        name: skill.name,
        description: skill.metadata.description,
        source: skill.source,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
      }],
    });
    expect(activateSkill.maxResultOutputBytes).toBe(Infinity);
    const registry = new InMemoryToolRegistry();
    registry.register(activateSkill);
    const events: ChiliEvent[] = [];
    const executor = new ToolExecutor({
      registry,
      events: { publish: async (event) => { events.push(event); } },
      approvals: { decide: async () => ({ action: "allow_once" }) },
      maxPersistedOutputBytes: 6 * 1024 * 1024,
      createId: (prefix) => `${prefix}_activate_skill_wire_limit`,
      now: () => 1 as TimestampMs,
    });

    const result = await executor.execute({
      ...toolInput("activate_skill"),
      input: { name: skill.name },
      cwd: workspace,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(Buffer.byteLength(result.result.output, "utf8")).toBeLessThanOrEqual(280_000);
    expect(result.result.output).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
    expect(result.result.output).toContain("\\u0000");
    expect(result.result.metadata).toMatchObject({
      outputTruncated: true,
      outputLimitBytes: 256_000,
      outputPersistedTruncated: false,
    });
    const outputPath = result.result.metadata?.outputPath;
    expect(typeof outputPath).toBe("string");
    if (typeof outputPath !== "string") return;
    const persisted = await readFile(join(workspace, outputPath), "utf8");
    expect(Buffer.byteLength(persisted, "utf8")).toBeGreaterThan(5 * 1024 * 1024);
    expect(persisted).toContain("\u0000".repeat(1_024));

    const finished = events.find(
      (event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> => event.type === "tool.call_finished",
    );
    expect(finished?.payload.output).toBe(result.result.output);
    const desktopFinished = { type: "runtime.event", event: finished };
    const desktopToolResult = {
      type: "runtime.event",
      event: {
        id: "event_activate_skill_tool_result",
        type: "message.part_added",
        time: 1,
        sessionId: "session_content_limit",
        payload: {
          messageId: "message_activate_skill_tool_result",
          part: {
            id: "part_activate_skill_tool_result",
            messageId: "message_activate_skill_tool_result",
            sessionId: "session_content_limit",
            type: "tool_result",
            callId: "toolcall_activate_skill",
            output: result.result.output,
          },
        },
      },
    };
    const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
    const { desktopJsonUtf8Bytes, parseDesktopEvent } = await import(contractsModulePath) as {
      desktopJsonUtf8Bytes(value: unknown): number;
      parseDesktopEvent(value: unknown): unknown;
    };
    expect(desktopJsonUtf8Bytes(desktopFinished)).toBeLessThan(12_000_000);
    expect(desktopJsonUtf8Bytes(desktopToolResult)).toBeLessThan(12_000_000);
    expect(() => parseDesktopEvent(desktopFinished)).not.toThrow();
    expect(() => parseDesktopEvent(desktopToolResult)).not.toThrow();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("normalizes publisher failures without recursively publishing a terminal event", async () => {
  for (const phase of ["started", "terminal-failed", "terminal-success"] as const) {
    const bearerToken = `publisher-secret-${phase}`;
    const loopbackUrl = `http://127.0.0.1:49152/private/${phase}?token=url-secret-${phase}`;
    const message = `Publisher failed: Bearer ${bearerToken} via ${loopbackUrl}\n`
      + "错".repeat(Math.ceil((5 * 1024 * 1024) / 3));
    const source = Object.assign(new Error(message), {
      name: "RemotePublisherError",
      code: "E_PUBLISHER",
      cause: { bearerToken, loopbackUrl },
    });
    const attemptedEvents: ChiliEvent[] = [];
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: `publisher_${phase}`,
      description: "Exercises an event publisher failure boundary.",
      risk: "read",
      inputSchema: { type: "object" },
      approval: () => false,
      execute: async () => {
        if (phase === "terminal-failed") throw new Error("ordinary tool failure");
        return { title: "publisher", output: "done" };
      },
    });
    const executor = new ToolExecutor({
      registry,
      events: {
        publish: async (event) => {
          attemptedEvents.push(event);
          if (
            (phase === "started" && event.type === "tool.call_started")
            || (phase === "terminal-failed"
              && event.type === "tool.call_finished"
              && event.payload.status === "failed")
            || (phase === "terminal-success"
              && event.type === "tool.call_finished"
              && event.payload.status === "completed")
          ) {
            throw source;
          }
        },
      },
      approvals: { decide: async () => ({ action: "allow_once" }) },
      createId: (prefix) => `${prefix}_publisher_${phase}`,
      now: () => 1 as TimestampMs,
    });

    let rejection: unknown;
    try {
      await executor.execute(toolInput(`publisher_${phase}`));
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBe(source);
    const normalized = rejection as Error & {
      code?: string;
      cause?: unknown;
      persistedErrorDetails?: { truncated?: true; originalMessageBytes?: number };
    };
    expect(normalized.name).toBe("RemotePublisherError");
    expect(normalized.code).toBe("E_PUBLISHER");
    expect(normalized.cause).toBeUndefined();
    expect(normalized.message).not.toContain(bearerToken);
    expect(normalized.message).not.toContain(loopbackUrl);
    expect(normalized.message).toContain("Bearer [REDACTED]");
    expect(normalized.message).toContain("[loopback URL redacted]");
    expect(Buffer.byteLength(normalized.message, "utf8"))
      .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    expect(normalized.persistedErrorDetails).toMatchObject({
      truncated: true,
      originalMessageBytes: Buffer.byteLength(message, "utf8"),
    });

    const terminalAttempts = attemptedEvents.filter((event) => event.type === "tool.call_finished");
    expect(terminalAttempts).toHaveLength(phase === "started" ? 0 : 1);
    if (phase === "terminal-failed") {
      expect(terminalAttempts[0]?.payload.status).toBe("failed");
    }
    if (phase === "terminal-success") {
      expect(terminalAttempts[0]?.payload.status).toBe("completed");
    }
    const serializedEvents = JSON.stringify(attemptedEvents);
    expect(serializedEvents).not.toContain(bearerToken);
    expect(serializedEvents).not.toContain(loopbackUrl);
    expect(Buffer.byteLength(serializedEvents, "utf8")).toBeLessThan(1_000_000);
  }
});

function createExecutor(tool: ChiliToolDefinition, events: ChiliEvent[] = []): ToolExecutor {
  const registry = new InMemoryToolRegistry();
  registry.register(tool);
  return new ToolExecutor({
    registry,
    events: { publish: async (event) => { events.push(event); } },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    createId: (prefix) => `${prefix}_content_limit`,
    now: () => 1 as TimestampMs,
  });
}

function toolInput(toolName: string): ExecuteToolInput {
  return {
    sessionId: "session_content_limit" as SessionId,
    turnId: "turn_content_limit" as TurnId,
    callId: `toolcall_${toolName}` as ToolCallId,
    toolName,
    input: {},
    cwd: process.cwd(),
  };
}
