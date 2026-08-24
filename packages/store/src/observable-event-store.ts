import type { ChiliEvent, EventEnvelope, Message, SessionId, TaskId } from "@chili/protocol";
import type {
  AgentMailboxQuery,
  AgentMailboxRow,
  AgentMailboxCapabilityStore,
  AgentMailboxClaimInput,
  AgentMailboxConsumeInput,
  AgentMailboxDiscardInput,
  AgentMailboxDeliveryStore,
  AgentMailboxMutationResult,
  AgentMailboxRequeueInput,
  AgentMailboxStoreCapability,
  AgentRunQuery,
  AgentRunRow,
  AgentTaskCloseCasInput,
  AgentTaskBeginRunCasInput,
  AgentTaskBeginRunResult,
  AgentTaskCapabilityStore,
  AgentTaskStoreCapability,
  AgentTaskCompleteCasInput,
  AgentTaskFinalizationResult,
  AgentTaskFinalizationStore,
  AgentTaskLeaseClaimInput,
  AgentTaskLeaseReleaseInput,
  AgentTaskLeaseRenewInput,
  AgentTaskLeaseResult,
  AgentTaskLeaseStore,
  AgentTaskRunClaimStore,
  AgentTaskQuery,
  AgentTaskRow,
  ApprovalRow,
  EventQuery,
  EventStore,
  GoalProjectionStore,
  SessionRow,
  SubagentProjectionStore,
  TeamMemberQuery,
  TeamMemberRow,
  TeamMessageDeliveryQuery,
  TeamMessageDeliveryRow,
  TeamMessageQuery,
  TeamMessageRow,
  TeamProjectionStore,
  TeamQuery,
  TeamRow,
  TeamTaskClaimInput,
  TeamTaskClaimStore,
  TeamTaskAgentSyncInput,
  TeamTaskAgentSyncResult,
  TeamTaskAgentSyncStore,
  TeamTaskMutationResult,
  TeamTaskQuery,
  TeamTaskRow,
  TeamTaskVerificationClaimInput,
  TeamTaskVerificationClaimResult,
  TeamTaskVerificationClaimStore,
  SessionGoalQuery,
  SessionGoalRow,
} from "./types.js";

export interface EventPublisher {
  subscribe(listener: (event: ChiliEvent) => void): () => void;
}

export interface ObservableEventStoreOptions {
  onListenerError?: (error: unknown, event: ChiliEvent) => void;
}

export class ObservableEventStore
  implements
    EventStore,
    EventPublisher,
    GoalProjectionStore,
    SubagentProjectionStore,
    AgentTaskLeaseStore,
    AgentTaskCapabilityStore,
    AgentTaskRunClaimStore,
    AgentTaskFinalizationStore,
    AgentMailboxCapabilityStore,
    AgentMailboxDeliveryStore,
    TeamProjectionStore,
    TeamTaskClaimStore,
    TeamTaskAgentSyncStore,
    TeamTaskVerificationClaimStore
{
  private readonly listeners = new Set<(event: ChiliEvent) => void>();

  constructor(
    private readonly inner: EventStore,
    private readonly options: ObservableEventStoreOptions = {},
  ) {}

  async append(event: ChiliEvent): Promise<void> {
    await this.inner.append(event);
    this.emit(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    await this.inner.appendMany(events);
    for (const event of events) this.emit(event);
  }

  events(query?: EventQuery): Promise<EventEnvelope[]> {
    return this.inner.events(query);
  }

  sessions(): Promise<SessionRow[]> {
    return this.inner.sessions();
  }

  messages(sessionId: SessionId): Promise<Message[]> {
    return this.inner.messages(sessionId);
  }

  pendingApprovals(sessionId?: SessionId): Promise<ApprovalRow[]> {
    return this.inner.pendingApprovals(sessionId);
  }

  sessionGoal(sessionId: SessionId): Promise<SessionGoalRow | undefined> {
    return this.goalStore()?.sessionGoal(sessionId) ?? Promise.resolve(undefined);
  }

  sessionGoals(query?: SessionGoalQuery): Promise<SessionGoalRow[]> {
    return this.goalStore()?.sessionGoals(query) ?? Promise.resolve([]);
  }

  agentTasks(query?: AgentTaskQuery): Promise<AgentTaskRow[]> {
    return this.subagentStore()?.agentTasks(query) ?? Promise.resolve([]);
  }

  agentTask(taskId: TaskId): Promise<AgentTaskRow | undefined> {
    return this.subagentStore()?.agentTask(taskId) ?? Promise.resolve(undefined);
  }

  agentRuns(query?: AgentRunQuery): Promise<AgentRunRow[]> {
    return this.subagentStore()?.agentRuns(query) ?? Promise.resolve([]);
  }

  agentMailbox(query?: AgentMailboxQuery): Promise<AgentMailboxRow[]> {
    return this.subagentStore()?.agentMailbox(query) ?? Promise.resolve([]);
  }

  teams(query?: TeamQuery): Promise<TeamRow[]> {
    return this.teamProjectionStore()?.teams(query) ?? Promise.resolve([]);
  }

  teamMembers(query?: TeamMemberQuery): Promise<TeamMemberRow[]> {
    return this.teamProjectionStore()?.teamMembers(query) ?? Promise.resolve([]);
  }

  teamTasks(query?: TeamTaskQuery): Promise<TeamTaskRow[]> {
    return this.teamProjectionStore()?.teamTasks(query) ?? Promise.resolve([]);
  }

  teamMessages(query?: TeamMessageQuery): Promise<TeamMessageRow[]> {
    return this.teamProjectionStore()?.teamMessages(query) ?? Promise.resolve([]);
  }

  teamMessageDeliveries(query?: TeamMessageDeliveryQuery): Promise<TeamMessageDeliveryRow[]> {
    return this.teamProjectionStore()?.teamMessageDeliveries(query) ?? Promise.resolve([]);
  }

  claimAgentTaskLease(input: AgentTaskLeaseClaimInput): Promise<AgentTaskLeaseResult> {
    return this.leaseStore()?.claimAgentTaskLease(input) ?? Promise.resolve({ acquired: false });
  }

  renewAgentTaskLease(input: AgentTaskLeaseRenewInput): Promise<AgentTaskLeaseResult> {
    return this.leaseStore()?.renewAgentTaskLease(input) ?? Promise.resolve({ acquired: false });
  }

  releaseAgentTaskLease(input: AgentTaskLeaseReleaseInput): Promise<boolean> {
    return this.leaseStore()?.releaseAgentTaskLease(input) ?? Promise.resolve(false);
  }

  supportsAgentTaskCapability(capability: AgentTaskStoreCapability): boolean {
    const inner = this.inner as EventStore & Partial<AgentTaskCapabilityStore>;
    if (inner.supportsAgentTaskCapability) {
      return inner.supportsAgentTaskCapability(capability);
    }
    if (capability === "lease") return this.leaseStore() !== undefined;
    if (capability === "run-claim") return this.runClaimStore() !== undefined;
    return this.finalizationStore() !== undefined;
  }

  supportsAgentMailboxCapability(capability: AgentMailboxStoreCapability): boolean {
    const inner = this.inner as EventStore & Partial<AgentMailboxCapabilityStore>;
    if (inner.supportsAgentMailboxCapability) {
      return inner.supportsAgentMailboxCapability(capability);
    }
    return capability === "delivery" && this.mailboxDeliveryStore() !== undefined;
  }

  async completeAgentTaskCas(input: AgentTaskCompleteCasInput): Promise<AgentTaskFinalizationResult> {
    const result = await (this.finalizationStore()?.completeAgentTaskCas(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.emit(event);
    return result;
  }

  async beginAgentTaskRunCas(input: AgentTaskBeginRunCasInput): Promise<AgentTaskBeginRunResult> {
    const result = await (this.runClaimStore()?.beginAgentTaskRunCas(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.emit(event);
    return result;
  }

  async closeAgentTaskCas(input: AgentTaskCloseCasInput): Promise<AgentTaskFinalizationResult> {
    const result = await (this.finalizationStore()?.closeAgentTaskCas(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.emit(event);
    return result;
  }

  async claimAgentMailboxMessage(input: AgentMailboxClaimInput): Promise<AgentMailboxMutationResult> {
    const result = await (this.mailboxDeliveryStore()?.claimAgentMailboxMessage(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.emit(event);
    return result;
  }

  async consumeAgentMailboxMessage(input: AgentMailboxConsumeInput): Promise<AgentMailboxMutationResult> {
    const result = await (this.mailboxDeliveryStore()?.consumeAgentMailboxMessage(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.emit(event);
    return result;
  }

  async requeueAgentMailboxMessage(input: AgentMailboxRequeueInput): Promise<AgentMailboxMutationResult> {
    const result = await (this.mailboxDeliveryStore()?.requeueAgentMailboxMessage(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.emit(event);
    return result;
  }

  async discardAgentMailboxMessage(input: AgentMailboxDiscardInput): Promise<AgentMailboxMutationResult> {
    const result = await (this.mailboxDeliveryStore()?.discardAgentMailboxMessage(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.emit(event);
    return result;
  }

  async claimTeamTask(input: TeamTaskClaimInput): Promise<TeamTaskMutationResult> {
    const result = await (this.teamTaskClaimStore()?.claimTeamTask(input) ??
      Promise.resolve({ applied: false, reason: "not_found" as const, events: [] }));
    for (const event of result.events) this.emit(event);
    return result;
  }

  async claimTeamTaskVerification(input: TeamTaskVerificationClaimInput): Promise<TeamTaskVerificationClaimResult> {
    const result = await (this.teamTaskVerificationClaimStore()?.claimTeamTaskVerification(input) ??
      Promise.resolve({ applied: false, reason: "not_found" as const, events: [] }));
    for (const event of result.events) this.emit(event);
    return result;
  }

  async syncTeamTaskFromAgentCas(input: TeamTaskAgentSyncInput): Promise<TeamTaskAgentSyncResult> {
    const result = await (this.teamTaskAgentSyncStore()?.syncTeamTaskFromAgentCas(input) ??
      Promise.resolve({ applied: false, reason: "not_found" as const, events: [] }));
    for (const event of result.events) this.emit(event);
    return result;
  }

  subscribe(listener: (event: ChiliEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ChiliEvent): void {
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

  private subagentStore(): SubagentProjectionStore | undefined {
    const inner = this.inner as EventStore & Partial<SubagentProjectionStore>;
    if (inner.agentTasks && inner.agentTask && inner.agentRuns && inner.agentMailbox) {
      return inner as SubagentProjectionStore;
    }
    return undefined;
  }

  private goalStore(): GoalProjectionStore | undefined {
    const inner = this.inner as EventStore & Partial<GoalProjectionStore>;
    if (inner.sessionGoal && inner.sessionGoals) {
      return inner as EventStore & GoalProjectionStore;
    }
    return undefined;
  }

  private leaseStore(): AgentTaskLeaseStore | undefined {
    const inner = this.inner as EventStore & Partial<AgentTaskLeaseStore>;
    if (inner.claimAgentTaskLease && inner.renewAgentTaskLease && inner.releaseAgentTaskLease) {
      return inner as EventStore & AgentTaskLeaseStore;
    }
    return undefined;
  }

  private runClaimStore(): AgentTaskRunClaimStore | undefined {
    const inner = this.inner as EventStore & Partial<AgentTaskRunClaimStore>;
    if (inner.beginAgentTaskRunCas) return inner as EventStore & AgentTaskRunClaimStore;
    return undefined;
  }

  private finalizationStore(): AgentTaskFinalizationStore | undefined {
    const inner = this.inner as EventStore & Partial<AgentTaskFinalizationStore>;
    if (inner.completeAgentTaskCas && inner.closeAgentTaskCas) {
      return inner as EventStore & AgentTaskFinalizationStore;
    }
    return undefined;
  }

  private mailboxDeliveryStore(): AgentMailboxDeliveryStore | undefined {
    const inner = this.inner as EventStore
      & Partial<AgentMailboxDeliveryStore>
      & Partial<AgentMailboxCapabilityStore>;
    if (inner.supportsAgentMailboxCapability?.("delivery") === false) return undefined;
    if (
      inner.claimAgentMailboxMessage &&
      inner.consumeAgentMailboxMessage &&
      inner.requeueAgentMailboxMessage &&
      inner.discardAgentMailboxMessage
    ) {
      return inner as EventStore & AgentMailboxDeliveryStore;
    }
    return undefined;
  }

  private teamProjectionStore(): TeamProjectionStore | undefined {
    const inner = this.inner as EventStore & Partial<TeamProjectionStore>;
    if (inner.teams && inner.teamMembers && inner.teamTasks && inner.teamMessages && inner.teamMessageDeliveries) {
      return inner as EventStore & TeamProjectionStore;
    }
    return undefined;
  }

  private teamTaskClaimStore(): TeamTaskClaimStore | undefined {
    const inner = this.inner as EventStore & Partial<TeamTaskClaimStore>;
    if (inner.claimTeamTask) {
      return inner as EventStore & TeamTaskClaimStore;
    }
    return undefined;
  }

  private teamTaskVerificationClaimStore(): TeamTaskVerificationClaimStore | undefined {
    const inner = this.inner as EventStore & Partial<TeamTaskVerificationClaimStore>;
    if (inner.claimTeamTaskVerification) {
      return inner as EventStore & TeamTaskVerificationClaimStore;
    }
    return undefined;
  }

  private teamTaskAgentSyncStore(): TeamTaskAgentSyncStore | undefined {
    const inner = this.inner as EventStore & Partial<TeamTaskAgentSyncStore>;
    if (inner.syncTeamTaskFromAgentCas) {
      return inner as EventStore & TeamTaskAgentSyncStore;
    }
    return undefined;
  }
}
