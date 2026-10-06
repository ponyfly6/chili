import type { RuntimeEvent, EventEnvelope, Message, SessionId } from "@chili/protocol";
import type { SessionInputMutation, SessionInputMutationOptions, SessionInputStore } from "./session-inputs.js";
import type {
  ApprovalRow,
  EventQuery,
  EventAppendOptions,
  EventCommitAwareStore,
  EventStore,
  GoalMutationCapabilityStore,
  GoalMutationDecision,
  GoalMutationResult,
  GoalMutationSnapshot,
  GoalMutationStore,
  GoalProjectionStore,
  SessionRow,
  AgentSessionStore,
  CreateChildSessionInput,
  CreateChildSessionResult,
  StaleTurnRecoveryInput,
  StaleTurnRecoveryStore,
  SessionGoalQuery,
  SessionGoalRow,
} from "./types.js";

export interface EventPublisher {
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}

export interface ObservableEventStoreOptions {
  onListenerError?: (error: unknown, event: RuntimeEvent) => void;
}

export class ObservableEventStore
  implements
    EventStore,
    EventCommitAwareStore,
    EventPublisher,
    StaleTurnRecoveryStore,
    GoalMutationCapabilityStore,
    GoalMutationStore,
    GoalProjectionStore
{
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(
    private readonly inner: EventStore,
    private readonly options: ObservableEventStoreOptions = {},
  ) {}

  async append(event: RuntimeEvent, options?: EventAppendOptions): Promise<void> {
    await this.appendCommitted(event, options);
  }

  supportsSessionInputs(): boolean {
    const store = this.inner as EventStore & Partial<SessionInputStore>;
    return !!store.mutateSessionInputs && store.supportsSessionInputs?.() !== false;
  }

  private inputStore(): SessionInputStore {
    if (!this.supportsSessionInputs()) throw new Error("Store does not support durable session inputs");
    return this.inner as EventStore & SessionInputStore;
  }

  sessionInputQueue(sessionId: SessionId) { return this.inputStore().sessionInputQueue(sessionId); }

  sessionInput(sessionId: SessionId, submissionId: string) { return this.inputStore().sessionInput(sessionId, submissionId); }

  sessionInputById(sessionId: SessionId, inputId: string) { return this.inputStore().sessionInputById(sessionId, inputId); }

  mutateSessionInputs(input: SessionInputMutation, options?: SessionInputMutationOptions) {
    const result = this.inputStore().mutateSessionInputs(input, options);
    for (const event of result.events) this.emit(event);
    return result;
  }

  async session(sessionId: SessionId): Promise<SessionRow | undefined> {
    const store = this.inner as EventStore & Partial<AgentSessionStore>;
    return store.session ? store.session(sessionId) : (await store.sessions()).find((session) => session.id === sessionId);
  }

  async childSessions(parentSessionId: SessionId): Promise<SessionRow[]> {
    const store = this.inner as EventStore & Partial<AgentSessionStore>;
    return store.childSessions ? store.childSessions(parentSessionId) : (await store.sessions()).filter((session) => session.agent?.parentSessionId === parentSessionId);
  }

  async createChildSession(input: CreateChildSessionInput): Promise<CreateChildSessionResult> {
    const store = this.inner as EventStore & Partial<AgentSessionStore>;
    if (!store.createChildSession) throw new Error("Store does not support atomic Agent creation");
    const result = await store.createChildSession(input);
    for (const event of result.events) this.emit(event);
    return result;
  }

  async appendCommitted(event: RuntimeEvent, options?: EventAppendOptions): Promise<boolean> {
    assertCurrentEvent(event);
    const aware = this.inner as EventStore & Partial<EventCommitAwareStore>;
    const committed = aware.appendCommitted
      ? await aware.appendCommitted(event, options)
      : (await this.inner.append(event, options), true);
    if (committed) this.emit(event);
    return committed;
  }

  async appendMany(
    events: readonly RuntimeEvent[],
    options?: EventAppendOptions,
  ): Promise<void> {
    await this.appendManyCommitted(events, options);
  }

  async appendManyCommitted(
    events: readonly RuntimeEvent[],
    options?: EventAppendOptions,
  ): Promise<readonly RuntimeEvent[]> {
    for (const event of events) assertCurrentEvent(event);
    const aware = this.inner as EventStore & Partial<EventCommitAwareStore>;
    const committed = aware.appendManyCommitted
      ? await aware.appendManyCommitted(events, options)
      : (await this.inner.appendMany(events, options), events);
    for (const event of committed) this.emit(event);
    return committed;
  }

  async reconcileStaleTurns(input: StaleTurnRecoveryInput): Promise<RuntimeEvent[]> {
    const recovery = this.inner as EventStore & Partial<StaleTurnRecoveryStore>;
    if (!recovery.reconcileStaleTurns) return [];
    const events = await recovery.reconcileStaleTurns(input);
    // The inner store has already committed these events atomically. Emit them
    // directly so live SSE subscribers observe recovery without re-appending.
    for (const event of events) this.emit(event);
    return events;
  }

  events(query?: EventQuery): Promise<EventEnvelope[]> {
    return this.inner.events(query);
  }

  sessions(): Promise<SessionRow[]> {
    return this.inner.sessions();
  }

  sessionRunClaim(sessionId: SessionId): { claimId: string; leaseExpiresAt: number } | undefined {
    const store = this.inner as EventStore & {
      sessionRunClaim?: (sessionId: SessionId) => { claimId: string; leaseExpiresAt: number } | undefined;
    };
    return store.sessionRunClaim?.(sessionId);
  }

  messages(sessionId: SessionId): Promise<Message[]> {
    return this.inner.messages(sessionId);
  }

  pendingApprovals(sessionId?: SessionId, limit?: number): Promise<ApprovalRow[]> {
    return this.inner.pendingApprovals(sessionId, limit);
  }

  sessionGoal(sessionId: SessionId): Promise<SessionGoalRow | undefined> {
    return this.goalStore()?.sessionGoal(sessionId) ?? Promise.resolve(undefined);
  }

  sessionGoals(query?: SessionGoalQuery): Promise<SessionGoalRow[]> {
    return this.goalStore()?.sessionGoals(query) ?? Promise.resolve([]);
  }

  supportsGoalMutation(): boolean {
    return this.goalMutationStore() !== undefined;
  }

  async mutateGoal<T>(
    sessionId: SessionId,
    decide: (snapshot: GoalMutationSnapshot) => GoalMutationDecision<T>,
    options?: EventAppendOptions,
  ): Promise<GoalMutationResult<T>> {
    const store = this.goalMutationStore();
    if (!store) throw new Error("Inner event store does not support atomic goal mutations");
    const result = await store.mutateGoal(sessionId, decide, options);
    for (const event of result.events) this.emit(event);
    return result;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.listeners.delete(listener);
        try {
          this.options.onListenerError?.(error, event);
        } catch {
          // Diagnostics must not change the outcome of an already committed event.
        }
      }
    }
  }

  private goalStore(): GoalProjectionStore | undefined {
    const inner = this.inner as EventStore & Partial<GoalProjectionStore>;
    if (inner.sessionGoal && inner.sessionGoals) {
      return inner as EventStore & GoalProjectionStore;
    }
    return undefined;
  }

  private goalMutationStore(): GoalMutationStore | undefined {
    const inner = this.inner as EventStore
      & Partial<GoalMutationStore>
      & Partial<GoalMutationCapabilityStore>;
    if (!inner.mutateGoal || (inner.supportsGoalMutation && !inner.supportsGoalMutation())) return undefined;
    return inner as EventStore & GoalMutationStore;
  }

}

function assertCurrentEvent(event: RuntimeEvent): void {
  if (event.type.startsWith("agent.") || event.type.startsWith("team.")) {
    throw new Error("Legacy workflow events are read-only");
  }
}
