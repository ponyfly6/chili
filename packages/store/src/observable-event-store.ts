import type { ChiliEvent, EventEnvelope, Message, SessionId, TaskId } from "@chili/protocol";
import type {
  AgentMailboxQuery,
  AgentMailboxRow,
  AgentMailboxClaimInput,
  AgentMailboxConsumeInput,
  AgentMailboxDeliveryStore,
  AgentMailboxMutationResult,
  AgentMailboxRequeueInput,
  AgentRunQuery,
  AgentRunRow,
  AgentTaskCloseCasInput,
  AgentTaskCompleteCasInput,
  AgentTaskFinalizationResult,
  AgentTaskFinalizationStore,
  AgentTaskLeaseClaimInput,
  AgentTaskLeaseReleaseInput,
  AgentTaskLeaseRenewInput,
  AgentTaskLeaseResult,
  AgentTaskLeaseStore,
  AgentTaskQuery,
  AgentTaskRow,
  ApprovalRow,
  EventQuery,
  EventStore,
  SessionRow,
  SubagentProjectionStore,
  TeamMemberQuery,
  TeamMemberRow,
  TeamMessageQuery,
  TeamMessageRow,
  TeamProjectionStore,
  TeamQuery,
  TeamRow,
  TeamTaskClaimInput,
  TeamTaskClaimStore,
  TeamTaskMutationResult,
  TeamTaskQuery,
  TeamTaskRow,
} from "./types.js";

export interface EventPublisher {
  subscribe(listener: (event: ChiliEvent) => void): () => void;
}

export class ObservableEventStore
  implements
    EventStore,
    EventPublisher,
    SubagentProjectionStore,
    AgentTaskLeaseStore,
    AgentTaskFinalizationStore,
    AgentMailboxDeliveryStore,
    TeamProjectionStore,
    TeamTaskClaimStore
{
  private readonly listeners = new Set<(event: ChiliEvent) => void>();

  constructor(private readonly inner: EventStore) {}

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

  claimAgentTaskLease(input: AgentTaskLeaseClaimInput): Promise<AgentTaskLeaseResult> {
    return this.leaseStore()?.claimAgentTaskLease(input) ?? Promise.resolve({ acquired: false });
  }

  renewAgentTaskLease(input: AgentTaskLeaseRenewInput): Promise<AgentTaskLeaseResult> {
    return this.leaseStore()?.renewAgentTaskLease(input) ?? Promise.resolve({ acquired: false });
  }

  releaseAgentTaskLease(input: AgentTaskLeaseReleaseInput): Promise<boolean> {
    return this.leaseStore()?.releaseAgentTaskLease(input) ?? Promise.resolve(false);
  }

  async completeAgentTaskCas(input: AgentTaskCompleteCasInput): Promise<AgentTaskFinalizationResult> {
    const result = await (this.finalizationStore()?.completeAgentTaskCas(input) ??
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

  async claimTeamTask(input: TeamTaskClaimInput): Promise<TeamTaskMutationResult> {
    const result = await (this.teamTaskClaimStore()?.claimTeamTask(input) ??
      Promise.resolve({ applied: false, reason: "not_found" as const, events: [] }));
    for (const event of result.events) this.emit(event);
    return result;
  }

  subscribe(listener: (event: ChiliEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ChiliEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private subagentStore(): SubagentProjectionStore | undefined {
    const inner = this.inner as EventStore & Partial<SubagentProjectionStore>;
    if (inner.agentTasks && inner.agentTask && inner.agentRuns && inner.agentMailbox) {
      return inner as SubagentProjectionStore;
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

  private finalizationStore(): AgentTaskFinalizationStore | undefined {
    const inner = this.inner as EventStore & Partial<AgentTaskFinalizationStore>;
    if (inner.completeAgentTaskCas && inner.closeAgentTaskCas) {
      return inner as EventStore & AgentTaskFinalizationStore;
    }
    return undefined;
  }

  private mailboxDeliveryStore(): AgentMailboxDeliveryStore | undefined {
    const inner = this.inner as EventStore & Partial<AgentMailboxDeliveryStore>;
    if (inner.claimAgentMailboxMessage && inner.consumeAgentMailboxMessage && inner.requeueAgentMailboxMessage) {
      return inner as EventStore & AgentMailboxDeliveryStore;
    }
    return undefined;
  }

  private teamProjectionStore(): TeamProjectionStore | undefined {
    const inner = this.inner as EventStore & Partial<TeamProjectionStore>;
    if (inner.teams && inner.teamMembers && inner.teamTasks && inner.teamMessages) {
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
}
