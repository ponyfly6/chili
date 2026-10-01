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

for (const status of ["failed", "cancelled"] as const) {
  test(`returned ${status} usage is accounted even if terminal status acknowledgement is lost`, async () => {
    const fixture = await createFixture();
    const { service, goals, store, runner, sessionId } = fixture;
    runner.results.push({ status, turnId: "turn_billable_terminal" as TurnId, error: new Error("billable terminal result"), usage: { totalTokens: 12 } });
    const append = store.append.bind(store);
    let fail = true;
    store.append = async (event, options) => {
      await append(event, options);
      if (fail && event.type === "session.status_changed" && event.payload.status === status) {
        fail = false;
        throw new Error("terminal status acknowledgement lost");
      }
    };
    try {
      await goals.setGoal({ sessionId, objective: "account returned usage" });
      await service.submitPrompt({ sessionId, text: "work" });
      expect(fail).toBe(false);
      expect(await service.getGoal({ sessionId })).toMatchObject({ tokensUsed: 12 });
    } finally {
      await fixture.close();
    }
  });
}

for (const maxTurns of [1, 2]) {
  test(`tool continuation and forced final response retain their goal ledger after the budget is exhausted (${maxTurns} tool turns)`, async () => {
    const fixture = await createFixture();
    const { service, goals, runner, sessionId } = fixture;
    runner.results.push(...Array.from({ length: maxTurns + 1 }, (_, index): RunTurnResult => ({
      status: "completed",
      turnId: `turn_budget_final_${index}` as TurnId,
      assistantMessageId: `message_budget_final_${index}` as MessageId,
      finishReason: index < maxTurns ? "tool_use" : "stop",
      usage: { totalTokens: 12 },
    })));
    try {
      await goals.setGoal({ sessionId, objective: "finish within the budget", tokenBudget: 10 });
      expect(await service.submitPrompt({ sessionId, text: "work", maxTurns })).toMatchObject({ status: "completed" });
      expect(runner.calls).toBe(maxTurns + 1);
      expect(await service.getGoal({ sessionId })).toMatchObject({ status: "budgetLimited", tokensUsed: (maxTurns + 1) * 12 });
    } finally {
      await fixture.close();
    }
  });
}

test("a new prompt started with an exhausted goal cannot acquire its ledger through a tool continuation", async () => {
  const fixture = await createFixture();
  const { service, goals, runner, sessionId } = fixture;
  runner.results.push(...["tool_use", "tool_use", "stop"].map((finishReason, index): RunTurnResult => ({
    status: "completed",
    turnId: `turn_unrelated_${index}` as TurnId,
    assistantMessageId: `message_unrelated_${index}` as MessageId,
    finishReason,
    usage: { totalTokens: 12 },
  })));
  try {
    await goals.setGoal({ sessionId, objective: "already exhausted", tokenBudget: 1 });
    await goals.accountUsage({ sessionId, turnId: "turn_exhausted" as TurnId, usage: { totalTokens: 1 }, timeSeconds: 1 });
    await service.submitPrompt({ sessionId, text: "unrelated work", maxTurns: 2 });
    expect(runner.calls).toBe(3);
    expect(await service.getGoal({ sessionId })).toMatchObject({ status: "budgetLimited", tokensUsed: 1 });
  } finally {
    await fixture.close();
  }
});

test("a forced final response keeps the old ledger while a new goal continuation can adopt the replacement", async () => {
  const fixture = await createFixture();
  const { service, goals, runner, sessionId } = fixture;
  runner.results.push(...["tool_use", "stop", "stop"].map((finishReason, index): RunTurnResult => ({
    status: "completed",
    turnId: `turn_replacement_final_${index}` as TurnId,
    assistantMessageId: `message_replacement_final_${index}` as MessageId,
    finishReason,
    usage: { totalTokens: 12 },
  })));
  runner.onRun = async () => {
    if (runner.calls === 1) {
      await goals.clearGoal({ sessionId });
      await goals.setGoal({ sessionId, objective: "replacement goal" });
    } else if (runner.calls === 3) {
      await service.updateGoal({ sessionId, status: "complete" });
    }
  };
  try {
    await goals.setGoal({ sessionId, objective: "original goal" });
    await service.submitPrompt({ sessionId, text: "old work", maxTurns: 1 });
    expect(runner.calls).toBe(3);
    expect(await service.getGoal({ sessionId })).toMatchObject({ objective: "replacement goal", status: "complete", tokensUsed: 12 });
  } finally {
    await fixture.close();
  }
});

test("goal finalizing cannot charge a different completed goal created inside the preceding tool turn", async () => {
  const fixture = await createFixture();
  const { service, goals, runner, sessionId } = fixture;
  runner.results.push(...["stop", "tool_use", "stop"].map((finishReason, index): RunTurnResult => ({
    status: "completed",
    turnId: `turn_completed_replacement_${index}` as TurnId,
    assistantMessageId: `message_completed_replacement_${index}` as MessageId,
    finishReason,
    usage: { totalTokens: index === 0 ? 0 : 12 },
  })));
  runner.onRun = async () => {
    if (runner.calls === 2) {
      await goals.clearGoal({ sessionId });
      await goals.setGoal({ sessionId, objective: "already completed replacement" });
      await goals.updateGoal({ sessionId, status: "complete" });
    }
  };
  try {
    await goals.setGoal({ sessionId, objective: "original goal" });
    await service.submitPrompt({ sessionId, text: "old work" });
    expect(runner.calls).toBe(3);
    expect(await service.getGoal({ sessionId })).toMatchObject({ objective: "already completed replacement", status: "complete", tokensUsed: 0 });
  } finally {
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
  readonly results: RunTurnResult[] = [];
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
    const result = this.results.shift();
    if (result) return result;
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
