import type {
  AgentPath,
  ChiliEvent,
  EventEnvelope,
  SessionId,
  TaskId,
  TeamEvent,
  TeamId,
  TeamMemberStatus as ProtocolTeamMemberStatus,
  TeamMessageKind,
  TeamTaskStatus as ProtocolTeamTaskStatus,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type {
  EventStore,
  TeamMemberRow,
  TeamMessageRow,
  TeamProjectionStore,
  TeamRow,
  TeamTaskClaimStore,
  TeamTaskMutationResult,
  TeamTaskRow,
} from "@chili/store";

export type TeamMemberStatus = ProtocolTeamMemberStatus;
export type TeamTaskStatus = ProtocolTeamTaskStatus;

export interface TeamRuntime {
  createTeam(input: CreateTeamInput): Promise<TeamRow>;
  addMember(input: AddTeamMemberInput): Promise<TeamMemberRow>;
  createTask(input: CreateTeamTaskInput): Promise<TeamTaskRow>;
  assignTask(input: AssignTeamTaskInput): Promise<TeamTaskRow>;
  claimTask(input: ClaimTeamTaskInput): Promise<TeamTaskMutationResult>;
  updateTask(input: UpdateTeamTaskInput): Promise<TeamTaskRow>;
  sendMessage(input: SendTeamMessageInput): Promise<TeamMessageRow>;
}

export interface TeamControlServiceOptions {
  store: EventStore & TeamProjectionStore & Partial<TeamTaskClaimStore>;
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
  messageSummary?: string;
}

export interface ClaimTeamTaskInput extends TeamEventContext {
  teamId: TeamId;
  taskId: TaskId;
  ownerPath: AgentPath;
  claimedBy?: AgentPath;
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
  taskId?: TaskId;
  summary?: string;
  metadata?: Record<string, unknown>;
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
            from: input.assignedBy ?? task.createdBy ?? input.ownerPath,
            to: input.ownerPath,
            content: input.message,
            kind: "task_assignment" as const,
            taskId: input.taskId,
            summary: input.messageSummary,
          }),
        ),
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
    if (ownerPath && input.status && isFinalTeamTaskStatus(input.status)) {
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
    await this.options.store.append(
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
          taskId: input.taskId,
          summary: input.summary,
          metadata: input.metadata,
        }),
      ),
    );
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

  private id<T extends string>(prefix: string): T {
    const create = this.options.createId ?? defaultCreateId;
    return create(prefix) as T;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }
}

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
