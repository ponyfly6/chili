import type {
  AgentMessageQueuedPayload,
  AgentPath,
  ChiliEvent,
  EventEnvelope,
  SessionId,
  TaskId,
  TeamEvent,
  TeamId,
  TeamMemberStatus as ProtocolTeamMemberStatus,
  TeamMessageDelivery,
  TeamMessageKind,
  TeamTaskStatus as ProtocolTeamTaskStatus,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type {
  EventStore,
  TeamMemberRow,
  TeamMessageDeliveryRow,
  TeamMessageRow,
  TeamProjectionStore,
  TeamRow,
  TeamTaskClaimStore,
  TeamTaskMutationResult,
  TeamTaskRow,
  TeamTaskVerificationClaimResult,
  TeamTaskVerificationClaimStore,
} from "@chili/store";

export type TeamMemberStatus = ProtocolTeamMemberStatus;
export type TeamTaskStatus = ProtocolTeamTaskStatus;

export interface TeamRuntime {
  createTeam(input: CreateTeamInput): Promise<TeamRow>;
  addMember(input: AddTeamMemberInput): Promise<TeamMemberRow>;
  createTask(input: CreateTeamTaskInput): Promise<TeamTaskRow>;
  assignTask(input: AssignTeamTaskInput): Promise<TeamTaskRow>;
  claimTask(input: ClaimTeamTaskInput): Promise<TeamTaskMutationResult>;
  claimTaskVerification(input: ClaimTeamTaskVerificationInput): Promise<TeamTaskVerificationClaimResult>;
  updateTask(input: UpdateTeamTaskInput): Promise<TeamTaskRow>;
  sendMessage(input: SendTeamMessageInput): Promise<TeamMessageRow>;
  snapshot(teamId: TeamId): Promise<TeamSnapshot>;
}

export interface TeamControlServiceOptions {
  store: EventStore & TeamProjectionStore & Partial<TeamTaskClaimStore> & Partial<TeamTaskVerificationClaimStore>;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
}

export interface TeamEventContext {
  sessionId?: SessionId;
  threadId?: ThreadId;
}

export interface CreateTeamInput extends TeamEventContext {
  teamId?: TeamId;
  name: string;
  leadPath: AgentPath;
  description?: string;
  leadName?: string;
  leadRole?: string;
  leadStatus?: TeamMemberStatus;
  leadWriteScope?: string[];
}

export interface AddTeamMemberInput extends TeamEventContext {
  teamId: TeamId;
  path: AgentPath;
  name: string;
  role: string;
  status?: TeamMemberStatus;
  childSessionId?: SessionId;
  childThreadId?: ThreadId;
  model?: string;
  toolScope?: string[];
  writeScope?: string[];
}

export interface CreateTeamTaskInput extends TeamEventContext {
  teamId: TeamId;
  taskId?: TaskId;
  title: string;
  description?: string;
  createdBy?: AgentPath;
  ownerPath?: AgentPath;
  dependsOn?: TaskId[];
  status?: TeamTaskStatus;
  metadata?: Record<string, unknown>;
}

export interface AssignTeamTaskInput extends TeamEventContext {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath: AgentPath;
  assignedBy?: AgentPath;
  message?: string;
  messageDelivery?: TeamMessageDelivery;
  messageSummary?: string;
}

export interface ClaimTeamTaskInput extends TeamEventContext {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath: AgentPath;
  claimedBy?: AgentPath;
}

export interface ClaimTeamTaskVerificationInput extends TeamEventContext {
  teamId: TeamId;
  taskId: TaskId;
  metadata: Record<string, unknown>;
  stalePendingBefore?: number;
}

export interface UpdateTeamTaskInput extends TeamEventContext {
  teamId: TeamId;
  taskId: TaskId;
  status?: TeamTaskStatus;
  ownerPath?: AgentPath;
  title?: string;
  description?: string;
  dependsOn?: TaskId[];
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SendTeamMessageInput extends TeamEventContext {
  teamId: TeamId;
  messageId?: string;
  from: AgentPath;
  to: AgentPath | "*";
  content: string;
  kind?: TeamMessageKind;
  delivery?: TeamMessageDelivery;
  taskId?: TaskId;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface TeamSnapshot {
  team: TeamRow;
  members: TeamSnapshotMember[];
  tasks: TeamSnapshotTask[];
  messages: TeamSnapshotMessage[];
  messageDeliveries: TeamMessageDeliveryRow[];
  stats: TeamSnapshotStats;
  generatedAt: number;
}

export interface TeamSnapshotMember extends TeamMemberRow {
  taskIds: TaskId[];
  deliveryIds: string[];
  currentTask?: TeamTaskRow;
}

export interface TeamSnapshotTask extends TeamTaskRow {
  blockedBy: TaskId[];
  blocks: TaskId[];
  ready: boolean;
  messageIds: string[];
  owner?: TeamMemberRow;
  dispatch?: unknown;
}

export interface TeamSnapshotMessage extends TeamMessageRow {
  deliveries: TeamMessageDeliveryRow[];
}

export interface TeamSnapshotStats {
  memberCount: number;
  taskCount: number;
  messageCount: number;
  deliveryCount: number;
  membersByStatus: Record<TeamMemberStatus, number>;
  tasksByStatus: Record<TeamTaskStatus, number>;
  messagesByDeliveryStatus: Record<string, number>;
  deliveriesByStatus: Record<string, number>;
  readyTaskIds: TaskId[];
  blockedTaskIds: TaskId[];
}

export class TeamNotFoundError extends Error {
  constructor(readonly teamId: TeamId) {
    super(`Team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}

export class TeamMemberNotFoundError extends Error {
  constructor(readonly teamId: TeamId, readonly path: AgentPath) {
    super(`Team member not found: ${path} in ${teamId}`);
    this.name = "TeamMemberNotFoundError";
  }
}

export class TeamTaskNotFoundError extends Error {
  constructor(readonly teamId: TeamId, readonly taskId: TaskId) {
    super(`Team task not found: ${taskId} in ${teamId}`);
    this.name = "TeamTaskNotFoundError";
  }
}

export class TeamTaskClaimError extends Error {
  constructor(
    readonly teamId: TeamId,
    readonly taskId: TaskId,
    readonly reason: NonNullable<TeamTaskMutationResult["reason"]>,
  ) {
    super(`Team task claim failed: ${taskId} in ${teamId} (${reason})`);
    this.name = "TeamTaskClaimError";
  }
}

export class TeamMessageDeliveryError extends Error {
  constructor(readonly teamId: TeamId, readonly target: AgentPath | "*", readonly reason: string) {
    super(`Team message delivery failed for ${target} in ${teamId}: ${reason}`);
    this.name = "TeamMessageDeliveryError";
  }
}

export class TeamControlService implements TeamRuntime {
  constructor(private readonly options: TeamControlServiceOptions) {}

  async createTeam(input: CreateTeamInput): Promise<TeamRow> {
    const teamId = input.teamId ?? this.id<TeamId>("team");
    await this.options.store.appendMany([
      this.teamEvent(
        input,
        "team.created",
        pruneUndefined({
          teamId,
          name: input.name,
          leadPath: input.leadPath,
          description: input.description,
        }),
      ),
      this.teamEvent(
        input,
        "team.member_added",
        pruneUndefined({
          teamId,
          path: input.leadPath,
          name: input.leadName ?? "team-lead",
          role: input.leadRole ?? "leader",
          status: input.leadStatus ?? "running",
          writeScope: input.leadWriteScope,
        }),
      ),
    ]);
    return this.requireTeam(teamId);
  }

  async addMember(input: AddTeamMemberInput): Promise<TeamMemberRow> {
    await this.requireTeam(input.teamId);
    await this.options.store.append(
      this.teamEvent(
        input,
        "team.member_added",
        pruneUndefined({
          teamId: input.teamId,
          path: input.path,
          name: input.name,
          role: input.role,
          status: input.status,
          childSessionId: input.childSessionId,
          childThreadId: input.childThreadId,
          model: input.model,
          toolScope: input.toolScope,
          writeScope: input.writeScope,
        }),
      ),
    );
    return this.requireMember(input.teamId, input.path);
  }

  async createTask(input: CreateTeamTaskInput): Promise<TeamTaskRow> {
    await this.requireTeam(input.teamId);
    const taskId = input.taskId ?? this.id<TaskId>("task");
    await this.options.store.append(
      this.teamEvent(
        input,
        "team.task_created",
        pruneUndefined({
          teamId: input.teamId,
          taskId,
          title: input.title,
          description: input.description,
          createdBy: input.createdBy,
          ownerPath: input.ownerPath,
          dependsOn: input.dependsOn,
          status: input.status,
          metadata: input.metadata,
        }),
      ),
    );
    return this.requireTask(input.teamId, taskId);
  }

  async assignTask(input: AssignTeamTaskInput): Promise<TeamTaskRow> {
    const task = await this.requireTask(input.teamId, input.taskId);
    await this.requireMember(input.teamId, input.ownerPath);

    const messageId = input.message ? this.id("teammsg") : undefined;
    const messageFrom = input.assignedBy ?? task.createdBy ?? input.ownerPath;
    const messageDelivery = input.messageDelivery ?? "queueOnly";
    const events: ChiliEvent[] = [
      this.teamEvent(
        input,
        "team.task_assigned",
        pruneUndefined({
          teamId: input.teamId,
          taskId: input.taskId,
          ownerPath: input.ownerPath,
          assignedBy: input.assignedBy,
          previousOwnerPath: task.ownerPath,
          messageId,
        }),
      ),
    ];
    if (input.message && messageId) {
      events.push(
        this.teamEvent(
          input,
          "team.message_sent",
          pruneUndefined({
            teamId: input.teamId,
            messageId,
            from: messageFrom,
            to: input.ownerPath,
            content: input.message,
            kind: "task_assignment" as const,
            delivery: messageDelivery,
            taskId: input.taskId,
            summary: input.messageSummary,
          }),
        ),
      );
      events.push(
        ...(await this.teamMessageDeliveryEvents(input, {
          teamId: input.teamId,
          messageId,
          from: messageFrom,
          to: input.ownerPath,
          content: input.message,
          kind: "task_assignment",
          delivery: messageDelivery,
          taskId: input.taskId,
          summary: input.messageSummary,
          strict: false,
        })),
      );
    }

    await this.options.store.appendMany(events);
    return this.requireTask(input.teamId, input.taskId);
  }

  async claimTask(input: ClaimTeamTaskInput): Promise<TeamTaskMutationResult> {
    await this.requireTeam(input.teamId);
    await this.requireMember(input.teamId, input.ownerPath);
    const claimStore = this.options.store.claimTeamTask;
    if (!claimStore) {
      throw new Error("Team task CAS store is not available");
    }

    const result = await claimStore.call(this.options.store, {
      teamId: input.teamId,
      taskId: input.taskId,
      ownerPath: input.ownerPath,
      eventId: this.id("event"),
      ...(input.claimedBy ? { claimedBy: input.claimedBy } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      time: this.now(),
    });
    if (!result.applied && result.reason === "not_found") {
      throw new TeamTaskNotFoundError(input.teamId, input.taskId);
    }
    return result;
  }

  async claimTaskVerification(input: ClaimTeamTaskVerificationInput): Promise<TeamTaskVerificationClaimResult> {
    await this.requireTeam(input.teamId);
    const claimStore = this.options.store.claimTeamTaskVerification;
    if (!claimStore) {
      throw new Error("Team task verification CAS store is not available");
    }

    const result = await claimStore.call(this.options.store, {
      teamId: input.teamId,
      taskId: input.taskId,
      metadata: input.metadata,
      eventId: this.id("event"),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.stalePendingBefore !== undefined ? { stalePendingBefore: input.stalePendingBefore } : {}),
      time: this.now(),
    });
    if (!result.applied && result.reason === "not_found") {
      throw new TeamTaskNotFoundError(input.teamId, input.taskId);
    }
    return result;
  }

  async updateTask(input: UpdateTeamTaskInput): Promise<TeamTaskRow> {
    const task = await this.requireTask(input.teamId, input.taskId);
    const ownerPath = input.ownerPath ?? task.ownerPath;
    const events: ChiliEvent[] = [
      this.teamEvent(
        input,
        "team.task_updated",
        pruneUndefined({
          teamId: input.teamId,
          taskId: input.taskId,
          status: input.status,
          ownerPath: input.ownerPath,
          title: input.title,
          description: input.description,
          dependsOn: input.dependsOn,
          summary: input.summary,
          error: input.error,
          metadata: input.metadata,
        }),
      ),
    ];
    if (ownerPath && input.status && input.status !== "in_progress") {
      events.push(
        this.teamEvent(
          input,
          "team.member_status_changed",
          pruneUndefined({
            teamId: input.teamId,
            path: ownerPath,
            status: "idle" as const,
            reason: `task_${input.status}`,
          }),
        ),
      );
    }
    await this.options.store.appendMany(events);
    return this.requireTask(input.teamId, input.taskId);
  }

  async sendMessage(input: SendTeamMessageInput): Promise<TeamMessageRow> {
    await this.requireTeam(input.teamId);
    const messageId = input.messageId ?? this.id("teammsg");
    const events: ChiliEvent[] = [
      this.teamEvent(
        input,
        "team.message_sent",
        pruneUndefined({
          teamId: input.teamId,
          messageId,
          from: input.from,
          to: input.to,
          content: input.content,
          kind: input.kind,
          delivery: input.delivery,
          taskId: input.taskId,
          summary: input.summary,
          metadata: input.metadata,
        }),
      ),
    ];
    if (input.delivery) {
      events.push(
        ...(await this.teamMessageDeliveryEvents(input, {
          teamId: input.teamId,
          messageId,
          from: input.from,
          to: input.to,
          content: input.content,
          kind: input.kind ?? "text",
          delivery: input.delivery,
          taskId: input.taskId,
          summary: input.summary,
          metadata: input.metadata,
          strict: true,
        })),
      );
    }
    await this.options.store.appendMany(events);
    const message = (await this.options.store.teamMessages({ teamId: input.teamId, limit: 500 })).find(
      (item) => item.id === messageId,
    );
    if (!message) throw new Error(`Team message was not projected: ${messageId}`);
    return message;
  }

  listTeams(): Promise<TeamRow[]> {
    return this.options.store.teams();
  }

  members(teamId: TeamId): Promise<TeamMemberRow[]> {
    return this.options.store.teamMembers({ teamId });
  }

  tasks(teamId: TeamId): Promise<TeamTaskRow[]> {
    return this.options.store.teamTasks({ teamId });
  }

  messages(teamId: TeamId): Promise<TeamMessageRow[]> {
    return this.options.store.teamMessages({ teamId });
  }

  async snapshot(teamId: TeamId): Promise<TeamSnapshot> {
    const team = await this.requireTeam(teamId);
    const [members, tasks, messages, messageDeliveries] = await Promise.all([
      this.options.store.teamMembers({ teamId }),
      this.options.store.teamTasks({ teamId }),
      this.options.store.teamMessages({ teamId }),
      this.options.store.teamMessageDeliveries({ teamId }),
    ]);
    return buildTeamSnapshot({
      team,
      members,
      tasks,
      messages,
      messageDeliveries,
      generatedAt: Number(this.now()),
    });
  }

  private async requireTeam(teamId: TeamId): Promise<TeamRow> {
    const team = (await this.options.store.teams({ teamId, limit: 1 }))[0];
    if (!team) throw new TeamNotFoundError(teamId);
    return team;
  }

  private async requireMember(teamId: TeamId, path: AgentPath): Promise<TeamMemberRow> {
    const member = (await this.options.store.teamMembers({ teamId, path, limit: 1 }))[0];
    if (!member) throw new TeamMemberNotFoundError(teamId, path);
    return member;
  }

  private async requireTask(teamId: TeamId, taskId: TaskId): Promise<TeamTaskRow> {
    const task = (await this.options.store.teamTasks({ teamId, taskId, limit: 1 }))[0];
    if (!task) throw new TeamTaskNotFoundError(teamId, taskId);
    return task;
  }

  private async teamMessageDeliveryEvents(
    context: TeamEventContext,
    input: TeamMessageDeliveryEventInput,
  ): Promise<ChiliEvent[]> {
    const members =
      input.to === "*"
        ? (await this.options.store.teamMembers({ teamId: input.teamId })).filter((member) => member.path !== input.from)
        : [await this.requireMember(input.teamId, input.to)];
    const events: ChiliEvent[] = [];
    for (const member of members) {
      if (!isDeliverableTeamMember(member)) {
        if (input.strict && input.to !== "*") {
          const reason = member.status === "closed" ? "target member is closed" : "target member has no child session/thread";
          throw new TeamMessageDeliveryError(input.teamId, input.to, reason);
        }
        continue;
      }
      events.push(
        this.agentMessageQueuedEvent(
          context,
          teamMessageToAgentMailboxPayload(member, {
            from: input.from,
            content: input.content,
            delivery: input.delivery,
            teamId: input.teamId,
            messageId: input.messageId,
            kind: input.kind,
            taskId: input.taskId,
            summary: input.summary,
            metadata: input.metadata,
          }),
        ),
      );
    }
    if (input.strict && events.length === 0) {
      throw new TeamMessageDeliveryError(input.teamId, input.to, "no deliverable members");
    }
    return events;
  }

  private teamEvent<TType extends TeamEvent["type"], TPayload>(
    context: TeamEventContext,
    type: TType,
    payload: TPayload,
  ): ChiliEvent {
    const event: EventEnvelope<TType, TPayload> = {
      id: this.id("event"),
      type,
      time: this.now(),
      payload,
    };
    if (context.sessionId) event.sessionId = context.sessionId;
    if (context.threadId) event.threadId = context.threadId;
    return event as ChiliEvent;
  }

  private agentMessageQueuedEvent(context: TeamEventContext, payload: AgentMessageQueuedPayload): ChiliEvent {
    const event: EventEnvelope<"agent.message_queued", AgentMessageQueuedPayload> = {
      id: this.id("agentmsg"),
      type: "agent.message_queued",
      time: this.now(),
      payload,
    };
    if (context.sessionId) event.sessionId = context.sessionId;
    if (context.threadId) event.threadId = context.threadId;
    return event;
  }

  private id<T extends string>(prefix: string): T {
    const create = this.options.createId ?? defaultCreateId;
    return create(prefix) as T;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

interface TeamMessageDeliveryEventInput {
  teamId: TeamId;
  messageId: string;
  from: AgentPath;
  to: AgentPath | "*";
  content: string;
  kind: TeamMessageKind;
  delivery: TeamMessageDelivery;
  taskId?: TaskId | undefined;
  summary?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  strict: boolean;
}

interface TeamMessageMailboxInput {
  from: AgentPath;
  content: string;
  delivery: TeamMessageDelivery;
  teamId: TeamId;
  messageId: string;
  kind: TeamMessageKind;
  taskId?: TaskId | undefined;
  summary?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

type DeliverableTeamMember = TeamMemberRow & {
  childSessionId: SessionId;
  childThreadId: ThreadId;
};

function isDeliverableTeamMember(member: TeamMemberRow): member is DeliverableTeamMember {
  return member.status !== "closed" && Boolean(member.childSessionId) && Boolean(member.childThreadId);
}

function teamMessageToAgentMailboxPayload(
  member: DeliverableTeamMember,
  input: TeamMessageMailboxInput,
): AgentMessageQueuedPayload {
  const payload: AgentMessageQueuedPayload = {
    path: member.path,
    from: input.from,
    triggerTurn: input.delivery === "triggerTurn",
    childSessionId: member.childSessionId,
    childThreadId: member.childThreadId,
    message: {
      role: "user",
      content: input.content,
      metadata: pruneUndefined({
        teamId: input.teamId,
        teamMessageId: input.messageId,
        teamMessageKind: input.kind,
        taskId: input.taskId,
        summary: input.summary,
        teamMessageMetadata: input.metadata,
      }),
    },
  };
  if (input.taskId) payload.taskId = input.taskId;
  return payload;
}

function buildTeamSnapshot(input: {
  team: TeamRow;
  members: TeamMemberRow[];
  tasks: TeamTaskRow[];
  messages: TeamMessageRow[];
  messageDeliveries: TeamMessageDeliveryRow[];
  generatedAt: number;
}): TeamSnapshot {
  const membersByPath = new Map(input.members.map((member) => [member.path, member]));
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const taskIdsByOwner = new Map<AgentPath, TaskId[]>();
  const deliveryIdsByPath = new Map<AgentPath, string[]>();
  const messageIdsByTask = new Map<TaskId, string[]>();
  const deliveriesByMessageId = new Map<string, TeamMessageDeliveryRow[]>();

  for (const task of input.tasks) {
    if (!task.ownerPath) continue;
    const ids = taskIdsByOwner.get(task.ownerPath) ?? [];
    ids.push(task.id);
    taskIdsByOwner.set(task.ownerPath, ids);
  }
  for (const message of input.messages) {
    if (!message.taskId) continue;
    const ids = messageIdsByTask.get(message.taskId) ?? [];
    ids.push(message.id);
    messageIdsByTask.set(message.taskId, ids);
  }
  for (const delivery of input.messageDeliveries) {
    const deliveryIds = deliveryIdsByPath.get(delivery.path) ?? [];
    deliveryIds.push(delivery.mailboxMessageId);
    deliveryIdsByPath.set(delivery.path, deliveryIds);
    const messageDeliveries = deliveriesByMessageId.get(delivery.teamMessageId) ?? [];
    messageDeliveries.push(delivery);
    deliveriesByMessageId.set(delivery.teamMessageId, messageDeliveries);
  }

  const tasks: TeamSnapshotTask[] = input.tasks.map((task) => {
    const blockedBy = task.dependsOn.filter((dependency) => !isCompletedDependency(tasksById.get(dependency)));
    const blocks = input.tasks.filter((candidate) => candidate.dependsOn.includes(task.id)).map((candidate) => candidate.id);
    const snapshotTask: TeamSnapshotTask = {
      ...task,
      blockedBy,
      blocks,
      ready: task.status === "pending" && blockedBy.length === 0,
      messageIds: messageIdsByTask.get(task.id) ?? [],
    };
    if (task.ownerPath) {
      const owner = membersByPath.get(task.ownerPath);
      if (owner) snapshotTask.owner = owner;
    }
    const dispatch = dispatchMetadata(task.metadata);
    if (dispatch !== undefined) snapshotTask.dispatch = dispatch;
    return snapshotTask;
  });

  const members: TeamSnapshotMember[] = input.members.map((member) => {
    const snapshotMember: TeamSnapshotMember = {
      ...member,
      taskIds: taskIdsByOwner.get(member.path) ?? [],
      deliveryIds: deliveryIdsByPath.get(member.path) ?? [],
    };
    if (member.currentTaskId) {
      const currentTask = tasksById.get(member.currentTaskId);
      if (currentTask) snapshotMember.currentTask = currentTask;
    }
    return snapshotMember;
  });

  const messages = input.messages.map((message): TeamSnapshotMessage => ({
    ...message,
    deliveries: deliveriesByMessageId.get(message.id) ?? [],
  }));

  const stats = teamSnapshotStats({ members, tasks, messages, deliveries: input.messageDeliveries });
  return {
    team: input.team,
    members,
    tasks,
    messages,
    messageDeliveries: input.messageDeliveries,
    stats,
    generatedAt: input.generatedAt,
  };
}

function isCompletedDependency(task: TeamTaskRow | undefined): boolean {
  return Boolean(task && task.status === "completed");
}

function dispatchMetadata(metadata: Record<string, unknown> | undefined): unknown {
  return metadata ? metadata.chiliTeamDispatch : undefined;
}

function teamSnapshotStats(input: {
  members: TeamSnapshotMember[];
  tasks: TeamSnapshotTask[];
  messages: TeamSnapshotMessage[];
  deliveries: TeamMessageDeliveryRow[];
}): TeamSnapshotStats {
  const membersByStatus = countByStatus(TEAM_MEMBER_STATUSES);
  for (const member of input.members) membersByStatus[member.status] += 1;

  const tasksByStatus = countByStatus(TEAM_TASK_STATUSES);
  for (const task of input.tasks) tasksByStatus[task.status] += 1;

  const messagesByDeliveryStatus: Record<string, number> = {};
  for (const message of input.messages) {
    const status = message.deliveryStatus ?? "none";
    messagesByDeliveryStatus[status] = (messagesByDeliveryStatus[status] ?? 0) + 1;
  }

  const deliveriesByStatus: Record<string, number> = {};
  for (const delivery of input.deliveries) {
    deliveriesByStatus[delivery.status] = (deliveriesByStatus[delivery.status] ?? 0) + 1;
  }

  return {
    memberCount: input.members.length,
    taskCount: input.tasks.length,
    messageCount: input.messages.length,
    deliveryCount: input.deliveries.length,
    membersByStatus,
    tasksByStatus,
    messagesByDeliveryStatus,
    deliveriesByStatus,
    readyTaskIds: input.tasks.filter((task) => task.ready).map((task) => task.id),
    blockedTaskIds: input.tasks.filter((task) => task.blockedBy.length > 0 || task.status === "blocked").map((task) => task.id),
  };
}

function countByStatus<T extends string>(statuses: readonly T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const status of statuses) counts[status] = 0;
  return counts;
}

const TEAM_MEMBER_STATUSES = ["idle", "running", "waiting", "blocked", "closed"] as const satisfies readonly TeamMemberStatus[];
const TEAM_TASK_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TeamTaskStatus[];

function isFinalTeamTaskStatus(status: TeamTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function pruneUndefined<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = item;
  }
  return output as T;
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}
