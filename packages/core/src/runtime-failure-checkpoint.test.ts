import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  MessageId,
  MessagePart,
  SessionId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import { FAILURE_CHECKPOINT_MAX_CHARS } from "./failure-checkpoint.js";
import type {
  AgentRunner,
  AppendUserMessageInput,
  CreateSessionInput,
  RunTurnInput,
  RunTurnResult,
} from "./runner.js";
import type { ModelRouter, ModelStreamEvent } from "./runtime.js";
import { RuntimeService } from "./runtime-service.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

test("persists a projected failure checkpoint from prior progress without another model call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-failure-checkpoint-"));
  const dbPath = join(dir, "events.sqlite");
  let store: SqliteEventStore = new TrackingSqliteEventStore(dbPath);
  const trackingStore = store as TrackingSqliteEventStore;
  const sessionId = "session_failure_checkpoint" as SessionId;
  const registry = new InMemoryToolRegistry();
  let modelCalls = 0;

  registry.register({
    name: "inspect_file",
    description: "Inspect a file.",
    risk: "read",
    inputSchema: { type: "object" },
    approval: () => false,
    execute: async () => ({
      title: "inspected",
      output: "TOOL OUTPUT SECRET",
    }),
  });

  const model: ModelRouter = {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      modelCalls++;
      if (modelCalls === 1) {
        yield {
          type: "text_delta",
          phase: "commentary",
          text: "Confirmed the authoritative workspace and inspected the runtime failure path.",
        };
        yield {
          type: "tool_call",
          name: "inspect_file",
          input: { path: "packages/core/src/runtime-service.ts" },
        };
        yield { type: "finish", reason: "tool_use" };
        return;
      }
      throw new Error(
        "HTTP 502 Bad Gateway: <!DOCTYPE html><html><body>RAW PROVIDER BODY</body></html>",
      );
    },
  };
  const createId = createSequentialId();
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    retryPolicy: { maxAttempts: 1, initialDelayMs: 0 },
    createId,
    now: () => 1 as TimestampMs,
  });
  const service = new RuntimeService({
    runtime,
    store,
    cwd: "/repo",
    createId,
    now: () => 1 as TimestampMs,
  });

  try {
    await service.createSession({ sessionId, cwd: "/repo" });
    const result = await service.submitPrompt({
      sessionId,
      text: "USER PROMPT SECRET",
    });

    expect(result.status).toBe("failed");
    expect(result.turns.map((turn) => turn.status)).toEqual(["completed", "failed"]);
    expect(modelCalls).toBe(2);

    const checkpointBatch = trackingStore.appendManyBatches.find((batch) => (
      batch.length === 2
      && batch[0]?.type === "message.created"
      && batch[1]?.type === "message.part_added"
    ));
    expect(checkpointBatch?.map((event) => event.type)).toEqual([
      "message.created",
      "message.part_added",
    ]);
    if (checkpointBatch?.[0]?.type !== "message.created" || checkpointBatch[1]?.type !== "message.part_added") {
      throw new Error("expected an atomic checkpoint message batch");
    }
    expect(checkpointBatch[0].payload.messageId).toBe(checkpointBatch[1].payload.messageId);
    expect(checkpointBatch[1].payload.part).toMatchObject({
      type: "text",
      phase: "final_answer",
      synthetic: true,
    });

    const checkpointMessageId = checkpointBatch[0].payload.messageId;
    const persistedEvents = await store.events({ sessionId, limit: 500 });
    expect(persistedEvents.some((event) => (
      event.type === "message.part_delta"
      && (event.payload as { messageId?: string }).messageId === checkpointMessageId
    ))).toBe(false);

    store.close();
    store = new SqliteEventStore(dbPath);
    const messages = await store.messages(sessionId);
    const checkpoint = messages
      .flatMap((message) => message.parts)
      .find(isFailureCheckpointPart);

    expect(checkpoint).toBeDefined();
    expect(checkpoint?.text).toContain("Confirmed the authoritative workspace");
    expect(checkpoint?.text).toContain(
      "inspect_file: completed (packages/core/src/runtime-service.ts)",
    );
    expect(checkpoint?.text).not.toContain("USER PROMPT SECRET");
    expect(checkpoint?.text).not.toContain("TOOL OUTPUT SECRET");
    expect(checkpoint?.text).not.toContain("RAW PROVIDER BODY");
    expect(checkpoint?.text).not.toContain("<!DOCTYPE html>");
    expect(checkpoint?.text.length).toBeLessThanOrEqual(FAILURE_CHECKPOINT_MAX_CHARS);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("uses persisted session cwd as the only prompt authority and normalizes new sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-session-cwd-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_persisted_cwd" as SessionId;
  const runner = new RecordingAgentRunner(store);
  const service = new RuntimeService({ runtime: runner, store, cwd: "/different/default" });

  try {
    await service.createSession({ sessionId, cwd: "relative-workspace" });
    const persistedCwd = resolve("relative-workspace");
    expect(runner.createInputs[0]?.cwd).toBe(persistedCwd);
    expect((await store.sessions()).find((session) => session.id === sessionId)?.cwd).toBe(persistedCwd);

    const resumed = await service.submitPrompt({ sessionId, text: "resume" });
    expect(resumed.status).toBe("completed");
    expect(runner.turnInputs[0]?.cwd).toBe(persistedCwd);

    const mismatched = await service.submitPrompt({
      sessionId,
      text: "wrong workspace",
      cwd: "/other/workspace",
    });
    expect(mismatched.status).toBe("failed");
    if (mismatched.status === "completed") throw new Error("expected cwd mismatch to fail");
    expect(mismatched.error?.message).toContain(
      `expected ${persistedCwd}, received /other/workspace`,
    );
    expect(runner.userMessages).toHaveLength(1);
    expect(runner.turnInputs).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("goal continuation resolves cwd from the persisted session instead of the process default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-goal-cwd-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_goal_persisted_cwd" as SessionId;
  const runner = new RecordingAgentRunner(store);
  const service = new RuntimeService({ runtime: runner, store, cwd: "/different/default", maxGoalTurns: 2 });

  try {
    await service.createSession({ sessionId, cwd: "/persisted/goal-workspace" });
    runner.onRunTurn = async () => {
      await service.updateGoal({ sessionId, status: "complete" });
    };
    await service.setGoal({ sessionId, objective: "finish the persisted task" });
    await waitUntil(() => !service.isRunning(sessionId));

    expect(runner.turnInputs).toHaveLength(1);
    expect(runner.turnInputs[0]?.cwd).toBe("/persisted/goal-workspace");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("publishes prompt-level status and never bounces cancelling back to running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-prompt-status-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionId = "session_prompt_status" as SessionId;
  const runner = new RecordingAgentRunner(store);
  runner.results.push(
    completedTurn("turn_tool", "message_tool", "tool_use"),
    completedTurn("turn_stop", "message_stop", "stop"),
  );
  const service = new RuntimeService({ runtime: runner, store, cwd: "/repo" });

  try {
    await service.createSession({ sessionId, cwd: "/repo" });
    const completed = await service.submitPrompt({ sessionId, text: "use a tool then answer" });
    expect(completed.status).toBe("completed");
    expect(await statuses(store, sessionId)).toEqual(["idle", "running", "idle"]);

    const interruptedSessionId = "session_prompt_interrupt" as SessionId;
    await service.createSession({ sessionId: interruptedSessionId, cwd: "/repo" });
    runner.results.push(completedTurn("turn_interrupted", "message_interrupted", "tool_use"));
    runner.onRunTurn = async () => {
      await service.interrupt(interruptedSessionId, "test_interrupt");
    };
    const interrupted = await service.submitPrompt({
      sessionId: interruptedSessionId,
      text: "interrupt after the internal turn",
    });
    expect(interrupted.status).toBe("cancelled");
    expect(await statuses(store, interruptedSessionId)).toEqual([
      "idle",
      "running",
      "cancelling",
      "cancelled",
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class TrackingSqliteEventStore extends SqliteEventStore {
  readonly appendManyBatches: ChiliEvent[][] = [];

  override async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    this.appendManyBatches.push([...events]);
    await super.appendMany(events);
  }
}

class RecordingAgentRunner implements AgentRunner {
  readonly createInputs: CreateSessionInput[] = [];
  readonly userMessages: AppendUserMessageInput[] = [];
  readonly turnInputs: RunTurnInput[] = [];
  readonly results: RunTurnResult[] = [];
  onRunTurn?: (input: RunTurnInput) => Promise<void> | void;

  constructor(private readonly store: SqliteEventStore) {}

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    const sessionId = input.sessionId ?? "session_recording" as SessionId;
    this.createInputs.push({ ...input });
    await this.store.append({
      id: `event_create_${sessionId}`,
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: input.cwd },
    });
    return sessionId;
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<MessageId> {
    this.userMessages.push({ ...input });
    return `message_user_${this.userMessages.length}` as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.turnInputs.push({ ...input });
    await this.onRunTurn?.(input);
    return this.results.shift() ?? completedTurn(
      `turn_${this.turnInputs.length}`,
      `message_assistant_${this.turnInputs.length}`,
      "stop",
    );
  }
}

function isFailureCheckpointPart(
  part: MessagePart,
): part is Extract<MessagePart, { type: "text" }> {
  return part.type === "text" && part.synthetic === true && part.phase === "final_answer";
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function completedTurn(turnId: string, messageId: string, finishReason: string): RunTurnResult {
  return {
    status: "completed",
    turnId: turnId as TurnId,
    assistantMessageId: messageId as MessageId,
    finishReason,
  };
}

async function statuses(store: SqliteEventStore, sessionId: SessionId): Promise<string[]> {
  return (await store.events({ sessionId, type: "session.status_changed", limit: 100 }))
    .flatMap((event) => event.type === "session.status_changed"
      ? [(event as Extract<ChiliEvent, { type: "session.status_changed" }>).payload.status]
      : []);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for background runtime work");
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
}
