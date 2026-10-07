import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  PERSISTED_ERROR_LIMITS,
  type ChiliEvent,
  type MessageId,
  type MessagePart,
  type SessionId,
  type TimestampMs,
  type TurnId,
} from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import type { AgentRunner } from "./runner.js";
import type { ModelRouter, ModelStreamEvent } from "./runtime.js";
import { RuntimeService } from "./runtime-service.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

test("normalizes a hostile tool Error before return, SQLite persistence, and desktop IPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-tool-error-sinks-"));
  const databasePath = join(directory, "events.sqlite");
  const store = new SqliteEventStore(databasePath);
  const registry = new InMemoryToolRegistry();
  const secrets = {
    tab: "TAB_TOOL_SECRET",
    lineFeed: "LF_TOOL_SECRET",
    ansi: "ANSI_TOOL_SECRET",
    unicode: "秘密工具令牌",
    spaced: "alpha beta TOOL_TAIL_SECRET",
  };
  const rawMessage = [
    `pass\tword=${secrets.tab}`,
    `pass\nword=${secrets.lineFeed}`,
    `pass\u001b[31mword=${secrets.ansi}\u001b[0m`,
    `bEaReR ${secrets.unicode}`,
    `password=${secrets.spaced}`,
    "\u0000".repeat(5 * 1024 * 1024),
  ].join("\n");
  const cause: Record<string, unknown> = { secret: "CYCLIC_CAUSE_SECRET" };
  cause.self = cause;
  const source = new Error(rawMessage) as Error & { cause?: unknown };
  source.cause = cause;
  Object.defineProperty(source, "name", {
    configurable: true,
    get() { throw new Error("HOSTILE_NAME_GETTER_SECRET"); },
  });
  registry.register({
    name: "hostile_error",
    description: "Throws a hostile error.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => { throw source; },
  });
  let nextId = 0;
  const executor = new ToolExecutor({
    registry,
    events: { publish: (event) => store.append(event) },
    approvals: { decide: async () => ({ action: "allow_once" }) },
    createId: (prefix) => `${prefix}_tool_error_sinks_${++nextId}`,
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_tool_error_sinks" as SessionId;

  try {
    const result = await executor.execute({
      sessionId,
      turnId: "turn_tool_error_sinks" as TurnId,
      callId: "toolcall_tool_error_sinks" as never,
      toolName: "hostile_error",
      input: {},
      cwd: directory,
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).not.toBe(source);
    expect(result.error.name).toBe("Error");
    expect((result.error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(Buffer.byteLength(result.error.message, "utf8"))
      .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    expect(result.error.message).toContain("pass\tword=[REDACTED]");
    expect(result.error.message).toContain("pass\nword=[REDACTED]");
    expect(result.error.message).toContain("password=[REDACTED]");
    expect(result.error.message).toContain("bEaReR [REDACTED]");
    expect(result.error.message).not.toContain("[31m");
    expect(result.error.message).not.toContain("[0m");

    const events = await store.events({ sessionId, limit: 100 }) as ChiliEvent[];
    const finished = events.find(
      (event): event is Extract<ChiliEvent, { type: "tool.call_finished" }> =>
        event.type === "tool.call_finished" && event.payload.status === "failed",
    );
    expect(finished).toBeDefined();
    expect(finished?.payload.error).toBe(result.error.message);
    const serialized = JSON.stringify(events);
    for (const secret of [...Object.values(secrets), "CYCLIC_CAUSE_SECRET", "HOSTILE_NAME_GETTER_SECRET"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("[31m");

    const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
    const { parseDesktopEvent } = await import(contractsModulePath) as {
      parseDesktopEvent(value: unknown): unknown;
    };
    expect(() => parseDesktopEvent({ type: "runtime.event", event: finished })).not.toThrow();

    const database = new Database(databasePath, { readonly: true });
    try {
      const eventRow = database.query<{ payload_json: string; bytes: number }, []>(
        "select payload_json, length(cast(payload_json as blob)) as bytes from events where type = 'tool.call_finished' order by seq desc limit 1",
      ).get();
      const toolRow = database.query<{ error: string; bytes: number }, []>(
        "select error, length(cast(error as blob)) as bytes from tool_calls where status = 'failed' order by rowid desc limit 1",
      ).get();
      expect(eventRow?.bytes).toBeLessThan(20_000);
      expect(toolRow?.bytes).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
      // SQLite holds a content reference; the event API above reads the saved, sanitized body.
      expect(toolRow?.error).toContain("$chiliContent");
      expect(toolRow?.error).not.toBe(result.error.message);
      for (const secret of [...Object.values(secrets), "CYCLIC_CAUSE_SECRET", "HOSTILE_NAME_GETTER_SECRET"]) {
        expect(eventRow?.payload_json).not.toContain(secret);
        expect(toolRow?.error).not.toContain(secret);
      }
      expect(eventRow?.payload_json).not.toContain("[31m");
      expect(toolRow?.error).not.toContain("[31m");
    } finally {
      database.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps a 5 MiB tool Error bounded through executor, runtime, SQLite events, and projections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-runtime-error-limit-"));
  const databasePath = join(directory, "events.sqlite");
  const store = new SqliteEventStore(databasePath);
  const registry = new InMemoryToolRegistry();
  const bearerToken = "sqlite-secret-token._~+/==";
  const loopbackUrl = "http://127.0.0.1:47832/private/runtime?token=sqlite-url-secret";
  const hugeMessage = `Runtime tool failed with Bearer ${bearerToken} at ${loopbackUrl}\n`
    + "错".repeat(Math.ceil((5 * 1024 * 1024) / 3));
  const source = Object.assign(new Error(hugeMessage), {
    name: "RemoteProcessError",
    code: "E_PROCESS_REMOTE",
    cause: { stderr: hugeMessage },
  });
  registry.register({
    name: "explode",
    description: "Reject with a very large process error.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => { throw source; },
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call", name: "explode", input: {} };
      yield { type: "finish", reason: "tool_use" };
    },
  };
  let nextId = 0;
  const createId = (prefix: string) => `${prefix}_error_limit_${++nextId}`;
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
      createId,
      now: () => 1 as TimestampMs,
    }),
    createId,
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_error_limit" as SessionId;

  try {
    await runtime.createSession({ sessionId, cwd: directory });
    const result = await runtime.runTurn({ sessionId, cwd: directory });
    expect(result.status).toBe("completed");

    const events = await store.events({ sessionId, limit: 100 }) as ChiliEvent[];
    const finished = events.find(
      (event) => event.type === "tool.call_finished" && event.payload.status === "failed",
    );
    expect(finished?.type).toBe("tool.call_finished");
    if (!finished || finished.type !== "tool.call_finished") return;
    expect(finished.payload.callId).not.toBe(finished.payload.providerCallId);
    expect(Buffer.byteLength(finished.payload.error ?? "", "utf8"))
      .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    expect(finished.payload.error).not.toContain("\uFFFD");
    expect(finished.payload.error).not.toContain(bearerToken);
    expect(finished.payload.error).not.toContain(loopbackUrl);
    expect(finished.payload.errorDetails).toMatchObject({
      name: "RemoteProcessError",
      code: "E_PROCESS_REMOTE",
      truncated: true,
    });

    const messages = await store.messages(sessionId);
    const projectedPart = messages
      .flatMap((message) => message.parts)
      .find((part): part is Extract<MessagePart, { type: "tool_result" }> => part.type === "tool_result");
    expect(projectedPart).toBeDefined();
    expect(Buffer.byteLength(projectedPart?.error ?? "", "utf8"))
      .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    expect(projectedPart?.error).not.toContain("\uFFFD");

    const database = new Database(databasePath, { readonly: true });
    try {
      const eventRows = database.query<{ payload_json: string; bytes: number }, []>(
        "select payload_json, length(cast(payload_json as blob)) as bytes from events where type in ('tool.call_finished', 'message.part_added')",
      ).all();
      expect(eventRows.length).toBeGreaterThanOrEqual(2);
      expect(eventRows.every((row) => row.bytes < 20_000)).toBe(true);
      expect(eventRows.every((row) => !row.payload_json.includes("\uFFFD"))).toBe(true);
      expect(eventRows.every((row) => !row.payload_json.includes(bearerToken))).toBe(true);
      expect(eventRows.every((row) => !row.payload_json.includes(loopbackUrl))).toBe(true);

      const toolRow = database.query<{ error: string; bytes: number }, []>(
        "select error, length(cast(error as blob)) as bytes from tool_calls where status = 'failed'",
      ).get();
      expect(toolRow?.bytes).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
      expect(toolRow?.error).not.toContain("\uFFFD");
      expect(toolRow?.error).not.toContain(bearerToken);
      expect(toolRow?.error).not.toContain(loopbackUrl);

      const partRow = database.query<{ data_json: string; bytes: number }, []>(
        "select data_json, length(cast(data_json as blob)) as bytes from message_parts where type = 'tool_result'",
      ).get();
      expect(partRow?.bytes).toBeLessThan(18_000);
      expect(partRow?.data_json).not.toContain("\uFFFD");
      expect(partRow?.data_json).not.toContain(bearerToken);
      expect(partRow?.data_json).not.toContain(loopbackUrl);
    } finally {
      database.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounds successful provider diagnostics before run results, SQLite, session events, and desktop IPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-runtime-success-diagnostics-"));
  const databasePath = join(directory, "events.sqlite");
  const store = new SqliteEventStore(databasePath);
  const registry = new InMemoryToolRegistry();
  const finishSecret = "FINISH_REASON_SECRET";
  const providerSecret = "PROVIDER_METADATA_SECRET";
  const modelSecret = "MODEL_METADATA_SECRET";
  const usageSecret = "USAGE_RAW_SECRET";
  const hugeEscaped = "\u0000".repeat(5 * 1024 * 1024);
  const hostileResponseId = hugeEscaped;
  const assistantText = "Ordinary assistant content may discuss password=ordinary and must remain unchanged.";
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield {
        type: "metadata",
        provider: `Bearer ${providerSecret}\n${hugeEscaped}`,
        model: `client_secret=${modelSecret}\n${hugeEscaped}`,
        responseId: hostileResponseId,
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
          raw: { error: `password=${usageSecret}`, payload: hugeEscaped },
        },
      };
      yield { type: "text_delta", text: assistantText };
      yield {
        type: "finish",
        reason: `password=${finishSecret}\n${hugeEscaped}`,
        responseId: hostileResponseId,
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          totalTokens: 10,
          raw: { error: `token=${usageSecret}`, payload: hugeEscaped },
        },
      };
    },
  };
  let nextId = 0;
  const createId = (prefix: string) => `${prefix}_success_diagnostics_${++nextId}`;
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
      createId,
      now: () => 1 as TimestampMs,
    }),
    createId,
    now: () => 1 as TimestampMs,
  });
  const service = new RuntimeService({ runtime, store, cwd: directory, createId, now: () => 1 as TimestampMs });
  const sessionId = "session_success_diagnostics" as SessionId;

  try {
    await service.createSession({ sessionId, cwd: directory });
    const result = await service.submitPrompt({ sessionId, text: "run the model", cwd: directory });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.finishReason).toContain("password=[REDACTED]");
    expect(result.finishReason).not.toContain(finishSecret);
    expect(Buffer.byteLength(result.finishReason ?? "", "utf8"))
      .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    const completedTurn = result.turns.at(-1);
    expect(completedTurn?.status).toBe("completed");
    if (completedTurn?.status === "completed") {
      expect(completedTurn.finishReason).toBe(result.finishReason);
      expect(completedTurn.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    }

    const events = await store.events({ sessionId, limit: 100 }) as ChiliEvent[];
    const metadataEvents = events.filter(
      (event): event is Extract<ChiliEvent, { type: "turn.model_metadata" }> =>
        event.type === "turn.model_metadata",
    );
    expect(metadataEvents.length).toBeGreaterThanOrEqual(2);
    for (const event of metadataEvents) {
      expect(event.payload.responseId).toBeUndefined();
      expect(event.payload.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
      expect(event.payload.usage?.raw).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(20_000);
    }
    const terminal = events.findLast(
      (event): event is Extract<ChiliEvent, { type: "session.status_changed" }> =>
        event.type === "session.status_changed" && event.payload.status === "idle",
    );
    expect(terminal?.payload.reason).toBe(result.finishReason);
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn.completed",
      payload: expect.objectContaining({ status: "completed" }),
    }));
    const serializedEvents = JSON.stringify(events);
    for (const secret of [finishSecret, providerSecret, modelSecret, usageSecret]) {
      expect(serializedEvents).not.toContain(secret);
    }
    expect(serializedEvents).toContain(assistantText);

    const contractsModulePath = "../../../apps/desktop/src/shared/contracts.ts";
    const { parseDesktopEvent } = await import(contractsModulePath) as {
      parseDesktopEvent(value: unknown): unknown;
    };
    for (const event of events.filter((candidate) =>
      candidate.type === "turn.model_metadata"
      || candidate.type === "turn.completed"
      || candidate.type === "session.status_changed"
    )) {
      expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(120_000);
      expect(() => parseDesktopEvent({ type: "runtime.event", event })).not.toThrow();
    }

    const database = new Database(databasePath, { readonly: true });
    try {
      const rows = database.query<{ payload_json: string; bytes: number }, []>(
        "select payload_json, length(cast(payload_json as blob)) as bytes from events where type in ('turn.model_metadata', 'turn.completed', 'session.status_changed')",
      ).all();
      expect(rows.length).toBeGreaterThanOrEqual(4);
      expect(rows.every((row) => row.bytes < 120_000)).toBe(true);
      for (const secret of [finishSecret, providerSecret, modelSecret, usageSecret]) {
        expect(rows.every((row) => !row.payload_json.includes(secret))).toBe(true);
      }
    } finally {
      database.close();
    }
  } finally {
    await service.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes a hostile custom runner finish reason before return, events, and SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-runtime-runner-finish-reason-"));
  const databasePath = join(directory, "events.sqlite");
  const store = new SqliteEventStore(databasePath);
  const sessionId = "session_runner_finish_reason" as SessionId;
  const secret = "CUSTOM_RUNNER_FINISH_SECRET";
  const rawFinishReason = `password=${secret}\n${"\u0000".repeat(5 * 1024 * 1024)}`;
  let nextId = 0;
  const createId = (prefix: string) => `${prefix}_runner_finish_reason_${++nextId}`;
  const runner: AgentRunner = {
    async createSession(input) {
      return input.sessionId ?? sessionId;
    },
    async appendUserMessage() {
      return "message_runner_finish_reason_user" as MessageId;
    },
    async runTurn(input) {
      return {
        status: "completed",
        turnId: input.turnId ?? "turn_runner_finish_reason" as TurnId,
        assistantMessageId: "message_runner_finish_reason_assistant" as MessageId,
        finishReason: rawFinishReason,
      };
    },
  };
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: directory,
    createId,
    now: () => 1 as TimestampMs,
  });

  try {
    await store.append({
      id: "event_runner_finish_reason_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: directory },
    });

    const result = await service.submitPrompt({ sessionId, text: "run custom runner", cwd: directory });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.finishReason).toContain("password=[REDACTED]");
    expect(result.finishReason).not.toContain(secret);
    expect(result.finishReason).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
    expect(Buffer.byteLength(result.finishReason ?? "", "utf8"))
      .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);

    const events = await store.events({ sessionId, limit: 100 }) as ChiliEvent[];
    const terminal = events.findLast(
      (event): event is Extract<ChiliEvent, { type: "session.status_changed" }> =>
        event.type === "session.status_changed" && event.payload.status === "idle",
    );
    expect(terminal?.payload.reason).toBe(result.finishReason);
    expect(JSON.stringify(events)).not.toContain(secret);

    const database = new Database(databasePath, { readonly: true });
    try {
      const row = database.query<{ payload_json: string; bytes: number }, []>(
        "select payload_json, length(cast(payload_json as blob)) as bytes from events where type = 'session.status_changed' order by seq desc limit 1",
      ).get();
      expect(row?.payload_json).toContain("password=[REDACTED]");
      expect(row?.payload_json).not.toContain(secret);
      expect(row?.bytes).toBeLessThan(20_000);
    } finally {
      database.close();
    }
  } finally {
    await service.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes a Proxy-wrapped 5 MiB model Error before usage, mutation, return, and persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-runtime-proxy-error-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const registry = new InMemoryToolRegistry();
  const hugeMessage = "代".repeat(Math.ceil((5 * 1024 * 1024) / 3));
  const source = Object.assign(new Error(hugeMessage), {
    name: "ProxyProviderError",
    code: "E_PROXY_PROVIDER",
    cause: { secret: "PROXY_CAUSE_SECRET" },
  });
  const hostile = new Proxy(source, {
    get(target, key, receiver) {
      if (typeof key === "symbol") throw new Error("symbol getter trap");
      return Reflect.get(target, key, receiver);
    },
    deleteProperty() {
      throw new Error("delete trap");
    },
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call_start", toolCallId: "tool_proxy_error", name: "never_runs" };
      yield { type: "error", error: hostile };
    },
  };
  const runtime = createRuntime(store, registry, model);
  const sessionId = "session_proxy_error" as SessionId;

  try {
    await runtime.createSession({ sessionId, cwd: directory });
    const result = await runtime.runTurn({ sessionId, cwd: directory });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.error).not.toBe(hostile);
    expect(result.error.name).toBe("ProxyProviderError");
    expect((result.error as Error & { code?: string }).code).toBe("E_PROXY_PROVIDER");
    expect((result.error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(Buffer.byteLength(result.error.message, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    const events = await store.events({ sessionId, limit: 100 }) as ChiliEvent[];
    const finished = events.find(
      (event) => event.type === "tool.call_finished" && event.payload.providerCallId === "tool_proxy_error",
    );
    expect(finished?.type).toBe("tool.call_finished");
    if (!finished || finished.type !== "tool.call_finished") return;
    expect(finished.payload.callId).not.toBe(finished.payload.providerCallId);
    expect(Buffer.byteLength(finished.payload.error ?? "", "utf8"))
      .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    expect(JSON.stringify(events)).not.toContain("PROXY_CAUSE_SECRET");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not copy credential-bearing provider classification text onto returned Errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-runtime-error-tag-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const registry = new InMemoryToolRegistry();
  const bearerToken = "RETURNED_REASON_SECRET123";
  const loopbackUrl = "http://localhost:47832/private?token=RETURNED_URL_SECRET123";
  const source = Object.assign(new Error("Provider request failed"), {
    name: "ProviderError",
    code: "E_PROVIDER",
    reason: `Bearer ${bearerToken} via ${loopbackUrl}`,
    category: "network_error",
  });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "error", error: source };
    },
  };
  const runtime = createRuntime(store, registry, model);
  const sessionId = "session_error_tag" as SessionId;

  try {
    await runtime.createSession({ sessionId, cwd: directory });
    const result = await runtime.runTurn({ sessionId, cwd: directory });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect((result.error as Error & { reason?: string }).reason).toBeUndefined();
    expect((result.error as Error & { category?: string }).category).toBeUndefined();
    const serialized = JSON.stringify(result.error);
    expect(serialized).not.toContain(bearerToken);
    expect(serialized).not.toContain(loopbackUrl);
    expect(serialized).not.toContain("RETURNED_URL_SECRET123");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats an aborted signal with a 5 MiB non-AbortError reason as a bounded cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-runtime-signal-error-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const registry = new InMemoryToolRegistry();
  const controller = new AbortController();
  const hugeMessage = "停".repeat(Math.ceil((5 * 1024 * 1024) / 3));
  const source = Object.assign(new Error(hugeMessage), {
    name: "RemoteCancelError",
    code: "E_REMOTE_CANCEL",
  });
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const model: ModelRouter = {
    async *stream(input): AsyncIterable<ModelStreamEvent> {
      yield { type: "tool_call_start", toolCallId: "tool_signal_cancel", name: "never_runs" };
      startedResolve?.();
      await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw input.signal?.reason;
    },
  };
  const runtime = createRuntime(store, registry, model);
  const sessionId = "session_signal_cancel" as SessionId;

  try {
    await runtime.createSession({ sessionId, cwd: directory });
    const running = runtime.runTurn({ sessionId, cwd: directory, signal: controller.signal });
    await started;
    controller.abort(source);
    const result = await running;
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") return;
    expect(result.error.name).toBe("AbortError");
    expect((result.error as Error & { code?: string }).code).toBe("E_REMOTE_CANCEL");
    expect(Buffer.byteLength(result.error.message, "utf8")).toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    const events = await store.events({ sessionId, limit: 100 }) as ChiliEvent[];
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn.completed",
      payload: expect.objectContaining({ status: "cancelled" }),
    }));
    const finished = events.find(
      (event) => event.type === "tool.call_finished" && event.payload.providerCallId === "tool_signal_cancel",
    );
    expect(finished?.type).toBe("tool.call_finished");
    if (finished?.type === "tool.call_finished") {
      expect(finished.payload.callId).not.toBe(finished.payload.providerCallId);
      expect(finished.payload.status).toBe("cancelled");
      expect(Buffer.byteLength(finished.payload.error ?? "", "utf8"))
        .toBeLessThanOrEqual(PERSISTED_ERROR_LIMITS.messageBytes);
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not persist completed compaction after a signal-ignoring compactor reaches EOF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-runtime-compaction-abort-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const registry = new InMemoryToolRegistry();
  const controller = new AbortController();
  let eofGateResolve: (() => void) | undefined;
  const eofGate = new Promise<void>((resolve) => { eofGateResolve = resolve; });
  let releaseEofResolve: (() => void) | undefined;
  const releaseEof = new Promise<void>((resolve) => { releaseEofResolve = resolve; });
  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: "text_delta", text: "<context_summary>bounded summary</context_summary>" };
      eofGateResolve?.();
      await releaseEof;
      return;
    },
  };
  let nextId = 0;
  const createId = (prefix: string) => `${prefix}_compaction_abort_${++nextId}`;
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
      createId,
      now: () => 1 as TimestampMs,
    }),
    contextCompaction: { verifySummary: false },
    createId,
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_compaction_abort" as SessionId;

  try {
    await runtime.createSession({ sessionId, cwd: directory });
    await runtime.appendUserMessage({ sessionId, text: "message to compact" });
    const compacting = runtime.compactContext({ sessionId, signal: controller.signal });
    await eofGate;
    controller.abort(new Error("shutdown during compaction"));
    releaseEofResolve?.();
    const result = await compacting;
    expect(result.status).toBe("cancelled");
    const events = await store.events({ sessionId, limit: 100 }) as ChiliEvent[];
    expect(events.some((event) => event.type === "turn.compaction_completed")).toBe(false);
    expect(events.some(
      (event) => event.type === "turn.completed" && event.payload.status === "completed",
    )).toBe(false);
    expect(events.some(
      (event) => event.type === "turn.completed" && event.payload.status === "cancelled",
    )).toBe(true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function createRuntime(
  store: SqliteEventStore,
  registry: InMemoryToolRegistry,
  model: ModelRouter,
): SingleAgentRuntime {
  let nextId = 0;
  const createId = (prefix: string) => `${prefix}_error_limit_${++nextId}`;
  return new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
      createId,
      now: () => 1 as TimestampMs,
    }),
    retryPolicy: { maxAttempts: 1, initialDelayMs: 0 },
    createId,
    now: () => 1 as TimestampMs,
  });
}
