import type { ChiliEvent, EventEnvelope, Message, MessagePart, MessageRole, SessionId, TaskId } from "@chili/protocol";
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
  AgentTaskBeginRunCasInput,
  AgentTaskBeginRunResult,
  AgentTaskCapabilityStore,
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
  AgentTaskRunClaimStore,
  AgentTaskStoreCapability,
  ApprovalRow,
  EventAppendOptions,
  EventCommitAwareStore,
  EventQuery,
  EventStore,
  GoalProjectionStore,
  SessionGoalQuery,
  SessionGoalRow,
  SessionRow,
  StaleTurnRecoveryInput,
  StaleTurnRecoveryStore,
  SubagentProjectionStore,
  TeamMemberQuery,
  TeamMemberRow,
  TeamMessageDeliveryQuery,
  TeamMessageDeliveryRow,
  TeamMessageQuery,
  TeamMessageRow,
  TeamOwnerSessionBindInput,
  TeamOwnerSessionBindResult,
  TeamOwnerSessionBindStore,
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
} from "@chili/store";

export class PrintingEventStore
  implements
    EventStore,
    EventCommitAwareStore,
    StaleTurnRecoveryStore,
    GoalProjectionStore,
    SubagentProjectionStore,
    AgentTaskLeaseStore,
    AgentTaskCapabilityStore,
    AgentTaskRunClaimStore,
    AgentTaskFinalizationStore,
    AgentMailboxCapabilityStore,
    AgentMailboxDeliveryStore,
    TeamProjectionStore,
    TeamOwnerSessionBindStore,
    TeamTaskClaimStore,
    TeamTaskAgentSyncStore
{
  constructor(private readonly inner: EventStore, private readonly printer: CliPrinter) {}

  async append(event: ChiliEvent, options?: EventAppendOptions): Promise<void> {
    await this.appendCommitted(event, options);
  }

  async appendCommitted(event: ChiliEvent, options?: EventAppendOptions): Promise<boolean> {
    const aware = this.inner as EventStore & Partial<EventCommitAwareStore>;
    const committed = aware.appendCommitted
      ? await aware.appendCommitted(event, options)
      : (await this.inner.append(event, options), true);
    if (committed) this.printer.event(event);
    return committed;
  }

  async appendMany(
    events: readonly ChiliEvent[],
    options?: EventAppendOptions,
  ): Promise<void> {
    await this.appendManyCommitted(events, options);
  }

  async appendManyCommitted(
    events: readonly ChiliEvent[],
    options?: EventAppendOptions,
  ): Promise<readonly ChiliEvent[]> {
    const aware = this.inner as EventStore & Partial<EventCommitAwareStore>;
    const committed = aware.appendManyCommitted
      ? await aware.appendManyCommitted(events, options)
      : (await this.inner.appendMany(events, options), events);
    for (const event of committed) this.printer.event(event);
    return committed;
  }

  async reconcileStaleTurns(input: StaleTurnRecoveryInput): Promise<ChiliEvent[]> {
    const recovery = this.inner as EventStore & Partial<StaleTurnRecoveryStore>;
    if (!recovery.reconcileStaleTurns) return [];
    const events = await recovery.reconcileStaleTurns(input);
    for (const event of events) this.printer.event(event);
    return events;
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
    return this.goalProjectionStore()?.sessionGoal(sessionId) ?? Promise.resolve(undefined);
  }

  sessionGoals(query?: SessionGoalQuery): Promise<SessionGoalRow[]> {
    return this.goalProjectionStore()?.sessionGoals(query) ?? Promise.resolve([]);
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

  async beginAgentTaskRunCas(input: AgentTaskBeginRunCasInput): Promise<AgentTaskBeginRunResult> {
    const result = await (this.runClaimStore()?.beginAgentTaskRunCas(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.printer.event(event);
    return result;
  }

  async completeAgentTaskCas(input: AgentTaskCompleteCasInput): Promise<AgentTaskFinalizationResult> {
    const result = await (this.finalizationStore()?.completeAgentTaskCas(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.printer.event(event);
    return result;
  }

  async closeAgentTaskCas(input: AgentTaskCloseCasInput): Promise<AgentTaskFinalizationResult> {
    const result = await (this.finalizationStore()?.closeAgentTaskCas(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.printer.event(event);
    return result;
  }

  async claimAgentMailboxMessage(input: AgentMailboxClaimInput): Promise<AgentMailboxMutationResult> {
    const result = await (this.mailboxDeliveryStore()?.claimAgentMailboxMessage(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.printer.event(event);
    return result;
  }

  async consumeAgentMailboxMessage(input: AgentMailboxConsumeInput): Promise<AgentMailboxMutationResult> {
    const result = await (this.mailboxDeliveryStore()?.consumeAgentMailboxMessage(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.printer.event(event);
    return result;
  }

  async requeueAgentMailboxMessage(input: AgentMailboxRequeueInput): Promise<AgentMailboxMutationResult> {
    const result = await (this.mailboxDeliveryStore()?.requeueAgentMailboxMessage(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.printer.event(event);
    return result;
  }

  async discardAgentMailboxMessage(input: AgentMailboxDiscardInput): Promise<AgentMailboxMutationResult> {
    const result = await (this.mailboxDeliveryStore()?.discardAgentMailboxMessage(input) ??
      Promise.resolve({ applied: false, events: [] }));
    for (const event of result.events) this.printer.event(event);
    return result;
  }

  async claimTeamTask(input: TeamTaskClaimInput): Promise<TeamTaskMutationResult> {
    const result = await (this.teamTaskClaimStore()?.claimTeamTask(input) ??
      Promise.resolve({ applied: false, reason: "not_found" as const, events: [] }));
    for (const event of result.events) this.printer.event(event);
    return result;
  }

  async bindTeamOwnerSession(input: TeamOwnerSessionBindInput): Promise<TeamOwnerSessionBindResult> {
    const result = await (this.teamOwnerSessionBindStore()?.bindTeamOwnerSession(input) ??
      Promise.resolve({ applied: false, reason: "not_found" as const, events: [] }));
    for (const event of result.events) this.printer.event(event);
    return result;
  }

  async syncTeamTaskFromAgentCas(input: TeamTaskAgentSyncInput): Promise<TeamTaskAgentSyncResult> {
    const result = await (this.teamTaskAgentSyncStore()?.syncTeamTaskFromAgentCas(input) ??
      Promise.resolve({ applied: false, reason: "not_found" as const, events: [] }));
    for (const event of result.events) this.printer.event(event);
    return result;
  }

  private subagentStore(): SubagentProjectionStore | undefined {
    const inner = this.inner as EventStore & Partial<SubagentProjectionStore>;
    if (inner.agentTasks && inner.agentTask && inner.agentRuns && inner.agentMailbox) {
      return inner as SubagentProjectionStore;
    }
    return undefined;
  }

  private goalProjectionStore(): GoalProjectionStore | undefined {
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

  private finalizationStore(): AgentTaskFinalizationStore | undefined {
    const inner = this.inner as EventStore & Partial<AgentTaskFinalizationStore>;
    if (inner.completeAgentTaskCas && inner.closeAgentTaskCas) {
      return inner as EventStore & AgentTaskFinalizationStore;
    }
    return undefined;
  }

  private runClaimStore(): AgentTaskRunClaimStore | undefined {
    const inner = this.inner as EventStore & Partial<AgentTaskRunClaimStore>;
    if (inner.beginAgentTaskRunCas) return inner as EventStore & AgentTaskRunClaimStore;
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

  private teamOwnerSessionBindStore(): TeamOwnerSessionBindStore | undefined {
    const inner = this.inner as EventStore & Partial<TeamOwnerSessionBindStore>;
    if (inner.bindTeamOwnerSession) return inner as EventStore & TeamOwnerSessionBindStore;
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

export class CliPrinter {
  private needsNewline = false;
  private readonly roles = new Map<string, MessageRole>();
  private readonly partRoles = new Map<string, MessageRole | undefined>();
  private readonly partTypes = new Map<string, MessagePart["type"]>();

  event(event: ChiliEvent): void {
    if (event.type === "message.created") {
      this.roles.set(event.payload.messageId, event.payload.role);
      return;
    }

    if (event.type === "message.part_added") {
      const role = this.roles.get(event.payload.messageId);
      this.partRoles.set(event.payload.part.id, role);
      this.partTypes.set(event.payload.part.id, event.payload.part.type);
      this.part(event.payload.part, role);
      return;
    }

    if (event.type === "message.part_delta") {
      this.partDelta(event.payload.partId, event.payload.field, event.payload.delta);
      return;
    }

    if (event.type === "tool.call_updated" && event.payload.status === "waiting_for_approval") {
      this.line(`\n[tool] waiting for approval (${event.payload.callId})`);
      return;
    }

    if (event.type === "turn.retry_scheduled") {
      this.line(`\n[retry] attempt ${event.payload.attempt} in ${event.payload.delayMs}ms: ${event.payload.reason}`);
      return;
    }

    if (event.type === "turn.compaction_requested") {
      this.line(`\n[context] compaction boundary requested (${event.payload.estimatedChars}/${event.payload.budgetChars} chars)`);
      return;
    }

    if (event.type === "turn.compaction_started") {
      this.line(`\n[context] compacting ${event.payload.reason}`);
      return;
    }

    if (event.type === "turn.compaction_completed") {
      this.line(
        `\n[context] compacted ${event.payload.sourceMessageCount} messages (${event.payload.estimatedCharsBefore} -> ${event.payload.estimatedCharsAfter} chars)`,
      );
      return;
    }

    if (event.type === "turn.compaction_failed") {
      this.line(`\n[context] compaction failed: ${event.payload.error}`);
      return;
    }

    if (event.type === "turn.guard_triggered") {
      this.line(`\n[guard] ${event.payload.reason} (${event.payload.count})`);
      return;
    }

    if (event.type === "agent.task_created") {
      this.line(`\n[task] ${event.payload.taskId} -> ${event.payload.path} (${event.payload.taskName})`);
      return;
    }

    if (event.type === "agent.spawned") {
      const parent = event.payload.parentPath ? ` parent=${event.payload.parentPath}` : "";
      this.line(`\n[agent] spawned ${event.payload.path} (${event.payload.taskName})${parent}`);
      return;
    }

    if (event.type === "agent.message_queued") {
      const trigger = event.payload.triggerTurn ? " trigger=turn" : "";
      this.line(`\n[agent] message queued ${event.payload.from} -> ${event.payload.path}${trigger}`);
      return;
    }

    if (event.type === "agent.message_claimed") {
      this.line(`\n[agent] message claimed ${event.payload.messageId}`);
      return;
    }

    if (event.type === "agent.message_requeued") {
      const error = event.payload.error ? ` error=${event.payload.error}` : "";
      this.line(`\n[agent] message requeued ${event.payload.messageId}${error}`);
      return;
    }

    if (event.type === "agent.message_consumed") {
      this.line(`\n[agent] message consumed ${event.payload.messageId}`);
      return;
    }

    if (event.type === "agent.completed") {
      this.line(`\n[agent] completed ${event.payload.path}: ${event.payload.status}`);
      return;
    }

    if (event.type === "agent.task_completed") {
      this.line(`\n[task] ${event.payload.taskId}: ${event.payload.status}`);
      return;
    }

    if (event.type === "team.task_created") {
      const owner = event.payload.ownerPath ? ` owner=${event.payload.ownerPath}` : "";
      this.line(`\n[task] created ${event.payload.taskId} team=${event.payload.teamId}${owner}`);
      return;
    }

    if (event.type === "team.task_updated") {
      this.line(`\n[task] ${event.payload.taskId}: ${event.payload.status}`);
      return;
    }

    if (event.type === "snapshot.created") {
      this.line(`\n[snapshot] ${event.payload.snapshotId} ${event.payload.paths.join(", ")}`);
    }
  }

  private part(part: MessagePart, role: MessageRole | undefined): void {
    if (role !== "assistant") return;

    if (part.type === "text") {
      process.stdout.write(part.text);
      this.needsNewline = true;
      return;
    }

    if (part.type === "tool_call") {
      this.line(`\n[tool] ${part.toolName} ${formatJson(part.input)}`);
      return;
    }

    if (part.type === "tool_result") {
      if (part.error) {
        this.line(`[tool:error] ${part.error}`);
      } else {
        this.line(`[tool:result] ${truncate(part.output, 1600)}`);
      }
    }
  }

  private partDelta(partId: string, field: string, delta: string): void {
    if (field !== "text") return;
    if (this.partRoles.get(partId) !== "assistant") return;
    if (this.partTypes.get(partId) !== "text") return;
    process.stdout.write(delta);
    this.needsNewline = true;
  }

  line(text = ""): void {
    if (this.needsNewline) {
      process.stdout.write("\n");
      this.needsNewline = false;
    }
    console.log(text);
  }
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[cli output truncated]`;
}
