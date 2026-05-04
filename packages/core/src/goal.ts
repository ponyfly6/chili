import type {
  ChiliEvent,
  EventEnvelope,
  ModelUsage,
  SessionId,
  ThreadGoal,
  ThreadGoalStatus,
  ThreadGoalUpdateReason,
  ThreadGoalUsageDelta,
  ThreadId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type { EventStore, GoalProjectionStore } from "@chili/store";

export const DEFAULT_GOAL_TOKEN_BUDGET = 50_000;

export interface GoalServiceOptions {
  store: EventStore & Partial<GoalProjectionStore>;
  defaultTokenBudget?: number;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
}

export interface SetGoalInput {
  sessionId: SessionId;
  threadId: ThreadId;
  objective: string;
  tokenBudget?: number;
  replace?: boolean;
}

export interface UpdateGoalInput {
  sessionId: SessionId;
  threadId: ThreadId;
  status?: ThreadGoalStatus;
  objective?: string;
  tokenBudget?: number;
  reason?: ThreadGoalUpdateReason;
}

export interface ClearGoalInput {
  sessionId: SessionId;
  threadId: ThreadId;
}

export interface AccountGoalUsageInput {
  sessionId: SessionId;
  threadId: ThreadId;
  turnId: TurnId;
  usage?: ModelUsage;
  timeSeconds: number;
}

export interface AccountGoalUsageResult {
  goal?: ThreadGoal;
  budgetLimited: boolean;
  usageDelta?: ThreadGoalUsageDelta;
}

export class GoalAlreadyExistsError extends Error {
  constructor(readonly threadId: ThreadId) {
    super(`Goal already exists for thread: ${threadId}`);
    this.name = "GoalAlreadyExistsError";
  }
}

export class GoalNotFoundError extends Error {
  constructor(readonly threadId: ThreadId) {
    super(`No goal exists for thread: ${threadId}`);
    this.name = "GoalNotFoundError";
  }
}

export class GoalService {
  constructor(private readonly options: GoalServiceOptions) {}

  async getGoal(input: { threadId: ThreadId }): Promise<ThreadGoal | undefined> {
    const projected = await this.projection()?.threadGoal(input.threadId);
    if (projected) return cloneGoal(projected);
    return this.replayGoal(input.threadId);
  }

  async setGoal(input: SetGoalInput): Promise<ThreadGoal> {
    const objective = input.objective.trim();
    if (!objective) throw new Error("Goal objective is required.");
    const existing = await this.getGoal({ threadId: input.threadId });
    if (existing && !input.replace) throw new GoalAlreadyExistsError(input.threadId);

    const now = this.now();
    const goal: ThreadGoal = {
      sessionId: input.sessionId,
      threadId: input.threadId,
      objective,
      status: "active",
      tokenBudget: input.tokenBudget ?? existing?.tokenBudget ?? this.defaultTokenBudget(),
      tokensUsed: input.replace && existing ? existing.tokensUsed : 0,
      timeUsedSeconds: input.replace && existing ? existing.timeUsedSeconds : 0,
      createdAt: input.replace && existing ? existing.createdAt : now,
      updatedAt: now,
      lastReason: existing ? "replace" : "set",
    };
    await this.appendGoalUpdated(input, goal, existing ? "replace" : "set");
    return cloneGoal(goal);
  }

  async updateGoal(input: UpdateGoalInput): Promise<ThreadGoal> {
    const existing = await this.getGoal({ threadId: input.threadId });
    if (!existing) throw new GoalNotFoundError(input.threadId);
    const now = this.now();
    const reason = input.reason ?? reasonForStatus(input.status) ?? "external";
    const goal: ThreadGoal = {
      ...existing,
      sessionId: existing.sessionId ?? input.sessionId,
      updatedAt: now,
      lastReason: reason,
    };
    if (input.objective !== undefined) {
      const objective = input.objective.trim();
      if (!objective) throw new Error("Goal objective is required.");
      goal.objective = objective;
    }
    if (input.tokenBudget !== undefined) goal.tokenBudget = input.tokenBudget;
    if (input.status) {
      goal.status = input.status;
      if (input.status === "complete") {
        goal.completedAt = now;
      } else {
        delete goal.completedAt;
      }
    }
    await this.appendGoalUpdated(input, goal, reason);
    return cloneGoal(goal);
  }

  async clearGoal(input: ClearGoalInput): Promise<{ cleared: boolean; previousGoal?: ThreadGoal }> {
    const previousGoal = await this.getGoal({ threadId: input.threadId });
    if (!previousGoal) return { cleared: false };
    const event: EventEnvelope<"goal.cleared", Extract<ChiliEvent, { type: "goal.cleared" }>["payload"]> = {
      id: this.id("event"),
      type: "goal.cleared",
      time: this.now(),
      sessionId: input.sessionId,
      threadId: input.threadId,
      payload: {
        threadId: input.threadId,
        previousGoal,
        reason: "clear",
      },
    };
    await this.options.store.append(event as ChiliEvent);
    return { cleared: true, previousGoal: cloneGoal(previousGoal) };
  }

  async accountUsage(input: AccountGoalUsageInput): Promise<AccountGoalUsageResult> {
    const existing = await this.getGoal({ threadId: input.threadId });
    if (!existing || (existing.status !== "active" && existing.status !== "complete")) return { budgetLimited: false };

    const tokenDelta = goalTokenDelta(input.usage);
    const timeSeconds = finitePositive(input.timeSeconds) ?? 0;
    if (tokenDelta <= 0 && timeSeconds <= 0) {
      return { goal: cloneGoal(existing), budgetLimited: false };
    }

    const usageDelta: ThreadGoalUsageDelta = {
      turnId: input.turnId,
      tokens: tokenDelta,
      timeSeconds,
    };
    if (input.usage?.inputTokens !== undefined) usageDelta.inputTokens = input.usage.inputTokens;
    if (input.usage?.outputTokens !== undefined) usageDelta.outputTokens = input.usage.outputTokens;
    if (input.usage?.cacheReadInputTokens !== undefined) usageDelta.cacheReadInputTokens = input.usage.cacheReadInputTokens;
    if (input.usage?.totalTokens !== undefined) usageDelta.totalTokens = input.usage.totalTokens;

    const tokensUsed = existing.tokensUsed + tokenDelta;
    const budgetLimited = existing.status === "active" && existing.tokenBudget !== undefined && tokensUsed >= existing.tokenBudget;
    const goal: ThreadGoal = {
      ...existing,
      sessionId: existing.sessionId ?? input.sessionId,
      status: budgetLimited ? "budgetLimited" : existing.status,
      tokensUsed,
      timeUsedSeconds: existing.timeUsedSeconds + timeSeconds,
      updatedAt: this.now(),
      lastReason: budgetLimited ? "budget_limited" : "usage",
    };
    await this.appendGoalUpdated(input, goal, budgetLimited ? "budget_limited" : "usage", usageDelta);
    return { goal: cloneGoal(goal), budgetLimited, usageDelta };
  }

  private async replayGoal(threadId: ThreadId): Promise<ThreadGoal | undefined> {
    const events = await this.options.store.events({ threadId, limit: 10_000 });
    let goal: ThreadGoal | undefined;
    for (const event of events) {
      if (event.type === "goal.updated") {
        const payload = event.payload as Extract<ChiliEvent, { type: "goal.updated" }>["payload"];
        goal = cloneGoal(payload.goal);
      } else if (event.type === "goal.cleared") {
        goal = undefined;
      }
    }
    return goal;
  }

  private appendGoalUpdated(
    input: { sessionId: SessionId; threadId: ThreadId },
    goal: ThreadGoal,
    reason: ThreadGoalUpdateReason,
    usageDelta?: ThreadGoalUsageDelta,
  ): Promise<void> {
    const payload: Extract<ChiliEvent, { type: "goal.updated" }>["payload"] = { goal, reason };
    if (usageDelta) payload.usageDelta = usageDelta;
    const event: EventEnvelope<"goal.updated", typeof payload> = {
      id: this.id("event"),
      type: "goal.updated",
      time: this.now(),
      sessionId: input.sessionId,
      threadId: input.threadId,
      payload,
    };
    return this.options.store.append(event as ChiliEvent);
  }

  private projection(): GoalProjectionStore | undefined {
    const store = this.options.store;
    return store.threadGoal && store.threadGoals ? (store as EventStore & GoalProjectionStore) : undefined;
  }

  private defaultTokenBudget(): number {
    return Math.max(1, Math.trunc(this.options.defaultTokenBudget ?? DEFAULT_GOAL_TOKEN_BUDGET));
  }

  private id(prefix: string): string {
    return (this.options.createId ?? defaultCreateId)(prefix);
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

export function goalTokenDelta(usage: ModelUsage | undefined): number {
  if (!usage) return 0;
  const inputTokens = finitePositive(usage.inputTokens) ?? 0;
  const cacheReadInputTokens = finitePositive(usage.cacheReadInputTokens) ?? 0;
  const outputTokens = finitePositive(usage.outputTokens) ?? 0;
  const nonCachedInput = Math.max(0, inputTokens - cacheReadInputTokens);
  const direct = nonCachedInput + outputTokens;
  if (direct > 0) return direct;
  return finitePositive(usage.totalTokens) ?? 0;
}

export function cloneGoal(goal: ThreadGoal): ThreadGoal {
  const output: ThreadGoal = {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
  if (goal.sessionId) output.sessionId = goal.sessionId;
  if (goal.tokenBudget !== undefined) output.tokenBudget = goal.tokenBudget;
  if (goal.completedAt !== undefined) output.completedAt = goal.completedAt;
  if (goal.lastReason) output.lastReason = goal.lastReason;
  return output;
}

function reasonForStatus(status: ThreadGoalStatus | undefined): ThreadGoalUpdateReason | undefined {
  if (status === "active") return "resume";
  if (status === "paused") return "pause";
  if (status === "complete") return "complete";
  if (status === "budgetLimited") return "budget_limited";
  return undefined;
}

function finitePositive(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
