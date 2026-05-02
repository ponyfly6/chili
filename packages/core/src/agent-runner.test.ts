import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  SessionId,
  ThreadId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import type { ApprovalRow, EventQuery, EventStore, SessionRow } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import type { AgentRunner, AppendUserMessageInput, CreateSessionInput, RunTurnInput, RunTurnResult } from "./runner.js";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";
import { RuntimeBusyError, RuntimeService } from "./runtime-service.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

test("RuntimeService accepts an AgentRunner implementation", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_fake" as SessionId;
  const threadId = "thread_fake" as ThreadId;
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const handle = await service.createSession({
    threadId,
    cwd: "/workspace",
  });
  const result = await service.submitPrompt({
    sessionId: handle.sessionId,
    threadId: handle.threadId,
    text: "hello",
    cwd: "/workspace/subdir",
    system: ["be brief"],
  });

  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    expect(result.finishReason).toBe("stop");
  }
  expect(runner.createInputs[0]).toEqual({
    threadId,
    cwd: "/workspace",
  });
  expect(runner.userMessages[0]).toEqual({
    sessionId,
    threadId,
    text: "hello",
  });
  expect(runner.turnInputs[0]?.cwd).toBe("/workspace/subdir");
  expect(runner.turnInputs[0]?.system).toEqual(["be brief"]);
  expect(runner.turnInputs[0]?.signal?.aborted).toBe(false);
  expect(statuses(store)).toEqual(["idle", "running", "running", "idle"]);
});

test("RuntimeService clears running reservation when initial running status write fails with a fake runner", async () => {
  const store = new ThrowingStatusStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_status_failure" as SessionId;

  await expect(
    service.submitPrompt({
      sessionId,
      threadId: "thread_status_failure" as ThreadId,
      text: "hello",
    }),
  ).rejects.toThrow("status write failed");
  expect(service.isRunning(sessionId)).toBe(false);
  expect(runner.userMessages).toHaveLength(0);
});

test("RuntimeService reserves busy sessions before the runner reaches runTurn", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const gate = deferred<void>();
  runner.runTurnWait = gate.promise;
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_busy" as SessionId;
  const threadId = "thread_busy" as ThreadId;

  const first = service.submitPrompt({
    sessionId,
    threadId,
    text: "first",
  });

  expect(service.isRunning(sessionId)).toBe(true);
  await expect(
    service.submitPrompt({
      sessionId,
      threadId,
      text: "second",
    }),
  ).rejects.toThrow(RuntimeBusyError);
  expect(() =>
    service.submitPromptAsync({
      sessionId,
      threadId,
      text: "third",
    }),
  ).toThrow(RuntimeBusyError);

  gate.resolve();
  const result = await first;

  expect(result.status).toBe("completed");
  expect(service.isRunning(sessionId)).toBe(false);
  expect(runner.userMessages).toHaveLength(1);
});

test("RuntimeService continues after OpenAI-compatible tool_calls finish reason", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.onRunTurn = async () => {
    const turnNumber = runner.turnInputs.length;
    runner.runTurnResult = {
      status: "completed",
      turnId: `turn_${turnNumber}` as TurnId,
      assistantMessageId: `message_assistant_${turnNumber}` as MessageId,
      finishReason: turnNumber === 1 ? "tool_calls" : "stop",
    };
  };

  const result = await service.submitPrompt({
    sessionId: "session_tool_calls" as SessionId,
    threadId: "thread_tool_calls" as ThreadId,
    text: "use a tool",
    maxTurns: 3,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("stop");
  expect(runner.turnInputs).toHaveLength(2);
  expect(statuses(store)).toEqual(["running", "running", "running", "idle"]);
});

test("RuntimeService adds a no-tool final turn after the tool continuation limit", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.onRunTurn = async () => {
    const turnNumber = runner.turnInputs.length;
    runner.runTurnResult = {
      status: "completed",
      turnId: `turn_${turnNumber}` as TurnId,
      assistantMessageId: `message_assistant_${turnNumber}` as MessageId,
      finishReason: turnNumber <= 2 ? "tool_use" : "stop",
    };
  };

  const result = await service.submitPrompt({
    sessionId: "session_final_after_tools" as SessionId,
    threadId: "thread_final_after_tools" as ThreadId,
    text: "inspect deeply",
    maxTurns: 2,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("stop");
  expect(runner.turnInputs).toHaveLength(3);
  expect(runner.turnInputs[2]?.toolMode).toBe("disabled");
  expect(runner.turnInputs[2]?.system?.at(-1)).toContain("Do not call tools");
  expect(statuses(store)).toEqual(["running", "running", "running", "running", "idle"]);
});

test("RuntimeService uses the last persisted model config for new sessions", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const firstService = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "minimax", model: "MiniMax-M2.7" },
    defaultReasoningLevel: "medium",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  await firstService.setModel({
    sessionId: "session_previous" as SessionId,
    threadId: "thread_previous" as ThreadId,
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
  });
  await firstService.setReasoning({
    sessionId: "session_previous" as SessionId,
    threadId: "thread_previous" as ThreadId,
    reasoningLevel: "high",
  });

  const nextRunner = new FakeAgentRunner();
  const nextService = new RuntimeService({
    runtime: nextRunner,
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "minimax", model: "MiniMax-M2.7" },
    defaultReasoningLevel: "medium",
    createId: createSequentialId(),
    now: () => 2 as TimestampMs,
  });

  await nextService.createSession({
    sessionId: "session_next" as SessionId,
    threadId: "thread_next" as ThreadId,
  });
  const config = await nextService.getModelConfig("session_next" as SessionId);
  expect(config.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  expect(config.reasoningLevel).toBe("high");

  const result = await nextService.submitPrompt({
    sessionId: "session_next" as SessionId,
    threadId: "thread_next" as ThreadId,
    text: "hello",
  });

  expect(result.status).toBe("completed");
  expect(nextRunner.turnInputs[0]?.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  expect(nextRunner.turnInputs[0]?.reasoningLevel).toBe("high");
});

test("RuntimeService still stops on Anthropic-style end_turn finish reason", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.runTurnResult = {
    status: "completed",
    turnId: "turn_end_turn" as TurnId,
    assistantMessageId: "message_assistant_end_turn" as MessageId,
    finishReason: "end_turn",
  };

  const result = await service.submitPrompt({
    sessionId: "session_end_turn" as SessionId,
    threadId: "thread_end_turn" as ThreadId,
    text: "answer directly",
    maxTurns: 3,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("end_turn");
  expect(runner.turnInputs).toHaveLength(1);
  expect(statuses(store)).toEqual(["running", "running", "idle"]);
});

test("RuntimeService stops before another tool-use turn when interrupted", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_interrupt_loop" as SessionId;
  const threadId = "thread_interrupt_loop" as ThreadId;
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.runTurnResult = {
    status: "completed",
    turnId: "turn_tool_use" as TurnId,
    assistantMessageId: "message_assistant_tool_use" as MessageId,
    finishReason: "tool_use",
  };
  runner.onRunTurn = async () => {
    await service.interrupt(sessionId, "complete_task");
  };

  const result = await service.submitPrompt({
    sessionId,
    threadId,
    text: "finish by tool",
    maxTurns: 3,
  });

  expect(result.status).toBe("cancelled");
  expect(runner.turnInputs).toHaveLength(1);
  expect(statuses(store)).toEqual(["running", "cancelling", "running", "cancelled"]);
});

test("SingleAgentRuntime satisfies AgentRunner without changing aborted turn behavior", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelCalls++;
      expect(input.signal?.aborted).toBe(true);
      throw abortError("provider aborted");
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    retryPolicy: { maxAttempts: 3, initialDelayMs: 0 },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const runner: AgentRunner = runtime;
  const controller = new AbortController();
  controller.abort();

  const result = await runner.runTurn({
    sessionId: "session_abort" as SessionId,
    threadId: "thread_abort" as ThreadId,
    cwd: "/repo",
    signal: controller.signal,
  });

  expect(result.status).toBe("cancelled");
  expect(modelCalls).toBe(1);
  expect(store.items.some((event) => event.type === "turn.retry_scheduled")).toBe(false);
});

class FakeAgentRunner implements AgentRunner {
  readonly createInputs: CreateSessionInput[] = [];
  readonly userMessages: AppendUserMessageInput[] = [];
  readonly turnInputs: RunTurnInput[] = [];
  runTurnWait?: Promise<void>;
  onRunTurn?: (input: RunTurnInput) => Promise<void>;
  runTurnResult: RunTurnResult = {
    status: "completed",
    turnId: "turn_fake" as TurnId,
    assistantMessageId: "message_assistant_fake" as MessageId,
    finishReason: "stop",
  };

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    this.createInputs.push(input);
    return input.sessionId ?? ("session_fake" as SessionId);
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<MessageId> {
    this.userMessages.push(input);
    return "message_user_fake" as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.turnInputs.push(input);
    await this.runTurnWait;
    await this.onRunTurn?.(input);
    return this.runTurnResult;
  }
}

class MemoryEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];

  async append(event: ChiliEvent): Promise<void> {
    this.items.push(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const afterIndex = query.afterEventId
      ? this.items.findIndex((event) => event.id === query.afterEventId)
      : -1;
    const limit = query.limit ?? 500;
    return this.items
      .slice(afterIndex + 1)
      .filter((event) => {
        if (query.sessionId && event.sessionId !== query.sessionId) return false;
        if (query.threadId && event.threadId !== query.threadId) return false;
        if (query.type && event.type !== query.type) return false;
        return true;
      })
      .slice(0, limit);
  }

  async sessions(): Promise<SessionRow[]> {
    return [];
  }

  async messages(): Promise<Message[]> {
    return [];
  }

  async pendingApprovals(): Promise<ApprovalRow[]> {
    return [];
  }
}

class ThrowingStatusStore extends MemoryEventStore {
  override async append(event: ChiliEvent): Promise<void> {
    if (event.type === "session.status_changed") {
      throw new Error("status write failed");
    }
    await super.append(event);
  }
}

function statuses(store: MemoryEventStore): string[] {
  return store.items.flatMap((event) => (event.type === "session.status_changed" ? [event.payload.status] : []));
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
