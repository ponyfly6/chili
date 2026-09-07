import type {
  ChiliEvent,
  EventEnvelope,
  ModelUsage,
  SessionGoal,
  SessionGoalStatus,
  SessionGoalUpdateReason,
  SessionGoalUsageDelta,
  SessionId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type { EventStore, GoalProjectionStore } from "@chili/store";

export const DEFAULT_GOAL_TOKEN_BUDGET = 50_000;
const GOAL_REPLAY_PAGE_SIZE = 1_000;
// Services using the same store share short mutation queues. This coordinates
// in-process writers; it is not a transaction across separate store instances.
const goalMutationQueues = new WeakMap<EventStore, Map<SessionId, Promise<void>>>();

type GoalUpdatedEvent = Extract<ChiliEvent, { type: "goal.updated" }>;

/** Captures which budget ledger owned a model turn before that turn starts. */
export interface GoalUsageScope {
  readonly sessionId: SessionId;
  readonly goalEventId: string | null;
  readonly lastGoalEventId?: string;
  readonly accountStopped: boolean;
}

interface GoalUsageHistory {
  events: GoalUpdatedEvent[];
  goalEventId?: string;
  accountedTurnIds: Set<TurnId>;
}

export interface GoalServiceOptions {
  store: EventStore & Partial<GoalProjectionStore>;
  defaultTokenBudget?: number;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
}

export interface SetGoalInput {
  sessionId: SessionId;
  objective: string;
  tokenBudget?: number;
  replace?: boolean;
}

export interface UpdateGoalInput {
  sessionId: SessionId;
  status?: SessionGoalStatus;
  objective?: string;
  tokenBudget?: number;
  reason?: SessionGoalUpdateReason;
}

export interface ClearGoalInput {
  sessionId: SessionId;
}

export interface AccountGoalUsageInput {
  sessionId: SessionId;
  turnId: TurnId;
  usage?: ModelUsage;
  timeSeconds: number;
  /** Required for delayed in-flight accounting after pause/clear/recreation. */
  scope?: GoalUsageScope;
}

export interface AccountGoalUsageResult {
  goal?: SessionGoal;
  budgetLimited: boolean;
  usageDelta?: SessionGoalUsageDelta;
}

export class GoalAlreadyExistsError extends Error {
  constructor(readonly sessionId: SessionId) {
    super(`Goal already exists for session: ${sessionId}`);
    this.name = "GoalAlreadyExistsError";
  }
}

export class GoalNotFoundError extends Error {
  constructor(readonly sessionId: SessionId) {
    super(`No goal exists for session: ${sessionId}`);
    this.name = "GoalNotFoundError";
  }
}

export class GoalService {
  constructor(private readonly options: GoalServiceOptions) {}

  async getGoal(input: { sessionId: SessionId }): Promise<SessionGoal | undefined> {
    const projected = await this.projection()?.sessionGoal(input.sessionId);
    if (projected) return cloneGoal(projected);
    return this.replayGoal(input.sessionId);
  }

  setGoal(input: SetGoalInput): Promise<SessionGoal> {
    return this.withMutation(input.sessionId, () => this.setGoalUnlocked(input));
  }

  private async setGoalUnlocked(input: SetGoalInput): Promise<SessionGoal> {
    const objective = normalizeObjective(input.objective);
    const existing = await this.getGoal({ sessionId: input.sessionId });
    if (existing && !input.replace) throw new GoalAlreadyExistsError(input.sessionId);
    const tokenBudget = input.tokenBudget !== undefined
      ? positiveInteger(input.tokenBudget, "Goal token budget")
      : existing?.tokenBudget !== undefined
        ? positiveInteger(existing.tokenBudget, "Existing goal token budget")
        : this.defaultTokenBudget();
    if (input.replace && existing) assertBudgetAllowsReactivation(existing, tokenBudget);

    const now = this.now();
    const goal: SessionGoal = {
      sessionId: input.sessionId,
      objective,
      status: "active",
      tokenBudget,
      tokensUsed: input.replace && existing ? existing.tokensUsed : 0,
      timeUsedSeconds: input.replace && existing ? existing.timeUsedSeconds : 0,
      createdAt: input.replace && existing ? existing.createdAt : now,
      updatedAt: now,
      lastReason: existing ? "replace" : "set",
    };
    await this.appendGoalUpdated(input, goal, existing ? "replace" : "set");
    return cloneGoal(goal);
  }

  updateGoal(input: UpdateGoalInput): Promise<SessionGoal> {
    return this.withMutation(input.sessionId, () => this.updateGoalUnlocked(input));
  }

  /** Stop only the current active goal, without racing a completion or clear. */
  pauseActiveGoal(input: { sessionId: SessionId }): Promise<SessionGoal | undefined> {
    return this.withMutation(input.sessionId, async () => {
      const goal = await this.getGoal(input);
      return goal?.status === "active"
        ? this.updateGoalUnlocked({ ...input, status: "paused", reason: "pause" })
        : goal;
    });
  }

  private async updateGoalUnlocked(input: UpdateGoalInput): Promise<SessionGoal> {
    const existing = await this.getGoal({ sessionId: input.sessionId });
    if (!existing) throw new GoalNotFoundError(input.sessionId);
    const tokenBudget = input.tokenBudget === undefined
      ? existing.tokenBudget
      : positiveInteger(input.tokenBudget, "Goal token budget");
    if (input.status === "active") assertBudgetAllowsReactivation(existing, tokenBudget);
    const now = this.now();
    const reason = input.reason ?? reasonForStatus(input.status) ?? "external";
    const goal: SessionGoal = {
      ...existing,
      sessionId: input.sessionId,
      updatedAt: now,
      lastReason: reason,
    };
    if (input.objective !== undefined) {
      goal.objective = normalizeObjective(input.objective);
    }
    if (input.tokenBudget !== undefined && tokenBudget !== undefined) goal.tokenBudget = tokenBudget;
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

  clearGoal(input: ClearGoalInput): Promise<{ cleared: boolean; previousGoal?: SessionGoal }> {
    return this.withMutation(input.sessionId, () => this.clearGoalUnlocked(input));
  }

  private async clearGoalUnlocked(input: ClearGoalInput): Promise<{ cleared: boolean; previousGoal?: SessionGoal }> {
    const previousGoal = await this.getGoal({ sessionId: input.sessionId });
    if (!previousGoal) return { cleared: false };
    const event: EventEnvelope<"goal.cleared", Extract<ChiliEvent, { type: "goal.cleared" }>["payload"]> = {
      id: this.id("event"),
      type: "goal.cleared",
      time: this.now(),
      sessionId: input.sessionId,
      payload: {
        sessionId: input.sessionId,
        previousGoal,
        reason: "clear",
      },
    };
    await this.options.store.append(event as ChiliEvent);
    return { cleared: true, previousGoal: cloneGoal(previousGoal) };
  }

  captureUsage(input: { sessionId: SessionId; includeBudgetLimited?: boolean }): Promise<GoalUsageScope> {
    return this.withMutation(input.sessionId, async () => {
      const goal = await this.getGoal(input);
      const history = await this.usageHistory(input.sessionId);
      const lastGoalEventId = history.events.at(-1)?.id;
      return {
        sessionId: input.sessionId,
        goalEventId: goal ? history.goalEventId ?? null : null,
        ...(lastGoalEventId ? { lastGoalEventId } : {}),
        accountStopped: goal?.status === "active" || goal?.status === "complete"
          || (goal?.status === "budgetLimited" && input.includeBudgetLimited === true),
      };
    });
  }

  accountUsage(input: AccountGoalUsageInput): Promise<AccountGoalUsageResult> {
    return this.withMutation(input.sessionId, () => this.accountUsageUnlocked(input));
  }

  private async accountUsageUnlocked(input: AccountGoalUsageInput): Promise<AccountGoalUsageResult> {
    const existing = await this.getGoal({ sessionId: input.sessionId });
    if (!existing) return { budgetLimited: false };
    const history = await this.usageHistory(input.sessionId);
    if (input.scope) {
      if (!scopeOwnsGoal(input.scope, input.sessionId, history)) return { budgetLimited: false };
    } else if (existing.status !== "active" && existing.status !== "complete") {
      return { budgetLimited: false };
    }
    // runTurn reports final totals, not incremental deltas. The durable event
    // is the receipt, so retrying a lost append acknowledgement is also safe.
    if (history.accountedTurnIds.has(input.turnId)) {
      return { goal: cloneGoal(existing), budgetLimited: existing.status === "budgetLimited" };
    }

    const tokenDelta = goalTokenDelta(input.usage);
    const timeSeconds = finiteNonNegative(input.timeSeconds, "Goal usage timeSeconds");
    if (tokenDelta <= 0 && timeSeconds <= 0) {
      return { goal: cloneGoal(existing), budgetLimited: false };
    }

    const usageDelta: SessionGoalUsageDelta = {
      turnId: input.turnId,
      tokens: tokenDelta,
      timeSeconds,
    };
    if (input.usage?.inputTokens !== undefined) usageDelta.inputTokens = input.usage.inputTokens;
    if (input.usage?.outputTokens !== undefined) usageDelta.outputTokens = input.usage.outputTokens;
    if (input.usage?.cacheReadInputTokens !== undefined) usageDelta.cacheReadInputTokens = input.usage.cacheReadInputTokens;
    if (input.usage?.cacheCreationInputTokens !== undefined) {
      usageDelta.cacheCreationInputTokens = input.usage.cacheCreationInputTokens;
    }
    if (input.usage?.totalTokens !== undefined) usageDelta.totalTokens = input.usage.totalTokens;

    const tokensUsed = safeNonNegativeInteger(
      safeNonNegativeInteger(existing.tokensUsed, "Goal tokensUsed") + tokenDelta,
      "Goal tokensUsed",
    );
    const timeUsedSeconds = finiteNonNegative(
      finiteNonNegative(existing.timeUsedSeconds, "Goal timeUsedSeconds") + timeSeconds,
      "Goal timeUsedSeconds",
    );
    const budgetLimited = existing.status === "active" && existing.tokenBudget !== undefined && tokensUsed >= existing.tokenBudget;
    const goal: SessionGoal = {
      ...existing,
      sessionId: input.sessionId,
      status: budgetLimited ? "budgetLimited" : existing.status,
      tokensUsed,
      timeUsedSeconds,
      updatedAt: this.now(),
      lastReason: budgetLimited ? "budget_limited" : "usage",
    };
    await this.appendGoalUpdated(input, goal, budgetLimited ? "budget_limited" : "usage", usageDelta);
    return { goal: cloneGoal(goal), budgetLimited, usageDelta };
  }

  private async usageHistory(sessionId: SessionId): Promise<GoalUsageHistory> {
    const history: GoalUsageHistory = { events: [], accountedTurnIds: new Set() };
    let afterEventId: string | undefined;
    while (true) {
      const events = await this.options.store.events({
        sessionId,
        type: "goal.updated",
        ...(afterEventId ? { afterEventId } : {}),
        limit: GOAL_REPLAY_PAGE_SIZE,
      }) as GoalUpdatedEvent[];
      for (const event of events) {
        history.events.push(event);
        // replace deliberately retains the budget and its accounting ledger.
        // A fresh set after clear starts a new ledger, even at the same time.
        if (!history.goalEventId || event.payload.reason === "set") {
          history.goalEventId = event.id;
          history.accountedTurnIds.clear();
        }
        const turnId = event.payload.usageDelta?.turnId;
        if (turnId) history.accountedTurnIds.add(turnId);
      }
      if (events.length < GOAL_REPLAY_PAGE_SIZE) break;
      const nextAfterEventId = events.at(-1)?.id;
      if (!nextAfterEventId || nextAfterEventId === afterEventId) break;
      afterEventId = nextAfterEventId;
    }
    return history;
  }

  private withMutation<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    let queues = goalMutationQueues.get(this.options.store);
    if (!queues) {
      queues = new Map();
      goalMutationQueues.set(this.options.store, queues);
    }
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    queues.set(sessionId, settled);
    void settled.then(() => {
      if (queues.get(sessionId) === settled) queues.delete(sessionId);
    });
    return result;
  }

  private async replayGoal(sessionId: SessionId): Promise<SessionGoal | undefined> {
    let goal: SessionGoal | undefined;
    let afterEventId: string | undefined;
    while (true) {
      const events = await this.options.store.events({
        sessionId,
        ...(afterEventId ? { afterEventId } : {}),
        limit: GOAL_REPLAY_PAGE_SIZE,
      });
      for (const event of events) {
        if (event.type === "goal.updated") {
          const payload = event.payload as Extract<ChiliEvent, { type: "goal.updated" }>["payload"];
          goal = cloneGoal({ ...payload.goal, sessionId });
        } else if (event.type === "goal.cleared") {
          goal = undefined;
        }
      }
      if (events.length < GOAL_REPLAY_PAGE_SIZE) break;
      const nextAfterEventId = events.at(-1)?.id;
      if (!nextAfterEventId || nextAfterEventId === afterEventId) break;
      afterEventId = nextAfterEventId;
    }
    return goal;
  }

  private appendGoalUpdated(
    input: { sessionId: SessionId },
    goal: SessionGoal,
    reason: SessionGoalUpdateReason,
    usageDelta?: SessionGoalUsageDelta,
  ): Promise<void> {
    const payload: Extract<ChiliEvent, { type: "goal.updated" }>["payload"] = { goal, reason };
    if (usageDelta) payload.usageDelta = usageDelta;
    const event: EventEnvelope<"goal.updated", typeof payload> = {
      id: this.id("event"),
      type: "goal.updated",
      time: this.now(),
      sessionId: input.sessionId,
      payload,
    };
    return this.options.store.append(event as ChiliEvent);
  }

  private projection(): GoalProjectionStore | undefined {
    const store = this.options.store;
    return store.sessionGoal && store.sessionGoals ? (store as EventStore & GoalProjectionStore) : undefined;
  }

  private defaultTokenBudget(): number {
    return positiveInteger(
      this.options.defaultTokenBudget ?? DEFAULT_GOAL_TOKEN_BUDGET,
      "Default goal token budget",
    );
  }

  private id(prefix: string): string {
    return (this.options.createId ?? defaultCreateId)(prefix);
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

function scopeOwnsGoal(scope: GoalUsageScope, sessionId: SessionId, history: GoalUsageHistory): boolean {
  if (scope.sessionId !== sessionId || !history.goalEventId) return false;
  if (scope.goalEventId !== null) {
    return scope.accountStopped && scope.goalEventId === history.goalEventId;
  }
  // create_goal may run inside the first model turn. Charge that turn only if
  // exactly one new ledger was created since capture; a later clear/recreate
  // must not attach an old turn to the replacement goal.
  const previousIndex = scope.lastGoalEventId
    ? history.events.findIndex((event) => event.id === scope.lastGoalEventId)
    : -1;
  if (scope.lastGoalEventId && previousIndex < 0) return false;
  const created = history.events.slice(previousIndex + 1).filter((event) => event.payload.reason === "set");
  return created.length === 1 && created[0]?.id === history.goalEventId;
}

export function goalTokenDelta(usage: ModelUsage | undefined): number {
  if (!usage) return 0;
  const inputTokens = optionalSafeNonNegativeInteger(usage.inputTokens, "Goal usage inputTokens") ?? 0;
  const outputTokens = optionalSafeNonNegativeInteger(usage.outputTokens, "Goal usage outputTokens") ?? 0;
  const cacheReadInputTokens = optionalSafeNonNegativeInteger(
    usage.cacheReadInputTokens,
    "Goal usage cacheReadInputTokens",
  ) ?? 0;
  const cacheCreationInputTokens = optionalSafeNonNegativeInteger(
    usage.cacheCreationInputTokens,
    "Goal usage cacheCreationInputTokens",
  ) ?? 0;
  const totalTokens = optionalSafeNonNegativeInteger(usage.totalTokens, "Goal usage totalTokens");
  if (totalTokens !== undefined) return totalTokens;
  return safeNonNegativeInteger(
    inputTokens + cacheReadInputTokens + cacheCreationInputTokens + outputTokens,
    "Goal token usage delta",
  );
}

export function cloneGoal(goal: SessionGoal): SessionGoal {
  const output: SessionGoal = {
    sessionId: goal.sessionId,
    objective: goal.objective,
    status: goal.status,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
  if (goal.tokenBudget !== undefined) output.tokenBudget = goal.tokenBudget;
  if (goal.completedAt !== undefined) output.completedAt = goal.completedAt;
  if (goal.lastReason) output.lastReason = goal.lastReason;
  return output;
}

function reasonForStatus(status: SessionGoalStatus | undefined): SessionGoalUpdateReason | undefined {
  if (status === "active") return "resume";
  if (status === "paused") return "pause";
  if (status === "complete") return "complete";
  if (status === "budgetLimited") return "budget_limited";
  return undefined;
}

function normalizeObjective(value: string): string {
  const objective = typeof value === "string" ? value.trim() : "";
  if (!objective) throw new Error("Goal objective is required.");
  return objective;
}

function positiveInteger(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}

function optionalSafeNonNegativeInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  return safeNonNegativeInteger(value, field);
}

function safeNonNegativeInteger(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function finiteNonNegative(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number.`);
  }
  return value;
}

function assertBudgetAllowsReactivation(goal: SessionGoal, tokenBudget: number | undefined): void {
  if (tokenBudget === undefined || tokenBudget > goal.tokensUsed) return;
  throw new Error(
    `Goal token budget must exceed tokens used (${goal.tokensUsed}) before the goal can resume.`,
  );
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
