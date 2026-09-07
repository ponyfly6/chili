import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { MessageId, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { GoalService } from "./goal.js";
import type { AgentRunner, AppendUserMessageInput, CreateSessionInput, RunTurnInput, RunTurnResult } from "./runner.js";
import { RuntimeService } from "./runtime-service.js";
import type { CompactContextInput, CompactContextResult } from "./single-agent-runtime.js";

for (const operation of ["prompt", "compaction"] as const) {
  test(`pausing during ${operation} accounts returned usage before cancelling`, async () => {
    const fixture = await createFixture();
    const { service, goals, runner, sessionId } = fixture;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    runner.onRun = async () => {
      started.resolve();
      await release.promise;
    };
    try {
      await goals.setGoal({ sessionId, objective: "finish pending work", tokenBudget: 10 });
      const pending = operation === "prompt"
        ? service.submitPrompt({ sessionId, text: "work" })
        : service.compactSession({ sessionId });
      await started.promise;
      await service.updateGoal({ sessionId, status: "paused" });
      release.resolve();
      expect(await pending).toMatchObject({ status: "cancelled" });
      expect(await service.getGoal({ sessionId })).toMatchObject({ status: "paused", tokensUsed: 12 });
      expect(runner.calls).toBe(1);
      await expect(service.updateGoal({ sessionId, status: "active" })).rejects.toThrow("must exceed tokens used (12)");
    } finally {
      release.resolve();
      await fixture.close();
    }
  });
}

test("a late runtime turn cannot charge a cleared and recreated goal", async () => {
  const fixture = await createFixture();
  const { service, goals, runner, sessionId } = fixture;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  runner.onRun = async () => {
    started.resolve();
    await release.promise;
  };
  try {
    await goals.setGoal({ sessionId, objective: "old goal" });
    const pending = service.submitPrompt({ sessionId, text: "old work" });
    await started.promise;
    await goals.clearGoal({ sessionId });
    await goals.setGoal({ sessionId, objective: "new goal" });
    await goals.updateGoal({ sessionId, status: "complete" });
    release.resolve();
    await pending;
    expect(await service.getGoal({ sessionId })).toMatchObject({ objective: "new goal", status: "complete", tokensUsed: 0 });
  } finally {
    release.resolve();
    await fixture.close();
  }
});

test("runtime accounting includes the turn that creates and completes its goal", async () => {
  const fixture = await createFixture();
  const { service, runner, sessionId } = fixture;
  runner.onRun = async () => {
    await service.setGoal({ sessionId, objective: "created inside the model turn" });
    await service.updateGoal({ sessionId, status: "complete" });
  };
  try {
    await service.submitPrompt({ sessionId, text: "create and finish a goal" });
    expect(await service.getGoal({ sessionId })).toMatchObject({ status: "complete", tokensUsed: 12 });
    expect(runner.calls).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("SQLite goal usage receipts prevent duplicate charging after closing and reopening the store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-goal-accounting-reopen-"));
  const path = join(dir, "events.sqlite");
  let store = new SqliteEventStore(path);
  const sessionId = "session_goal_reopen" as SessionId;
  try {
    let goals = new GoalService({ store });
    await goals.setGoal({ sessionId, objective: "persist receipts" });
    const scope = await goals.captureUsage({ sessionId });
    const input = { sessionId, scope, turnId: "turn_durable_receipt" as TurnId, usage: { totalTokens: 7 }, timeSeconds: 2 };
    await goals.accountUsage(input);
    store.close();
    store = new SqliteEventStore(path);
    goals = new GoalService({ store });
    await goals.accountUsage(input);
    expect(await goals.getGoal({ sessionId })).toMatchObject({ tokensUsed: 7, timeUsedSeconds: 2 });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a delayed interrupt status cannot pause a replacement goal created after the interrupt", async () => {
  const fixture = await createFixture();
  const { service, goals, store, runner, sessionId } = fixture;
  const turnStarted = Promise.withResolvers<void>();
  const releaseTurn = Promise.withResolvers<void>();
  const statusStarted = Promise.withResolvers<void>();
  const releaseStatus = Promise.withResolvers<void>();
  runner.onRun = async () => {
    turnStarted.resolve();
    await releaseTurn.promise;
  };
  const append = store.append.bind(store);
  store.append = async (event, options) => {
    if (event.type === "session.status_changed" && event.payload.status === "cancelling") {
      statusStarted.resolve();
      await releaseStatus.promise;
    }
    await append(event, options);
  };
  let pending: Promise<unknown> | undefined;
  let interrupted: Promise<boolean> | undefined;
  try {
    await goals.setGoal({ sessionId, objective: "interrupted goal" });
    pending = service.submitPrompt({ sessionId, text: "old work" });
    await turnStarted.promise;
    interrupted = service.interrupt(sessionId);
    await statusStarted.promise;
    await goals.clearGoal({ sessionId });
    await goals.setGoal({ sessionId, objective: "new goal after interrupt" });
    releaseStatus.resolve();
    await interrupted;
    expect(await service.getGoal({ sessionId })).toMatchObject({ objective: "new goal after interrupt", status: "active" });
  } finally {
    releaseStatus.resolve();
    await interrupted;
    await goals.clearGoal({ sessionId });
    releaseTurn.resolve();
    await pending;
    await fixture.close();
  }
});

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "chili-goal-accounting-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runner = new AccountingRunner(store);
  let index = 0;
  const createId = (prefix: string) => `${prefix}_${++index}`;
  const service = new RuntimeService({ runtime: runner, store, cwd: dir, createId });
  const goals = new GoalService({ store, createId });
  const sessionId = "session_goal_accounting" as SessionId;
  await service.createSession({ sessionId, cwd: dir });
  return {
    service,
    goals,
    store,
    runner,
    sessionId,
    async close() {
      await service.shutdown();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

class AccountingRunner implements AgentRunner {
  calls = 0;
  onRun?: () => Promise<void>;

  constructor(private readonly store: SqliteEventStore) {}

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    const sessionId = input.sessionId!;
    await this.store.append({
      id: `event_create_${sessionId}`,
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: input.cwd },
    });
    return sessionId;
  }

  async appendUserMessage(_input: AppendUserMessageInput): Promise<MessageId> {
    return "message_user" as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.calls += 1;
    await this.onRun?.();
    const turnId = input.turnId ?? `turn_${this.calls}` as TurnId;
    if (input.signal?.aborted) {
      return { status: "cancelled", turnId, error: new Error("cancelled"), usage: { totalTokens: 12 } };
    }
    return { status: "completed", turnId, assistantMessageId: "message_assistant" as MessageId, finishReason: "stop", usage: { totalTokens: 12 } };
  }

  async compactContext(_input: CompactContextInput): Promise<CompactContextResult> {
    this.calls += 1;
    await this.onRun?.();
    return {
      status: "completed",
      turnId: "turn_compaction" as TurnId,
      messageId: "message_compaction" as MessageId,
      boundaryMessageId: "message_user" as MessageId,
      summaryChars: 5,
      usage: { totalTokens: 12 },
    };
  }
}
