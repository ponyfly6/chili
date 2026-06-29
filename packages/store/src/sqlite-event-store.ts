import { Database } from "bun:sqlite";
import type {
  AgentCompleteTaskPayload,
  AgentCompletedPayload,
  AgentMessageClaimedPayload,
  AgentMessageConsumedPayload,
  AgentMessageRequeuedPayload,
  AgentEvent,
  ApprovalEvent,
  ChiliEvent,
  EventEnvelope,
  AgentPath,
  AgentMailboxPayload,
  GoalEvent,
  Message,
  MessageId,
  MessageEvent,
  MessagePart,
  SessionId,
  TaskId,
  SessionEvent,
  TeamEvent,
  TeamId,
  TeamMessageDelivery,
  TeamMessageDeliveryStatus,
  ThreadGoal,
  ThreadGoalStatus,
  TeamTaskClaimedPayload,
  ThreadId,
  TimestampMs,
  ToolEvent,
  TurnId,
} from "@chili/protocol";
import { decodeJson, encodeJson } from "./json.js";
import { SQLITE_SCHEMA } from "./schema.js";
import type {
  AgentMailboxQuery,
  AgentMailboxRow,
  AgentMailboxClaimInput,
  AgentMailboxConsumeInput,
  AgentMailboxDeliveryStore,
  AgentMailboxMutationResult,
  AgentMailboxRequeueInput,
  AgentTaskCloseCasInput,
  AgentTaskCompleteCasInput,
  AgentTaskFinalizationResult,
  AgentTaskFinalizationStore,
  AgentTaskLeaseClaimInput,
  AgentTaskLeaseReleaseInput,
  AgentTaskLeaseRenewInput,
  AgentTaskLeaseResult,
  AgentTaskLeaseStore,
  AgentRunRow,
  AgentRunQuery,
  AgentTaskQuery,
  AgentTaskRow,
  ApprovalRow,
  EventMirror,
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
  TeamTaskMutationResult,
  TeamTaskQuery,
  TeamTaskRow,
  TeamTaskVerificationClaimInput,
  TeamTaskVerificationClaimResult,
  TeamTaskVerificationClaimStore,
  ThreadGoalQuery,
  ThreadGoalRow,
} from "./types.js";

interface StoredEventRow {
  seq: number;
  id: string;
  type: string;
  time: number;
  session_id: string | null;
  thread_id: string | null;
  payload_json: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  thread_id: string | null;
  turn_id: string | null;
  role: "system" | "user" | "assistant" | "tool";
  parent_id: string | null;
  created_at: number;
}

interface PartRow {
  data_json: string;
}

interface ThreadGoalProjectionRow {
  thread_id: string;
  session_id: string | null;
  objective: string;
  status: ThreadGoalStatus;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  last_reason: string | null;
}

interface AgentTaskProjectionRow {
  id: string;
  path: string;
  parent_path: string | null;
  parent_session_id: string | null;
  parent_thread_id: string | null;
  child_session_id: string | null;
  child_thread_id: string | null;
  task_name: string;
  cwd: string | null;
  prompt: string | null;
  mode: string | null;
  status: string;
  current_run_id: string | null;
  summary: string | null;
  error: string | null;
  completion_json: string | null;
  generation: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  lease_heartbeat_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface AgentTaskStateRow {
  status: string;
  generation: number;
  current_run_id: string | null;
  lease_owner: string | null;
  path: string;
  parent_session_id: string | null;
  parent_thread_id: string | null;
  child_session_id: string | null;
}

interface AgentRunProjectionRow {
  id: string;
  session_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  path: string;
  parent_path: string | null;
  parent_session_id: string | null;
  parent_thread_id: string | null;
  child_session_id: string | null;
  child_thread_id: string | null;
  task_name: string;
  cwd: string | null;
  mode: string | null;
  generation: number;
  status: AgentRunRow["status"];
  created_at: number;
  completed_at: number | null;
}

interface AgentMailboxProjectionRow {
  id: string;
  task_id: string | null;
  path: string;
  from_path: string;
  child_session_id: string | null;
  child_thread_id: string | null;
  trigger_turn: number;
  status: AgentMailboxRow["status"];
  message_json: string | null;
  created_at: number;
  consumed_at: number | null;
}

interface TeamProjectionRow {
  id: string;
  session_id: string | null;
  name: string;
  lead_path: string;
  status: TeamRow["status"];
  description: string | null;
  created_at: number;
  updated_at: number;
}

interface TeamMemberProjectionRow {
  team_id: string;
  path: string;
  name: string;
  role: string;
  status: TeamMemberRow["status"];
  child_session_id: string | null;
  child_thread_id: string | null;
  model: string | null;
  tool_scope_json: string | null;
  write_scope_json: string | null;
  current_task_id: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface TeamTaskProjectionRow {
  id: string;
  team_id: string;
  session_id: string | null;
  owner_path: string | null;
  status: TeamTaskRow["status"];
  title: string | null;
  description: string | null;
  created_by: string | null;
  depends_on_json: string | null;
  summary: string | null;
  error: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface TeamTaskStateRow {
  id: string;
  team_id: string;
  status: TeamTaskRow["status"];
  owner_path: string | null;
  depends_on_json: string | null;
  metadata_json: string | null;
}

interface TeamMessageProjectionRow {
  id: string;
  team_id: string;
  from_path: string;
  to_path: string;
  task_id: string | null;
  kind: TeamMessageRow["kind"];
  delivery: TeamMessageDelivery | null;
  delivery_status: TeamMessageDeliveryStatus | null;
  delivery_error: string | null;
  delivery_updated_at: number | null;
  delivered_at: number | null;
  content: string;
  summary: string | null;
  metadata_json: string | null;
  created_at: number;
}

interface TeamMessageDeliveryProjectionRow {
  mailbox_message_id: string;
  team_id: string;
  team_message_id: string;
  path: string;
  child_session_id: string | null;
  child_thread_id: string | null;
  trigger_turn: number;
  status: TeamMessageDeliveryStatus;
  error: string | null;
  queued_at: number;
  updated_at: number;
  delivered_at: number | null;
}

export interface SqliteEventStoreOptions {
  mirror?: EventMirror;
  onMirrorError?: (error: unknown, event: ChiliEvent) => void;
  busyTimeoutMs?: number;
  writeRetryAttempts?: number;
}

export class SqliteEventStore
  implements
    EventStore,
    GoalProjectionStore,
    SubagentProjectionStore,
    AgentTaskLeaseStore,
    AgentTaskFinalizationStore,
    AgentMailboxDeliveryStore,
    TeamProjectionStore,
    TeamTaskClaimStore,
    TeamTaskVerificationClaimStore
{
  private readonly db: Database;

  constructor(path = ".chili/chili.sqlite", private readonly options: SqliteEventStoreOptions = {}) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("pragma journal_mode = WAL");
    this.db.exec(`pragma busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 10_000))}`);
    this.db.exec("pragma foreign_keys = ON");
    const [eventTableStatement, ...remainingStatements] = SQLITE_SCHEMA;
    if (eventTableStatement) {
      this.db.exec(eventTableStatement);
    }
    this.migrateEventSequence();
    for (const statement of remainingStatements) {
      this.db.exec(statement);
    }
    this.migrateApprovalSchema();
    this.migrateMessageSchema();
    this.migrateGoalSchema();
    this.migrateSubagentSchema();
    this.migrateTeamSchema();
  }

  close(): void {
    this.db.close();
  }

  async append(event: ChiliEvent): Promise<void> {
    this.writeTransaction([event]);
    await this.writeMirror(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    if (events.length === 0) return;
    this.writeTransaction(events);
    for (const event of events) {
      await this.writeMirror(event);
    }
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.sessionId) {
      clauses.push("session_id = $sessionId");
      params.sessionId = query.sessionId;
    }
    if (query.threadId) {
      clauses.push("thread_id = $threadId");
      params.threadId = query.threadId;
    }
    if (query.type) {
      clauses.push("type = $type");
      params.type = query.type;
    }
    if (query.afterEventId) {
      clauses.push("seq > (select seq from events where id = $afterEventId)");
      params.afterEventId = query.afterEventId;
    }

    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const limit = query.limit ?? 500;
    params.limit = limit;

    const orderAndLimit = query.tail && !query.afterEventId
      ? `from (
           select seq, id, type, time, session_id, thread_id, payload_json
           from events
           ${where}
           order by seq desc
           limit $limit
         )
         order by seq asc`
      : `from events
         ${where}
         order by seq asc
         limit $limit`;

    const rows = this.db
      .query<StoredEventRow, any>(
        `select seq, id, type, time, session_id, thread_id, payload_json
         ${orderAndLimit}`,
      )
      .all(params);

    return rows.map((row) => this.eventFromRow(row));
  }

  async sessions(): Promise<SessionRow[]> {
    return this.db
      .query<{
        id: string;
        cwd: string;
        title: string | null;
        status: "active" | "archived";
        created_at: number;
        updated_at: number;
      }, []>(
        `select id, cwd, title, status, created_at, updated_at
         from sessions
         order by updated_at desc, id desc`,
      )
      .all()
      .map((row) => ({
        id: row.id as SessionRow["id"],
        cwd: row.cwd,
        ...(row.title ? { title: row.title } : {}),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  async messages(sessionId: Message["sessionId"]): Promise<Message[]> {
    const messages = this.db
      .query<MessageRow, [string]>(
        `select id, session_id, thread_id, turn_id, role, parent_id, created_at
         from messages
         where session_id = ?
         order by created_at asc, id asc`,
      )
      .all(sessionId);

    return messages.map((message) => {
      const parts = this.db
        .query<PartRow, [string]>(
          `select data_json
           from message_parts
           where message_id = ?
           order by ordinal asc`,
        )
        .all(message.id)
        .map((row) => decodeJson<MessagePart>(row.data_json, {} as MessagePart));

      const result: Message = {
        id: message.id as Message["id"],
        sessionId: message.session_id as Message["sessionId"],
        role: message.role,
        parts,
        createdAt: message.created_at as Message["createdAt"],
      };
      if (message.parent_id) {
        result.parentId = message.parent_id as MessageId;
      }
      if (message.turn_id) {
        result.turnId = message.turn_id as TurnId;
      }
      return result;
    });
  }

  async pendingApprovals(sessionId?: ApprovalRow["sessionId"]): Promise<ApprovalRow[]> {
    const sql = sessionId
      ? `select * from approvals where status = 'pending' and session_id = ? order by created_at asc`
      : `select * from approvals where status = 'pending' order by created_at asc`;
    const rows = sessionId
      ? this.db.query<Record<string, unknown>, [string]>(sql).all(sessionId)
      : this.db.query<Record<string, unknown>, []>(sql).all();

    return rows.map((row) => approvalFromRow(row));
  }

  async threadGoal(threadId: ThreadId): Promise<ThreadGoalRow | undefined> {
    return (await this.threadGoals({ threadId, limit: 1 }))[0];
  }

  async threadGoals(query: ThreadGoalQuery = {}): Promise<ThreadGoalRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.threadId) {
      clauses.push("thread_id = $threadId");
      params.threadId = query.threadId;
    }
    if (query.sessionId) {
      clauses.push("session_id = $sessionId");
      params.sessionId = query.sessionId;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<ThreadGoalProjectionRow, any>(
        `select thread_id, session_id, objective, status, token_budget, tokens_used,
                time_used_seconds, created_at, updated_at, completed_at, last_reason
         from thread_goals
         ${where}
         order by updated_at desc, thread_id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => threadGoalFromRow(row));
  }

  async agentTask(taskId: TaskId): Promise<AgentTaskRow | undefined> {
    return (await this.agentTasks({ taskId, limit: 1 }))[0];
  }

  async agentTasks(query: AgentTaskQuery = {}): Promise<AgentTaskRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.taskId) {
      clauses.push("id = $taskId");
      params.taskId = query.taskId;
    }
    if (query.path) {
      clauses.push("path = $path");
      params.path = query.path;
    }
    if (query.parentSessionId) {
      clauses.push("parent_session_id = $parentSessionId");
      params.parentSessionId = query.parentSessionId;
    }
    if (query.childSessionId) {
      clauses.push("child_session_id = $childSessionId");
      params.childSessionId = query.childSessionId;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<AgentTaskProjectionRow, any>(
        `select id, path, parent_path, parent_session_id, parent_thread_id, child_session_id, child_thread_id,
                task_name, cwd, prompt, mode, status, current_run_id, summary, error, completion_json,
                generation, lease_owner, lease_expires_at, lease_heartbeat_at, created_at, updated_at, completed_at
         from agent_tasks
         ${where}
         order by created_at asc, id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => agentTaskFromRow(row));
  }

  async agentRuns(query: AgentRunQuery = {}): Promise<AgentRunRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.taskId) {
      clauses.push("task_id = $taskId");
      params.taskId = query.taskId;
    }
    if (query.path) {
      clauses.push("path = $path");
      params.path = query.path;
    }
    if (query.sessionId) {
      clauses.push("session_id = $sessionId");
      params.sessionId = query.sessionId;
    }
    if (query.childSessionId) {
      clauses.push("child_session_id = $childSessionId");
      params.childSessionId = query.childSessionId;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<AgentRunProjectionRow, any>(
        `select id, session_id, thread_id, task_id, path, parent_path, parent_session_id, parent_thread_id,
                child_session_id, child_thread_id, task_name, cwd, mode, status, generation, created_at, completed_at
         from agent_runs
         ${where}
         order by created_at asc, id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => agentRunFromRow(row));
  }

  async agentMailbox(query: AgentMailboxQuery = {}): Promise<AgentMailboxRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.messageId) {
      clauses.push("id = $messageId");
      params.messageId = query.messageId;
    }
    if (query.taskId) {
      clauses.push("task_id = $taskId");
      params.taskId = query.taskId;
    }
    if (query.path) {
      clauses.push("path = $path");
      params.path = query.path;
    }
    if (query.childSessionId) {
      clauses.push("child_session_id = $childSessionId");
      params.childSessionId = query.childSessionId;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<AgentMailboxProjectionRow, any>(
        `select id, task_id, path, from_path, child_session_id, child_thread_id, trigger_turn, status,
                message_json, created_at, consumed_at
         from agent_mailbox
         ${where}
         order by created_at asc, id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => agentMailboxFromRow(row));
  }

  async teams(query: TeamQuery = {}): Promise<TeamRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.teamId) {
      clauses.push("id = $teamId");
      params.teamId = query.teamId;
    }
    if (query.sessionId) {
      clauses.push("session_id = $sessionId");
      params.sessionId = query.sessionId;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<TeamProjectionRow, any>(
        `select id, session_id, name, lead_path, status, description, created_at, updated_at
         from teams
         ${where}
         order by updated_at desc, id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => teamFromRow(row));
  }

  async teamMembers(query: TeamMemberQuery = {}): Promise<TeamMemberRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.teamId) {
      clauses.push("team_id = $teamId");
      params.teamId = query.teamId;
    }
    if (query.path) {
      clauses.push("path = $path");
      params.path = query.path;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<TeamMemberProjectionRow, any>(
        `select team_id, path, name, role, status, child_session_id, child_thread_id, model,
                tool_scope_json, write_scope_json, current_task_id, created_at, updated_at, closed_at
         from team_members
         ${where}
         order by created_at asc, path asc
         limit $limit`,
      )
      .all(params)
      .map((row) => teamMemberFromRow(row));
  }

  async teamTasks(query: TeamTaskQuery = {}): Promise<TeamTaskRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.teamId) {
      clauses.push("team_id = $teamId");
      params.teamId = query.teamId;
    }
    if (query.taskId) {
      clauses.push("id = $taskId");
      params.taskId = query.taskId;
    }
    if (query.ownerPath) {
      clauses.push("owner_path = $ownerPath");
      params.ownerPath = query.ownerPath;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<TeamTaskProjectionRow, any>(
        `select id, team_id, session_id, owner_path, status, title, description, created_by,
                depends_on_json, summary, error, metadata_json, created_at, updated_at, completed_at
         from team_tasks
         ${where}
         order by created_at asc, id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => teamTaskFromRow(row));
  }

  async teamMessages(query: TeamMessageQuery = {}): Promise<TeamMessageRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.teamId) {
      clauses.push("m.team_id = $teamId");
      params.teamId = query.teamId;
    }
    if (query.path) {
      clauses.push("(m.from_path = $path or m.to_path = $path or m.to_path = '*')");
      params.path = query.path;
    }
    if (query.taskId) {
      clauses.push("m.task_id = $taskId");
      params.taskId = query.taskId;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<TeamMessageProjectionRow, any>(
        `select m.id, m.team_id, m.from_path, m.to_path, m.task_id, m.kind, m.delivery, m.content,
                m.summary, m.metadata_json, m.created_at,
                (
                  select case
                    when count(*) = 0 then null
                    when sum(case when d.status = 'failed' then 1 else 0 end) > 0 then 'failed'
                    when sum(case when d.status = 'delivering' then 1 else 0 end) > 0 then 'delivering'
                    when sum(case when d.status = 'queued' then 1 else 0 end) > 0 then 'queued'
                    else 'delivered'
                  end
                  from team_message_deliveries d
                  where d.team_message_id = m.id
                ) as delivery_status,
                (
                  select d.error
                  from team_message_deliveries d
                  where d.team_message_id = m.id and d.error is not null
                  order by d.updated_at desc, d.mailbox_message_id asc
                  limit 1
                ) as delivery_error,
                (
                  select max(d.updated_at)
                  from team_message_deliveries d
                  where d.team_message_id = m.id
                ) as delivery_updated_at,
                (
                  select max(d.delivered_at)
                  from team_message_deliveries d
                  where d.team_message_id = m.id
                ) as delivered_at
         from team_messages m
         ${where}
         order by m.created_at asc, m.id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => teamMessageFromRow(row));
  }

  async teamMessageDeliveries(query: TeamMessageDeliveryQuery = {}): Promise<TeamMessageDeliveryRow[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.teamId) {
      clauses.push("team_id = $teamId");
      params.teamId = query.teamId;
    }
    if (query.teamMessageId) {
      clauses.push("team_message_id = $teamMessageId");
      params.teamMessageId = query.teamMessageId;
    }
    if (query.mailboxMessageId) {
      clauses.push("mailbox_message_id = $mailboxMessageId");
      params.mailboxMessageId = query.mailboxMessageId;
    }
    if (query.path) {
      clauses.push("path = $path");
      params.path = query.path;
    }
    if (query.status) {
      clauses.push("status = $status");
      params.status = query.status;
    }

    params.limit = query.limit ?? 500;
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.db
      .query<TeamMessageDeliveryProjectionRow, any>(
        `select mailbox_message_id, team_id, team_message_id, path, child_session_id, child_thread_id,
                trigger_turn, status, error, queued_at, updated_at, delivered_at
         from team_message_deliveries
         ${where}
         order by updated_at asc, mailbox_message_id asc
         limit $limit`,
      )
      .all(params)
      .map((row) => teamMessageDeliveryFromRow(row));
  }

  async claimTeamTask(input: TeamTaskClaimInput): Promise<TeamTaskMutationResult> {
    const run = this.db.transaction((item: TeamTaskClaimInput) => {
      const current = this.teamTaskState(item.teamId, item.taskId);
      if (!current) return { applied: false, reason: "not_found" as const, events: [] as ChiliEvent[] };
      if (isFinalTeamTaskStatus(current.status)) {
        return { applied: false, reason: "already_resolved" as const, events: [] as ChiliEvent[] };
      }
      if (current.status === "blocked" || !this.teamTaskDependenciesComplete(current)) {
        return { applied: false, reason: "blocked" as const, events: [] as ChiliEvent[] };
      }
      if (current.status !== "pending" || (current.owner_path && current.owner_path !== item.ownerPath)) {
        return { applied: false, reason: "already_claimed" as const, events: [] as ChiliEvent[] };
      }
      if (this.teamMemberUnavailableForClaim(item.teamId, item.ownerPath, item.taskId)) {
        return { applied: false, reason: "member_unavailable" as const, events: [] as ChiliEvent[] };
      }
      if (this.teamTaskHasRunningWriteConflict(current)) {
        return { applied: false, reason: "write_conflict" as const, events: [] as ChiliEvent[] };
      }

      const event = this.teamTaskClaimedEvent(item, current);
      const cas = this.db
        .query(
          `update team_tasks
           set owner_path = $ownerPath,
               status = 'in_progress',
               updated_at = $time,
               completed_at = null
           where id = $taskId
             and team_id = $teamId
             and status = 'pending'
             and (owner_path is null or owner_path = $ownerPath)`,
        )
        .run({
          teamId: item.teamId,
          taskId: item.taskId,
          ownerPath: item.ownerPath,
          time: event.time,
        });
      if (cas.changes === 0) return { applied: false, reason: "already_claimed" as const, events: [] as ChiliEvent[] };
      this.writeTransactionEvents([event]);
      return { applied: true, events: [event] };
    });
    const result = this.runWithWriteRetry(() => run(input));

    await this.writeMirrors(result.events);
    const task = (await this.teamTasks({ teamId: input.teamId, taskId: input.taskId, limit: 1 }))[0];
    return { ...result, ...(task ? { task } : {}) };
  }

  async claimTeamTaskVerification(input: TeamTaskVerificationClaimInput): Promise<TeamTaskVerificationClaimResult> {
    const run = this.db.transaction((item: TeamTaskVerificationClaimInput) => {
      const current = this.teamTaskState(item.teamId, item.taskId);
      if (!current) return { applied: false, reason: "not_found" as const, events: [] as ChiliEvent[] };
      const currentVerification = verificationStatus(current.metadata_json);
      if (current.status !== "completed") return { applied: false, reason: "not_completed" as const, events: [] as ChiliEvent[] };
      if (currentVerification === "passed") return { applied: false, reason: "already_verified" as const, events: [] as ChiliEvent[] };
      if (currentVerification === "pending" && !isStalePendingVerification(current.metadata_json, item.stalePendingBefore)) {
        return { applied: false, reason: "verification_pending" as const, events: [] as ChiliEvent[] };
      }

      const metadata = verificationClaimMetadata(current.metadata_json, item.metadata);
      const event = this.teamTaskVerificationClaimedEvent(item, current, metadata);
      const cas = this.db
        .query(
          `update team_tasks
           set metadata_json = $metadata,
               updated_at = $time
           where id = $taskId
             and team_id = $teamId
             and status = 'completed'
             and (($currentMetadata is null and metadata_json is null) or metadata_json = $currentMetadata)`,
        )
        .run({
          teamId: item.teamId,
          taskId: item.taskId,
          metadata: encodeJson(metadata),
          currentMetadata: current.metadata_json,
          time: event.time,
        });
      if (cas.changes === 0) {
        const latest = this.teamTaskState(item.teamId, item.taskId);
        if (!latest) return { applied: false, reason: "not_found" as const, events: [] as ChiliEvent[] };
        const latestVerification = verificationStatus(latest.metadata_json);
        if (latest.status !== "completed") return { applied: false, reason: "not_completed" as const, events: [] as ChiliEvent[] };
        if (latestVerification === "passed") return { applied: false, reason: "already_verified" as const, events: [] as ChiliEvent[] };
        if (latestVerification === "pending" && !isStalePendingVerification(latest.metadata_json, item.stalePendingBefore)) {
          return { applied: false, reason: "verification_pending" as const, events: [] as ChiliEvent[] };
        }
        return { applied: false, reason: "stale" as const, events: [] as ChiliEvent[] };
      }

      this.writeTransactionEvents([event]);
      return { applied: true, events: [event] };
    });
    const result = this.runWithWriteRetry(() => run(input));

    await this.writeMirrors(result.events);
    const task = (await this.teamTasks({ teamId: input.teamId, taskId: input.taskId, limit: 1 }))[0];
    return { ...result, ...(task ? { task } : {}) };
  }

  async claimAgentMailboxMessage(input: AgentMailboxClaimInput): Promise<AgentMailboxMutationResult> {
    const run = this.db.transaction((item: AgentMailboxClaimInput) => {
      const current = this.agentMailboxState(item.messageId);
      if (!current || current.status !== "queued") return { applied: false, events: [] as ChiliEvent[] };

      const event = this.agentMailboxClaimedEvent(item, current);
      const cas = this.db
        .query(`update agent_mailbox set status = 'delivering' where id = $messageId and status = 'queued'`)
        .run({ messageId: item.messageId });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };
      this.writeTransactionEvents([event]);
      return { applied: true, events: [event] };
    });
    const result = this.runWithWriteRetry(() => run(input));

    await this.writeMirrors(result.events);
    const message = await this.agentMailboxMessage(input.messageId);
    return { ...result, ...(message ? { message } : {}) };
  }

  async consumeAgentMailboxMessage(input: AgentMailboxConsumeInput): Promise<AgentMailboxMutationResult> {
    const run = this.db.transaction((item: AgentMailboxConsumeInput) => {
      const current = this.agentMailboxState(item.messageId);
      if (!current || current.status === "consumed") return { applied: false, events: [] as ChiliEvent[] };
      if (current.status !== "delivering") return { applied: false, events: [] as ChiliEvent[] };

      const event = this.agentMailboxConsumedEvent(item, current);
      const cas = this.db
        .query(
          `update agent_mailbox
           set status = 'consumed',
               consumed_at = $time
           where id = $messageId
             and status = 'delivering'`,
        )
        .run({ messageId: item.messageId, time: event.time });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };
      this.writeTransactionEvents([event]);
      return { applied: true, events: [event] };
    });
    const result = this.runWithWriteRetry(() => run(input));

    await this.writeMirrors(result.events);
    const message = await this.agentMailboxMessage(input.messageId);
    return { ...result, ...(message ? { message } : {}) };
  }

  async requeueAgentMailboxMessage(input: AgentMailboxRequeueInput): Promise<AgentMailboxMutationResult> {
    const run = this.db.transaction((item: AgentMailboxRequeueInput) => {
      const current = this.agentMailboxState(item.messageId);
      if (!current || current.status !== "delivering") return { applied: false, events: [] as ChiliEvent[] };

      const event = this.agentMailboxRequeuedEvent(item, current);
      const cas = this.db
        .query(
          `update agent_mailbox
           set status = 'queued',
               consumed_at = null
           where id = $messageId
             and status = 'delivering'`,
        )
        .run({ messageId: item.messageId });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };
      this.writeTransactionEvents([event]);
      return { applied: true, events: [event] };
    });
    const result = this.runWithWriteRetry(() => run(input));

    await this.writeMirrors(result.events);
    const message = await this.agentMailboxMessage(input.messageId);
    return { ...result, ...(message ? { message } : {}) };
  }

  async claimAgentTaskLease(input: AgentTaskLeaseClaimInput): Promise<AgentTaskLeaseResult> {
    const now = input.now ?? Date.now();
    const expiresAt = now + input.ttlMs;
    const result = this.db
      .query(
        `update agent_tasks
         set lease_owner = $owner,
             lease_expires_at = $expiresAt,
             lease_heartbeat_at = $now,
             generation = generation + 1,
             updated_at = $now
         where id = $taskId
           and status = 'running'
           and ($runId is null or current_run_id is null or current_run_id = $runId)
           and ($generation is null or generation = $generation)
           and (
             lease_owner is null
             or lease_expires_at is null
             or lease_expires_at <= $now
             or lease_owner = $owner
           )`,
      )
      .run({
        taskId: input.taskId,
        owner: input.owner,
        runId: input.runId ?? null,
        generation: input.generation ?? null,
        now,
        expiresAt,
      });
    const task = await this.agentTask(input.taskId);
    return result.changes > 0 && task ? { acquired: true, task } : { acquired: false, ...(task ? { task } : {}) };
  }

  async renewAgentTaskLease(input: AgentTaskLeaseRenewInput): Promise<AgentTaskLeaseResult> {
    const now = input.now ?? Date.now();
    const expiresAt = now + input.ttlMs;
    const result = this.db
      .query(
        `update agent_tasks
         set lease_expires_at = $expiresAt,
             lease_heartbeat_at = $now,
             updated_at = $now
         where id = $taskId
           and status = 'running'
           and lease_owner = $owner
           and generation = $generation`,
      )
      .run({
        taskId: input.taskId,
        owner: input.owner,
        generation: input.generation,
        now,
        expiresAt,
      });
    const task = await this.agentTask(input.taskId);
    return result.changes > 0 && task ? { acquired: true, task } : { acquired: false, ...(task ? { task } : {}) };
  }

  async releaseAgentTaskLease(input: AgentTaskLeaseReleaseInput): Promise<boolean> {
    const now = input.now ?? Date.now();
    const result = this.db
      .query(
        `update agent_tasks
         set lease_owner = null,
             lease_expires_at = null,
             lease_heartbeat_at = null,
             updated_at = $now
         where id = $taskId
           and lease_owner = $owner
           and generation = $generation`,
      )
      .run({
        taskId: input.taskId,
        owner: input.owner,
        generation: input.generation,
        now,
      });
    return result.changes > 0;
  }

  async completeAgentTaskCas(input: AgentTaskCompleteCasInput): Promise<AgentTaskFinalizationResult> {
    const run = this.db.transaction((item: AgentTaskCompleteCasInput) => {
      const current = this.agentTaskState(item.taskId);
      if (!current || isFinalTaskStatus(current.status)) return { applied: false, events: [] as ChiliEvent[] };

      const generation = normalizedGeneration(item.generation) ?? current.generation;
      const now = item.time ?? Date.now();
      const cas = this.db
        .query(
          `update agent_tasks
           set updated_at = updated_at
           where id = $taskId
             and status = 'running'
             and ($runId is null or current_run_id is null or current_run_id = $runId)
             and generation = $generation
             and ($owner is null or (lease_owner = $owner and lease_expires_at > $now))`,
        )
        .run({
          taskId: item.taskId,
          runId: item.runId ?? null,
          generation,
          owner: item.owner ?? null,
          now,
        });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };

      const event = this.taskCompletedEvent(item, current, generation);
      const events: ChiliEvent[] = [event];
      if (item.runId && item.agentEventId) events.push(this.agentCompletedEvent(item, current, generation));
      this.writeTransactionEvents(events);
      return { applied: true, events };
    });
    const result = this.runWithWriteRetry(() => run(input));

    await this.writeMirrors(result.events);
    const task = await this.agentTask(input.taskId);
    return { ...result, ...(task ? { task } : {}) };
  }

  async closeAgentTaskCas(input: AgentTaskCloseCasInput): Promise<AgentTaskFinalizationResult> {
    const run = this.db.transaction((item: AgentTaskCloseCasInput) => {
      const current = this.agentTaskState(item.taskId);
      if (!current) return { applied: false, events: [] as ChiliEvent[] };
      if (isFinalTaskStatus(current.status)) return { applied: false, events: [] as ChiliEvent[] };

      const cas = this.db
        .query(
          `update agent_tasks
           set updated_at = updated_at
           where id = $taskId
             and status not in ('completed', 'failed', 'cancelled')`,
        )
        .run({ taskId: item.taskId });
      if (cas.changes === 0) return { applied: false, events: [] as ChiliEvent[] };

      const generation = current.generation + 1;
      const completionInput: AgentTaskCompleteCasInput = {
        taskId: item.taskId,
        path: current.path as AgentPath,
        status: item.status,
        eventId: item.eventId,
        generation,
      };
      if (current.current_run_id) completionInput.runId = current.current_run_id as NonNullable<AgentTaskCompleteCasInput["runId"]>;
      if (item.summary) completionInput.summary = item.summary;
      if (item.error) completionInput.error = item.error;
      if (item.agentEventId) completionInput.agentEventId = item.agentEventId;
      if (item.sessionId) completionInput.sessionId = item.sessionId;
      if (item.threadId) completionInput.threadId = item.threadId;
      if (item.time !== undefined) completionInput.time = item.time;

      const event = this.taskCompletedEvent(completionInput, current, generation);
      const events: ChiliEvent[] = [event];
      if (current.current_run_id && item.agentEventId) {
        events.push(this.agentCompletedEvent(completionInput, current, generation));
      }
      this.writeTransactionEvents(events);
      return { applied: true, events };
    });
    const result = this.runWithWriteRetry(() => run(input));

    await this.writeMirrors(result.events);
    const task = await this.agentTask(input.taskId);
    return { ...result, ...(task ? { task } : {}) };
  }

  private writeTransaction(events: readonly ChiliEvent[]): void {
    const run = this.db.transaction((items: readonly ChiliEvent[]) => {
      this.writeTransactionEvents(items);
    });
    this.runWithWriteRetry(() => run(events));
  }

  private writeTransactionEvents(events: readonly ChiliEvent[]): void {
    for (const event of events) {
      this.insertEvent(event);
      this.applyProjection(event);
    }
  }

  async reconcileStaleTurns(input: {
    staleBefore: number;
    createId: (prefix: string) => string;
    now?: number;
    status?: "failed" | "cancelled";
    reason?: string;
  }): Promise<ChiliEvent[]> {
    const status = input.status ?? "failed";
    const reason = input.reason ?? "stale_turn_recovered";
    const now = (input.now ?? Date.now()) as TimestampMs;
    const rows = this.db
      .query<{
        session_id: string;
        thread_id: string | null;
        turn_id: string;
        time: number;
      }, [number]>(
        `select started.session_id, started.thread_id,
                json_extract(started.payload_json, '$.turnId') as turn_id,
                started.time
           from events started
          where started.type = 'turn.started'
            and started.session_id is not null
            and started.time < ?
            and not exists (
              select 1
                from events completed
               where completed.type = 'turn.completed'
                 and json_extract(completed.payload_json, '$.turnId') = json_extract(started.payload_json, '$.turnId')
            )
          order by started.seq asc`,
      )
      .all(input.staleBefore);

    const events: ChiliEvent[] = [];
    for (const row of rows) {
      const sessionId = row.session_id as SessionId;
      const turnId = row.turn_id as TurnId;
      const threadId = row.thread_id ? (row.thread_id as ThreadId) : undefined;
      const base = {
        time: now,
        sessionId,
        ...(threadId ? { threadId } : {}),
      };
      events.push({
        ...base,
        id: input.createId("event"),
        type: "turn.completed",
        payload: { turnId, status },
      });
      events.push({
        ...base,
        id: input.createId("event"),
        type: "session.status_changed",
        payload: {
          sessionId,
          status,
          turnId,
          reason,
        },
      });
    }

    if (events.length === 0) return [];
    this.writeTransaction(events);
    await this.writeMirrors(events);
    return events;
  }

  private runWithWriteRetry<T>(action: () => T): T {
    const attempts = Math.max(1, Math.trunc(this.options.writeRetryAttempts ?? 6));
    let delayMs = 25;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return action();
      } catch (error) {
        if (attempt >= attempts || !isSqliteBusyError(error)) throw error;
        sleepSync(delayMs);
        delayMs = Math.min(delayMs * 2, 500);
      }
    }
    throw new Error("SQLite write retry exhausted");
  }

  private async writeMirror(event: ChiliEvent): Promise<void> {
    if (!this.options.mirror) return;
    try {
      await this.options.mirror.write(event);
    } catch (error) {
      this.options.onMirrorError?.(error, event);
    }
  }

  private async writeMirrors(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) {
      await this.writeMirror(event);
    }
  }

  private taskCompletedEvent(
    input: AgentTaskCompleteCasInput,
    current: AgentTaskStateRow,
    generation: number,
  ): Extract<ChiliEvent, { type: "agent.task_completed" }> {
    const payload: AgentCompleteTaskPayload = {
      taskId: input.taskId,
      path: input.path,
      status: input.status,
      generation,
    };
    if (input.runId) payload.runId = input.runId;
    if (input.summary) payload.summary = input.summary;
    if (input.error) payload.error = input.error;

    const event: EventEnvelope<"agent.task_completed", AgentCompleteTaskPayload> = {
      id: input.eventId,
      type: "agent.task_completed",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId ?? current.parent_session_id ?? current.child_session_id;
    if (sessionId) event.sessionId = sessionId as SessionId;
    const threadId = input.threadId ?? current.parent_thread_id;
    if (threadId) event.threadId = threadId as ThreadId;
    return event;
  }

  private agentCompletedEvent(
    input: AgentTaskCompleteCasInput,
    current: AgentTaskStateRow,
    generation: number,
  ): Extract<ChiliEvent, { type: "agent.completed" }> {
    if (!input.runId || !input.agentEventId) {
      throw new Error("agent.completed CAS event requires runId and agentEventId");
    }
    const payload: AgentCompletedPayload = {
      runId: input.runId,
      taskId: input.taskId,
      path: input.path,
      status: input.status,
      generation,
    };
    if (input.summary) payload.summary = input.summary;
    if (input.error) payload.error = input.error;

    const event: EventEnvelope<"agent.completed", AgentCompletedPayload> = {
      id: input.agentEventId,
      type: "agent.completed",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId ?? current.parent_session_id ?? current.child_session_id;
    if (sessionId) event.sessionId = sessionId as SessionId;
    const threadId = input.threadId ?? current.parent_thread_id;
    if (threadId) event.threadId = threadId as ThreadId;
    return event;
  }

  private agentMailboxClaimedEvent(
    input: AgentMailboxClaimInput,
    current: AgentMailboxProjectionRow,
  ): Extract<ChiliEvent, { type: "agent.message_claimed" }> {
    const payload: AgentMessageClaimedPayload = {
      messageId: input.messageId,
      path: current.path as AgentPath,
    };
    if (current.task_id) payload.taskId = current.task_id as TaskId;
    if (input.claimedBy) payload.claimedBy = input.claimedBy;

    const event: EventEnvelope<"agent.message_claimed", AgentMessageClaimedPayload> = {
      id: input.eventId,
      type: "agent.message_claimed",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId ?? this.parentSessionIdForTask(current.task_id) ?? current.child_session_id;
    if (sessionId) event.sessionId = sessionId as SessionId;
    const threadId = input.threadId ?? this.parentThreadIdForTask(current.task_id) ?? current.child_thread_id;
    if (threadId) event.threadId = threadId as ThreadId;
    return event;
  }

  private agentMailboxConsumedEvent(
    input: AgentMailboxConsumeInput,
    current: AgentMailboxProjectionRow,
  ): Extract<ChiliEvent, { type: "agent.message_consumed" }> {
    const payload: AgentMessageConsumedPayload = {
      messageId: input.messageId,
      path: current.path as AgentPath,
      consumedBy: input.consumedBy ?? (current.path as AgentPath),
    };
    if (current.task_id) payload.taskId = current.task_id as TaskId;

    const event: EventEnvelope<"agent.message_consumed", AgentMessageConsumedPayload> = {
      id: input.eventId,
      type: "agent.message_consumed",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId ?? this.parentSessionIdForTask(current.task_id) ?? current.child_session_id;
    if (sessionId) event.sessionId = sessionId as SessionId;
    const threadId = input.threadId ?? this.parentThreadIdForTask(current.task_id) ?? current.child_thread_id;
    if (threadId) event.threadId = threadId as ThreadId;
    return event;
  }

  private agentMailboxRequeuedEvent(
    input: AgentMailboxRequeueInput,
    current: AgentMailboxProjectionRow,
  ): Extract<ChiliEvent, { type: "agent.message_requeued" }> {
    const payload: AgentMessageRequeuedPayload = {
      messageId: input.messageId,
      path: current.path as AgentPath,
    };
    if (current.task_id) payload.taskId = current.task_id as TaskId;
    if (input.error) payload.error = input.error;

    const event: EventEnvelope<"agent.message_requeued", AgentMessageRequeuedPayload> = {
      id: input.eventId,
      type: "agent.message_requeued",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId ?? this.parentSessionIdForTask(current.task_id) ?? current.child_session_id;
    if (sessionId) event.sessionId = sessionId as SessionId;
    const threadId = input.threadId ?? this.parentThreadIdForTask(current.task_id) ?? current.child_thread_id;
    if (threadId) event.threadId = threadId as ThreadId;
    return event;
  }

  private insertEvent(event: ChiliEvent): void {
    this.db
      .query(
        `insert into events (seq, id, type, time, session_id, thread_id, payload_json)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.nextEventSeq(),
        event.id,
        event.type,
        event.time,
        event.sessionId ?? null,
        event.threadId ?? null,
        encodeJson(event.payload),
      );
  }

  private migrateEventSequence(): void {
    const columns = this.db.query<{ name: string }, []>(`pragma table_info(events)`).all();
    if (!columns.some((column) => column.name === "seq")) {
      this.db.exec(`alter table events add column seq integer`);
    }
    this.db.exec(`update events set seq = rowid where seq is null`);
    this.db.exec(`create unique index if not exists events_seq_idx on events(seq)`);
    this.db.exec(`create unique index if not exists events_id_idx on events(id)`);
    this.db.exec(`create index if not exists events_session_seq_idx on events(session_id, seq)`);
    this.db.exec(`create index if not exists events_thread_seq_idx on events(thread_id, seq)`);
    this.db.exec(`create index if not exists events_type_seq_idx on events(type, seq)`);
  }

  private migrateSubagentSchema(): void {
    this.addColumnIfMissing("agent_runs", "task_id", "text");
    this.addColumnIfMissing("agent_runs", "parent_session_id", "text");
    this.addColumnIfMissing("agent_runs", "parent_thread_id", "text");
    this.addColumnIfMissing("agent_runs", "child_session_id", "text");
    this.addColumnIfMissing("agent_runs", "child_thread_id", "text");
    this.addColumnIfMissing("agent_runs", "cwd", "text");
    this.addColumnIfMissing("agent_runs", "mode", "text");
    this.addColumnIfMissing("agent_runs", "generation", "integer not null default 0");
    this.addColumnIfMissing("agent_tasks", "generation", "integer not null default 0");
    this.addColumnIfMissing("agent_tasks", "lease_owner", "text");
    this.addColumnIfMissing("agent_tasks", "lease_expires_at", "integer");
    this.addColumnIfMissing("agent_tasks", "lease_heartbeat_at", "integer");
    this.addColumnIfMissing("agent_mailbox", "consumed_at", "integer");
    this.db.exec(`create index if not exists agent_runs_task_idx on agent_runs(task_id)`);
    this.db.exec(`create index if not exists agent_runs_child_session_idx on agent_runs(child_session_id)`);
    this.db.exec(`create index if not exists agent_mailbox_status_idx on agent_mailbox(status, created_at)`);
    this.db.exec(`create index if not exists agent_tasks_lease_idx on agent_tasks(status, lease_expires_at)`);
    this.db.exec(`create index if not exists agent_tasks_lease_owner_idx on agent_tasks(lease_owner, status)`);
  }

  private migrateApprovalSchema(): void {
    this.addColumnIfMissing("approvals", "metadata_json", "text");
  }

  private migrateMessageSchema(): void {
    this.addColumnIfMissing("messages", "turn_id", "text");
    this.db.exec(`create index if not exists messages_turn_idx on messages(turn_id)`);
  }

  private migrateGoalSchema(): void {
    this.db.exec(`
      create table if not exists thread_goals (
        thread_id text primary key,
        session_id text,
        objective text not null,
        status text not null,
        token_budget integer,
        tokens_used integer not null default 0,
        time_used_seconds real not null default 0,
        created_at integer not null,
        updated_at integer not null,
        completed_at integer,
        last_reason text
      )
    `);
    this.addColumnIfMissing("thread_goals", "session_id", "text");
    this.addColumnIfMissing("thread_goals", "token_budget", "integer");
    this.addColumnIfMissing("thread_goals", "tokens_used", "integer not null default 0");
    this.addColumnIfMissing("thread_goals", "time_used_seconds", "real not null default 0");
    this.addColumnIfMissing("thread_goals", "completed_at", "integer");
    this.addColumnIfMissing("thread_goals", "last_reason", "text");
    this.db.exec(`create index if not exists thread_goals_session_idx on thread_goals(session_id)`);
    this.db.exec(`create index if not exists thread_goals_status_idx on thread_goals(status, updated_at)`);
  }

  private migrateTeamSchema(): void {
    this.addColumnIfMissing("teams", "description", "text");
    this.addColumnIfMissing("team_tasks", "description", "text");
    this.addColumnIfMissing("team_tasks", "created_by", "text");
    this.addColumnIfMissing("team_tasks", "depends_on_json", "text");
    this.addColumnIfMissing("team_tasks", "summary", "text");
    this.addColumnIfMissing("team_tasks", "error", "text");
    this.addColumnIfMissing("team_tasks", "metadata_json", "text");
    this.addColumnIfMissing("team_tasks", "completed_at", "integer");
    this.addColumnIfMissing("team_messages", "delivery", "text");
    this.db.exec(`
      create table if not exists team_message_deliveries (
        mailbox_message_id text primary key,
        team_id text not null,
        team_message_id text not null,
        path text not null,
        child_session_id text,
        child_thread_id text,
        trigger_turn integer not null,
        status text not null,
        error text,
        queued_at integer not null,
        updated_at integer not null,
        delivered_at integer
      )
    `);
    this.db.exec(`create index if not exists team_tasks_owner_status_idx on team_tasks(owner_path, status)`);
    this.db.exec(`create index if not exists team_members_team_status_idx on team_members(team_id, status)`);
    this.db.exec(`create index if not exists team_members_path_idx on team_members(path)`);
    this.db.exec(`create index if not exists team_messages_team_time_idx on team_messages(team_id, created_at)`);
    this.db.exec(`create index if not exists team_messages_to_time_idx on team_messages(to_path, created_at)`);
    this.db.exec(`create index if not exists team_messages_task_idx on team_messages(task_id, created_at)`);
    this.db.exec(`create index if not exists team_message_deliveries_team_idx on team_message_deliveries(team_id, updated_at)`);
    this.db.exec(`create index if not exists team_message_deliveries_message_idx on team_message_deliveries(team_message_id, updated_at)`);
    this.db.exec(`create index if not exists team_message_deliveries_status_idx on team_message_deliveries(status, updated_at)`);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.query<{ name: string }, []>(`pragma table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`alter table ${table} add column ${column} ${definition}`);
    }
  }

  private nextEventSeq(): number {
    const row = this.db.query<{ seq: number | null }, []>(`select max(seq) as seq from events`).get();
    return (row?.seq ?? 0) + 1;
  }

  private applyProjection(event: ChiliEvent): void {
    if (event.type.startsWith("session.")) {
      this.applySessionEvent(event as SessionEvent);
      return;
    }
    if (event.type.startsWith("message.")) {
      this.applyMessageEvent(event as MessageEvent);
      return;
    }
    if (event.type.startsWith("tool.")) {
      this.applyToolEvent(event as ToolEvent);
      return;
    }
    if (event.type.startsWith("approval.")) {
      this.applyApprovalEvent(event as ApprovalEvent);
      return;
    }
    if (event.type.startsWith("goal.")) {
      this.applyGoalEvent(event as GoalEvent);
      return;
    }
    if (event.type.startsWith("agent.")) {
      this.applyAgentEvent(event as AgentEvent);
      return;
    }
    if (event.type.startsWith("team.")) {
      this.applyTeamEvent(event as TeamEvent);
    }
  }

  private applySessionEvent(event: SessionEvent): void {
    if (event.type === "session.created") {
      const title = event.payload.cwd.split("/").filter(Boolean).at(-1) ?? "Untitled";
      this.db
        .query(
          `insert into sessions (id, cwd, title, status, created_at, updated_at)
           values (?, ?, ?, 'active', ?, ?)
           on conflict(id) do update set
             cwd = excluded.cwd,
             updated_at = excluded.updated_at`,
        )
        .run(event.payload.sessionId, event.payload.cwd, title, event.time, event.time);
      return;
    }

    if (event.type === "session.archived") {
      this.db
        .query(`update sessions set status = 'archived', updated_at = ? where id = ?`)
        .run(event.time, event.payload.sessionId);
    }
  }

  private applyMessageEvent(event: MessageEvent): void {
    if (event.type === "message.created") {
      if (!event.sessionId) {
        throw new Error("message.created requires event.sessionId");
      }
      this.db
        .query(
          `insert into messages (id, session_id, thread_id, turn_id, role, parent_id, created_at)
           values (?, ?, ?, ?, ?, null, ?)
           on conflict(id) do nothing`,
        )
        .run(event.payload.messageId, event.sessionId, event.threadId ?? null, event.payload.turnId ?? null, event.payload.role, event.time);
      return;
    }

    if (event.type === "message.part_added") {
      const part = event.payload.part;
      const ordinal = this.nextPartOrdinal(part.messageId);
      this.db
        .query(
          `insert into message_parts (id, message_id, session_id, type, ordinal, data_json, created_at)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do update set data_json = excluded.data_json`,
        )
        .run(part.id, part.messageId, part.sessionId, part.type, ordinal, encodeJson(part), event.time);
      return;
    }

    if (event.type === "message.part_delta") {
      const row = this.db
        .query<PartRow, [string]>(`select data_json from message_parts where id = ?`)
        .get(event.payload.partId);
      if (!row) return;

      const part = applyPartDelta(
        decodeJson<MessagePart>(row.data_json, {} as MessagePart),
        event.payload.field,
        event.payload.delta,
      );
      this.db
        .query(`update message_parts set data_json = ? where id = ?`)
        .run(encodeJson(part), event.payload.partId);
    }
  }

  private applyToolEvent(event: ToolEvent): void {
    if (event.type === "tool.call_started") {
      this.db
        .query(
          `insert into tool_calls
             (id, session_id, thread_id, turn_id, tool_name, status, input_json, started_at, updated_at)
           values (?, ?, ?, ?, ?, 'running', ?, ?, ?)
           on conflict(id) do update set
             status = excluded.status,
             updated_at = excluded.updated_at`,
        )
        .run(
          event.payload.callId,
          event.sessionId ?? null,
          event.threadId ?? null,
          event.payload.turnId,
          event.payload.toolName,
          encodeJson(event.payload.input),
          event.time,
          event.time,
        );
      return;
    }

    if (event.type === "tool.call_updated") {
      this.db
        .query(`update tool_calls set status = ?, updated_at = ? where id = ?`)
        .run(event.payload.status, event.time, event.payload.callId);
      return;
    }

    if (event.type === "tool.call_finished") {
      this.db
        .query(
          `update tool_calls
           set status = ?, output = ?, error = ?, synthetic = ?, updated_at = ?
           where id = ?`,
        )
        .run(
          event.payload.status,
          event.payload.output ?? null,
          event.payload.error ?? null,
          event.payload.synthetic ? 1 : 0,
          event.time,
          event.payload.callId,
        );
    }
  }

  private applyApprovalEvent(event: ApprovalEvent): void {
    if (event.type === "approval.requested") {
      this.db
        .query(
          `insert into approvals
             (id, session_id, thread_id, call_id, permission, patterns_json, metadata_json, status, created_at)
           values (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
           on conflict(id) do update set
             status = 'pending',
             metadata_json = excluded.metadata_json`,
        )
        .run(
          event.payload.approvalId,
          event.sessionId ?? null,
          event.threadId ?? null,
          event.payload.callId ?? null,
          event.payload.permission,
          encodeJson(event.payload.patterns),
          event.payload.metadata ? encodeJson(event.payload.metadata) : null,
          event.time,
        );
      return;
    }

    if (event.type === "approval.resolved") {
      this.db
        .query(
          `update approvals
           set status = 'resolved', decision = ?, feedback = ?, resolved_at = ?
           where id = ?`,
        )
        .run(event.payload.decision, event.payload.feedback ?? null, event.time, event.payload.approvalId);
    }
  }

  private applyGoalEvent(event: GoalEvent): void {
    if (event.type === "goal.updated") {
      const goal = event.payload.goal;
      this.db
        .query(
          `insert into thread_goals
             (thread_id, session_id, objective, status, token_budget, tokens_used,
              time_used_seconds, created_at, updated_at, completed_at, last_reason)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(thread_id) do update set
             session_id = excluded.session_id,
             objective = excluded.objective,
             status = excluded.status,
             token_budget = excluded.token_budget,
             tokens_used = excluded.tokens_used,
             time_used_seconds = excluded.time_used_seconds,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             completed_at = excluded.completed_at,
             last_reason = excluded.last_reason`,
        )
        .run(
          goal.threadId,
          goal.sessionId ?? event.sessionId ?? null,
          goal.objective,
          goal.status,
          goal.tokenBudget ?? null,
          goal.tokensUsed,
          goal.timeUsedSeconds,
          goal.createdAt,
          goal.updatedAt,
          goal.completedAt ?? null,
          event.payload.reason ?? goal.lastReason ?? null,
        );
      return;
    }

    this.db
      .query(`delete from thread_goals where thread_id = ?`)
      .run(event.payload.threadId);
  }

  private applyAgentEvent(event: AgentEvent): void {
    if (event.type === "agent.task_created") {
      this.db
        .query(
          `insert into agent_tasks
             (id, path, parent_path, parent_session_id, parent_thread_id, child_session_id, child_thread_id,
              task_name, cwd, prompt, mode, status, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
           on conflict(id) do update set
             path = excluded.path,
             parent_path = excluded.parent_path,
             parent_session_id = excluded.parent_session_id,
             parent_thread_id = excluded.parent_thread_id,
             child_session_id = excluded.child_session_id,
             child_thread_id = excluded.child_thread_id,
             task_name = excluded.task_name,
             cwd = excluded.cwd,
             prompt = excluded.prompt,
             mode = excluded.mode,
             updated_at = excluded.updated_at`,
        )
        .run(
          event.payload.taskId,
          event.payload.path,
          event.payload.parentPath,
          event.payload.parentSessionId,
          event.payload.parentThreadId ?? null,
          event.payload.childSessionId,
          event.payload.childThreadId,
          event.payload.taskName,
          event.payload.cwd,
          event.payload.prompt,
          event.payload.mode ?? null,
          event.time,
          event.time,
        );
      return;
    }

    if (event.type === "agent.spawned") {
      const parentSessionId = event.payload.parentSessionId ?? event.sessionId ?? null;
      const parentThreadId = event.payload.parentThreadId ?? event.threadId ?? null;
      const payloadGeneration = normalizedGeneration(event.payload.generation);
      if (event.payload.taskId) {
        const current = this.agentTaskState(event.payload.taskId);
        if (current && !shouldApplySpawnToTask(current, payloadGeneration)) return;
      }
      this.db
        .query(
          `insert into agent_runs
             (id, session_id, thread_id, task_id, path, parent_path, parent_session_id, parent_thread_id,
              child_session_id, child_thread_id, task_name, cwd, mode, status, generation, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
           on conflict(id) do update set
             status = 'running',
             session_id = coalesce(excluded.session_id, agent_runs.session_id),
             thread_id = coalesce(excluded.thread_id, agent_runs.thread_id),
             task_id = coalesce(excluded.task_id, agent_runs.task_id),
             path = excluded.path,
             parent_path = coalesce(excluded.parent_path, agent_runs.parent_path),
             parent_session_id = coalesce(excluded.parent_session_id, agent_runs.parent_session_id),
             parent_thread_id = coalesce(excluded.parent_thread_id, agent_runs.parent_thread_id),
             child_session_id = coalesce(excluded.child_session_id, agent_runs.child_session_id),
             child_thread_id = coalesce(excluded.child_thread_id, agent_runs.child_thread_id),
             task_name = excluded.task_name,
             cwd = coalesce(excluded.cwd, agent_runs.cwd),
             mode = coalesce(excluded.mode, agent_runs.mode),
             generation = max(agent_runs.generation, excluded.generation),
             completed_at = null
           where agent_runs.completed_at is null`,
        )
        .run(
          event.payload.runId,
          event.sessionId ?? null,
          event.threadId ?? null,
          event.payload.taskId ?? null,
          event.payload.path,
          event.payload.parentPath ?? null,
          parentSessionId,
          parentThreadId,
          event.payload.childSessionId ?? null,
          event.payload.childThreadId ?? null,
          event.payload.taskName,
          event.payload.cwd ?? null,
          event.payload.mode ?? null,
          payloadGeneration ?? 0,
          event.time,
        );
      if (event.payload.taskId) {
        this.applyAgentSpawnToTask(event, parentSessionId, parentThreadId, payloadGeneration);
      }
      return;
    }

    if (event.type === "agent.message_queued") {
      this.db
        .query(
          `insert into agent_mailbox
             (id, task_id, path, from_path, child_session_id, child_thread_id, trigger_turn, status, message_json, created_at)
           values (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
           on conflict(id) do update set
             task_id = excluded.task_id,
             path = excluded.path,
             from_path = excluded.from_path,
             child_session_id = excluded.child_session_id,
             child_thread_id = excluded.child_thread_id,
             trigger_turn = excluded.trigger_turn,
             message_json = excluded.message_json`,
        )
        .run(
          event.id,
          event.payload.taskId ?? null,
          event.payload.path,
          event.payload.from,
          event.payload.childSessionId ?? null,
          event.payload.childThreadId ?? null,
          event.payload.triggerTurn ? 1 : 0,
          event.payload.message ? encodeJson(event.payload.message) : null,
          event.time,
        );
      if (event.payload.taskId) {
        this.db.query(`update agent_tasks set updated_at = ? where id = ?`).run(event.time, event.payload.taskId);
      }
      this.applyTeamMessageDeliveryQueued(event);
      return;
    }

    if (event.type === "agent.message_claimed") {
      this.db
        .query(`update agent_mailbox set status = 'delivering' where id = ? and status = 'queued'`)
        .run(event.payload.messageId);
      this.applyTeamMessageDeliveryStatus(event.payload.messageId, "delivering", event.time);
      if (event.payload.taskId) {
        this.db.query(`update agent_tasks set updated_at = ? where id = ?`).run(event.time, event.payload.taskId);
      }
      return;
    }

    if (event.type === "agent.message_requeued") {
      this.db
        .query(`update agent_mailbox set status = 'queued', consumed_at = null where id = ? and status = 'delivering'`)
        .run(event.payload.messageId);
      this.applyTeamMessageDeliveryStatus(event.payload.messageId, "failed", event.time, event.payload.error);
      if (event.payload.taskId) {
        this.db.query(`update agent_tasks set updated_at = ? where id = ?`).run(event.time, event.payload.taskId);
      }
      return;
    }

    if (event.type === "agent.message_consumed") {
      this.db
        .query(`update agent_mailbox set status = 'consumed', consumed_at = ? where id = ?`)
        .run(event.time, event.payload.messageId);
      this.applyTeamMessageDeliveryStatus(event.payload.messageId, "delivered", event.time);
      if (event.payload.taskId) {
        this.db.query(`update agent_tasks set updated_at = ? where id = ?`).run(event.time, event.payload.taskId);
      }
      return;
    }

    if (event.type === "agent.task_completed") {
      this.applyAgentTaskCompletion(event.payload, event.time);
      return;
    }

    if (event.type === "agent.completed") {
      this.db
        .query(
          `update agent_runs
           set status = ?, completed_at = ?, task_id = coalesce(?, task_id),
               generation = max(generation, ?)
           where id = ? and completed_at is null`,
        )
        .run(
          event.payload.status,
          event.time,
          event.payload.taskId ?? null,
          normalizedGeneration(event.payload.generation) ?? 0,
          event.payload.runId,
        );
      if (event.payload.taskId) {
        this.applyAgentTaskCompletion(
          {
            taskId: event.payload.taskId,
            path: event.payload.path,
            runId: event.payload.runId,
            ...(event.payload.generation !== undefined ? { generation: event.payload.generation } : {}),
            status: event.payload.status,
            ...(event.payload.summary ? { summary: event.payload.summary } : {}),
            ...(event.payload.error ? { error: event.payload.error } : {}),
          },
          event.time,
        );
      }
    }
  }

  private applyTeamMessageDeliveryQueued(event: Extract<AgentEvent, { type: "agent.message_queued" }>): void {
    const metadata = teamMailboxMetadata(event.payload.message);
    if (!metadata) return;
    this.db
      .query(
        `insert into team_message_deliveries
           (mailbox_message_id, team_id, team_message_id, path, child_session_id, child_thread_id,
            trigger_turn, status, error, queued_at, updated_at, delivered_at)
         values (?, ?, ?, ?, ?, ?, ?, 'queued', null, ?, ?, null)
         on conflict(mailbox_message_id) do update set
           team_id = excluded.team_id,
           team_message_id = excluded.team_message_id,
           path = excluded.path,
           child_session_id = excluded.child_session_id,
           child_thread_id = excluded.child_thread_id,
           trigger_turn = excluded.trigger_turn,
           status = 'queued',
           error = null,
           updated_at = excluded.updated_at,
           delivered_at = null`,
      )
      .run(
        event.id,
        metadata.teamId,
        metadata.teamMessageId,
        event.payload.path,
        event.payload.childSessionId ?? null,
        event.payload.childThreadId ?? null,
        event.payload.triggerTurn ? 1 : 0,
        event.time,
        event.time,
      );
  }

  private applyTeamMessageDeliveryStatus(
    mailboxMessageId: string,
    status: TeamMessageDeliveryStatus,
    time: number,
    error?: string,
  ): void {
    this.db
      .query(
        `update team_message_deliveries
         set status = ?,
             error = ?,
             updated_at = ?,
             delivered_at = case when ? = 'delivered' then ? else delivered_at end
         where mailbox_message_id = ?`,
      )
      .run(status, error ?? null, time, status, time, mailboxMessageId);
  }

  private applyAgentSpawnToTask(
    event: Extract<AgentEvent, { type: "agent.spawned" }>,
    parentSessionId: string | null,
    parentThreadId: string | null,
    payloadGeneration: number | undefined,
  ): void {
    const taskId = event.payload.taskId;
    if (!taskId) return;
    const current = this.agentTaskState(taskId);
    if (current && !shouldApplySpawnToTask(current, payloadGeneration)) return;
    const generation = payloadGeneration ?? current?.generation ?? 0;

    this.db
      .query(
        `insert into agent_tasks
           (id, path, parent_path, parent_session_id, parent_thread_id, child_session_id, child_thread_id,
            task_name, cwd, mode, status, generation, current_run_id, lease_owner, lease_expires_at,
            lease_heartbeat_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, null, null, null, ?, ?)
         on conflict(id) do update set
           status = 'running',
           generation = excluded.generation,
           current_run_id = excluded.current_run_id,
           path = excluded.path,
           parent_path = coalesce(excluded.parent_path, agent_tasks.parent_path),
           parent_session_id = coalesce(excluded.parent_session_id, agent_tasks.parent_session_id),
           parent_thread_id = coalesce(excluded.parent_thread_id, agent_tasks.parent_thread_id),
           child_session_id = coalesce(excluded.child_session_id, agent_tasks.child_session_id),
           child_thread_id = coalesce(excluded.child_thread_id, agent_tasks.child_thread_id),
           task_name = excluded.task_name,
           cwd = coalesce(excluded.cwd, agent_tasks.cwd),
           mode = coalesce(excluded.mode, agent_tasks.mode),
           summary = null,
           error = null,
           completion_json = null,
           lease_owner = null,
           lease_expires_at = null,
           lease_heartbeat_at = null,
           completed_at = null,
           updated_at = excluded.updated_at`,
      )
      .run(
        taskId,
        event.payload.path,
        event.payload.parentPath ?? null,
        parentSessionId,
        parentThreadId,
        event.payload.childSessionId ?? null,
        event.payload.childThreadId ?? null,
        event.payload.taskName,
        event.payload.cwd ?? null,
        event.payload.mode ?? null,
        generation,
        event.payload.runId,
        event.time,
        event.time,
      );
  }

  private applyAgentTaskCompletion(payload: AgentCompleteTaskPayload, time: number): void {
    const generation = normalizedGeneration(payload.generation);
    const current = this.agentTaskState(payload.taskId);
    if (current && !shouldApplyTaskCompletion(current, payload.runId, generation)) {
      return;
    }

    this.db
      .query(
        `insert into agent_tasks
           (id, path, task_name, status, generation, current_run_id, summary, error, completion_json,
            lease_owner, lease_expires_at, lease_heartbeat_at, created_at, updated_at, completed_at)
         values (?, ?, '', ?, ?, ?, ?, ?, ?, null, null, null, ?, ?, ?)
         on conflict(id) do update set
           path = excluded.path,
           status = excluded.status,
           generation = max(agent_tasks.generation, excluded.generation),
           current_run_id = coalesce(excluded.current_run_id, agent_tasks.current_run_id),
           summary = excluded.summary,
           error = excluded.error,
           completion_json = excluded.completion_json,
           lease_owner = null,
           lease_expires_at = null,
           lease_heartbeat_at = null,
           updated_at = excluded.updated_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        payload.taskId,
        payload.path,
        payload.status,
        generation ?? current?.generation ?? 0,
        payload.runId ?? null,
        payload.summary ?? null,
        payload.error ?? null,
        encodeJson(payload),
        time,
        time,
        time,
      );

    if (payload.runId) {
      this.db
        .query(
          `update agent_runs
           set status = ?, completed_at = ?, task_id = coalesce(task_id, ?), generation = max(generation, ?)
           where id = ? and completed_at is null`,
        )
        .run(payload.status, time, payload.taskId, generation ?? current?.generation ?? 0, payload.runId);
    }
  }

  private agentTaskState(taskId: TaskId): AgentTaskStateRow | undefined {
    const row = this.db
      .query<AgentTaskStateRow, [string]>(
        `select status, generation, current_run_id, lease_owner, path, parent_session_id, parent_thread_id, child_session_id
         from agent_tasks
         where id = ?`,
      )
      .get(taskId);
    return row ?? undefined;
  }

  private agentMailboxState(messageId: string): AgentMailboxProjectionRow | undefined {
    const row = this.db
      .query<AgentMailboxProjectionRow, [string]>(
        `select id, task_id, path, from_path, child_session_id, child_thread_id, trigger_turn, status,
                message_json, created_at, consumed_at
         from agent_mailbox
         where id = ?`,
      )
      .get(messageId);
    return row ?? undefined;
  }

  private async agentMailboxMessage(messageId: string): Promise<AgentMailboxRow | undefined> {
    return (await this.agentMailbox({ messageId, limit: 1 }))[0];
  }

  private parentSessionIdForTask(taskId: string | null): string | undefined {
    if (!taskId) return undefined;
    return this.db
      .query<{ parent_session_id: string | null }, [string]>(
        `select parent_session_id from agent_tasks where id = ?`,
      )
      .get(taskId)?.parent_session_id ?? undefined;
  }

  private parentThreadIdForTask(taskId: string | null): string | undefined {
    if (!taskId) return undefined;
    return this.db
      .query<{ parent_thread_id: string | null }, [string]>(
        `select parent_thread_id from agent_tasks where id = ?`,
      )
      .get(taskId)?.parent_thread_id ?? undefined;
  }

  private teamTaskState(teamId: TeamId, taskId: TaskId): TeamTaskStateRow | undefined {
    const row = this.db
      .query<TeamTaskStateRow, [string, string]>(
        `select id, team_id, status, owner_path, depends_on_json, metadata_json
         from team_tasks
         where team_id = ? and id = ?`,
      )
      .get(teamId, taskId);
    return row ?? undefined;
  }

  private teamMemberUnavailableForClaim(teamId: TeamId, ownerPath: AgentPath, taskId: TaskId): boolean {
    const row = this.db
      .query<{ status: TeamMemberRow["status"]; current_task_id: string | null }, [string, string]>(
        `select status, current_task_id
         from team_members
         where team_id = ? and path = ?`,
      )
      .get(teamId, ownerPath);
    if (!row) return false;
    if (row.status === "closed" || row.status === "blocked") return true;
    return row.status === "running" && row.current_task_id !== taskId;
  }

  private teamTaskHasRunningWriteConflict(task: TeamTaskStateRow): boolean {
    const writeScope = teamTaskWriteScope(task.metadata_json);
    if (writeScope.length === 0) return false;

    const running = this.db
      .query<{ id: string; metadata_json: string | null }, [string, string]>(
        `select id, metadata_json
         from team_tasks
         where team_id = ? and status = 'in_progress' and id <> ?`,
      )
      .all(task.team_id, task.id);
    return running.some((candidate) => {
      const candidateWriteScope = teamTaskWriteScope(candidate.metadata_json);
      return candidateWriteScope.length > 0 && scopesOverlap(writeScope, candidateWriteScope);
    });
  }

  private teamTaskDependenciesComplete(task: TeamTaskStateRow): boolean {
    const dependencies = decodeJson<TaskId[]>(task.depends_on_json ?? "[]", []);
    if (dependencies.length === 0) return true;

    const completed = this.db
      .query<{ count: number }, any>(
        `select count(*) as count
         from team_tasks
         where team_id = $teamId
           and status = 'completed'
           and id in (${dependencies.map((_, index) => `$dep${index}`).join(", ")})`,
      )
      .get(Object.fromEntries([["teamId", task.team_id], ...dependencies.map((id, index) => [`dep${index}`, id])]));
    return (completed?.count ?? 0) === dependencies.length;
  }

  private teamTaskClaimedEvent(
    input: TeamTaskClaimInput,
    current: TeamTaskStateRow,
  ): Extract<ChiliEvent, { type: "team.task_claimed" }> {
    const payload: TeamTaskClaimedPayload = {
      teamId: input.teamId,
      taskId: input.taskId,
      ownerPath: input.ownerPath,
    };
    if (input.claimedBy) payload.claimedBy = input.claimedBy;

    const event: EventEnvelope<"team.task_claimed", TeamTaskClaimedPayload> = {
      id: input.eventId,
      type: "team.task_claimed",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload,
    };
    const sessionId = input.sessionId ?? this.sessionIdForTeamTask(current.id);
    if (sessionId) event.sessionId = sessionId as SessionId;
    if (input.threadId) event.threadId = input.threadId;
    return event;
  }

  private teamTaskVerificationClaimedEvent(
    input: TeamTaskVerificationClaimInput,
    current: TeamTaskStateRow,
    metadata: Record<string, unknown>,
  ): Extract<ChiliEvent, { type: "team.task_updated" }> {
    const event: Extract<ChiliEvent, { type: "team.task_updated" }> = {
      id: input.eventId,
      type: "team.task_updated",
      time: (input.time ?? Date.now()) as EventEnvelope["time"],
      payload: {
        teamId: input.teamId,
        taskId: input.taskId,
        metadata,
      },
    };
    const sessionId = input.sessionId ?? this.sessionIdForTeamTask(current.id);
    if (sessionId) event.sessionId = sessionId as SessionId;
    if (input.threadId) event.threadId = input.threadId;
    return event;
  }

  private sessionIdForTeamTask(taskId: string): string | undefined {
    return this.db
      .query<{ session_id: string | null }, [string]>(`select session_id from team_tasks where id = ?`)
      .get(taskId)?.session_id ?? undefined;
  }

  private touchTeam(teamId: TeamId, time: number): void {
    this.db.query(`update teams set updated_at = ? where id = ?`).run(time, teamId);
  }

  private applyTeamEvent(event: TeamEvent): void {
    if (event.type === "team.created") {
      this.db
        .query(
          `insert into teams (id, session_id, name, lead_path, status, description, created_at, updated_at)
           values (?, ?, ?, ?, 'active', ?, ?, ?)
           on conflict(id) do update set
             name = excluded.name,
             lead_path = excluded.lead_path,
             description = excluded.description,
             updated_at = excluded.updated_at`,
        )
        .run(
          event.payload.teamId,
          event.sessionId ?? null,
          event.payload.name,
          event.payload.leadPath,
          event.payload.description ?? null,
          event.time,
          event.time,
        );
      return;
    }

    if (event.type === "team.member_added") {
      this.db
        .query(
          `insert into team_members
             (team_id, path, name, role, status, child_session_id, child_thread_id, model,
              tool_scope_json, write_scope_json, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(team_id, path) do update set
             name = excluded.name,
             role = excluded.role,
             status = excluded.status,
             child_session_id = coalesce(excluded.child_session_id, team_members.child_session_id),
             child_thread_id = coalesce(excluded.child_thread_id, team_members.child_thread_id),
             model = coalesce(excluded.model, team_members.model),
             tool_scope_json = coalesce(excluded.tool_scope_json, team_members.tool_scope_json),
             write_scope_json = coalesce(excluded.write_scope_json, team_members.write_scope_json),
             closed_at = null,
             updated_at = excluded.updated_at`,
        )
        .run(
          event.payload.teamId,
          event.payload.path,
          event.payload.name,
          event.payload.role,
          event.payload.status ?? "idle",
          event.payload.childSessionId ?? null,
          event.payload.childThreadId ?? null,
          event.payload.model ?? null,
          event.payload.toolScope ? encodeJson(event.payload.toolScope) : null,
          event.payload.writeScope ? encodeJson(event.payload.writeScope) : null,
          event.time,
          event.time,
        );
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.member_status_changed") {
      this.db
        .query(
          `update team_members
           set status = ?,
               current_task_id = ?,
               closed_at = case when ? = 'closed' then ? else closed_at end,
               updated_at = ?
           where team_id = ? and path = ?`,
        )
        .run(
          event.payload.status,
          event.payload.taskId ?? null,
          event.payload.status,
          event.time,
          event.time,
          event.payload.teamId,
          event.payload.path,
        );
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.task_created") {
      this.db
        .query(
          `insert into team_tasks
             (id, team_id, session_id, owner_path, status, title, description, created_by,
              depends_on_json, metadata_json, created_at, updated_at, completed_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do update set
             team_id = excluded.team_id,
             session_id = coalesce(excluded.session_id, team_tasks.session_id),
             owner_path = excluded.owner_path,
             status = excluded.status,
             title = excluded.title,
             description = excluded.description,
             created_by = excluded.created_by,
             depends_on_json = excluded.depends_on_json,
             metadata_json = excluded.metadata_json,
             completed_at = excluded.completed_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          event.payload.taskId,
          event.payload.teamId,
          event.sessionId ?? null,
          event.payload.ownerPath ?? null,
          event.payload.status ?? "pending",
          event.payload.title ?? String(event.payload.taskId),
          event.payload.description ?? null,
          event.payload.createdBy ?? null,
          encodeJson(event.payload.dependsOn ?? []),
          event.payload.metadata ? encodeJson(event.payload.metadata) : null,
          event.time,
          event.time,
          isFinalTeamTaskStatus(event.payload.status ?? "pending") ? event.time : null,
        );
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.task_assigned") {
      this.db
        .query(
          `update team_tasks
           set owner_path = ?,
               updated_at = ?
           where id = ? and team_id = ?`,
        )
        .run(event.payload.ownerPath, event.time, event.payload.taskId, event.payload.teamId);
      this.db
        .query(
          `update team_members
           set current_task_id = ?,
               updated_at = ?
           where team_id = ? and path = ?`,
        )
        .run(event.payload.taskId, event.time, event.payload.teamId, event.payload.ownerPath);
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.task_claimed") {
      this.db
        .query(
          `update team_tasks
           set owner_path = ?,
               status = 'in_progress',
               completed_at = null,
               updated_at = ?
           where id = ? and team_id = ?`,
        )
        .run(event.payload.ownerPath, event.time, event.payload.taskId, event.payload.teamId);
      this.db
        .query(
          `update team_members
           set status = 'running',
               current_task_id = ?,
               updated_at = ?
           where team_id = ? and path = ?`,
        )
        .run(event.payload.taskId, event.time, event.payload.teamId, event.payload.ownerPath);
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.task_updated") {
      const current = this.teamTaskState(event.payload.teamId, event.payload.taskId);
      const status = event.payload.status ?? current?.status ?? "pending";
      this.db
        .query(
          `update team_tasks
           set status = coalesce(?, status),
               owner_path = coalesce(?, owner_path),
               title = coalesce(?, title),
               description = coalesce(?, description),
               depends_on_json = coalesce(?, depends_on_json),
               summary = coalesce(?, summary),
               error = coalesce(?, error),
               metadata_json = coalesce(?, metadata_json),
               completed_at = case when ? in ('completed', 'failed', 'cancelled') then ? else completed_at end,
               updated_at = ?
           where id = ? and team_id = ?`,
        )
        .run(
          event.payload.status ?? null,
          event.payload.ownerPath ?? null,
          event.payload.title ?? null,
          event.payload.description ?? null,
          event.payload.dependsOn ? encodeJson(event.payload.dependsOn) : null,
          event.payload.summary ?? null,
          event.payload.error ?? null,
          event.payload.metadata ? encodeJson(event.payload.metadata) : null,
          status,
          event.time,
          event.time,
          event.payload.taskId,
          event.payload.teamId,
        );
      if (event.payload.ownerPath) {
        this.db
          .query(
            `update team_members
             set current_task_id = ?,
                 updated_at = ?
             where team_id = ? and path = ?`,
          )
          .run(event.payload.taskId, event.time, event.payload.teamId, event.payload.ownerPath);
      }
      this.touchTeam(event.payload.teamId, event.time);
      return;
    }

    if (event.type === "team.message_sent") {
      this.db
        .query(
          `insert into team_messages
             (id, team_id, from_path, to_path, task_id, kind, delivery, content, summary, metadata_json, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(id) do nothing`,
        )
        .run(
          event.payload.messageId,
          event.payload.teamId,
          event.payload.from,
          event.payload.to,
          event.payload.taskId ?? null,
          event.payload.kind ?? "text",
          event.payload.delivery ?? null,
          event.payload.content,
          event.payload.summary ?? null,
          event.payload.metadata ? encodeJson(event.payload.metadata) : null,
          event.time,
        );
      this.touchTeam(event.payload.teamId, event.time);
    }
  }

  private nextPartOrdinal(messageId: string): number {
    const row = this.db
      .query<{ count: number }, [string]>(`select count(*) as count from message_parts where message_id = ?`)
      .get(messageId);
    return row?.count ?? 0;
  }

  private eventFromRow(row: StoredEventRow): EventEnvelope {
    const event: EventEnvelope = {
      id: row.id,
      type: row.type,
      time: row.time as EventEnvelope["time"],
      payload: decodeJson(row.payload_json, {}),
    };
    if (row.session_id) {
      event.sessionId = row.session_id as SessionId;
    }
    if (row.thread_id) {
      event.threadId = row.thread_id as ThreadId;
    }
    return event;
  }
}

function approvalFromRow(row: Record<string, unknown>): ApprovalRow {
  const approval: ApprovalRow = {
    id: String(row.id),
    permission: String(row.permission),
    patterns: decodeJson(String(row.patterns_json), [] as string[]),
    status: row.status as ApprovalRow["status"],
    createdAt: Number(row.created_at),
  };
  if (row.session_id) approval.sessionId = String(row.session_id) as SessionId;
  if (row.thread_id) approval.threadId = String(row.thread_id) as ThreadId;
  if (row.call_id) approval.callId = String(row.call_id);
  if (row.metadata_json) approval.metadata = decodeJson<Record<string, unknown>>(String(row.metadata_json), {});
  if (row.decision) approval.decision = row.decision as NonNullable<ApprovalRow["decision"]>;
  if (row.feedback) approval.feedback = String(row.feedback);
  if (row.resolved_at) approval.resolvedAt = Number(row.resolved_at);
  return approval;
}

function threadGoalFromRow(row: ThreadGoalProjectionRow): ThreadGoalRow {
  const goal: ThreadGoal = {
    threadId: row.thread_id as ThreadId,
    objective: row.objective,
    status: row.status,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    createdAt: row.created_at as ThreadGoal["createdAt"],
    updatedAt: row.updated_at as ThreadGoal["updatedAt"],
  };
  if (row.session_id) goal.sessionId = row.session_id as SessionId;
  if (row.token_budget !== null) goal.tokenBudget = row.token_budget;
  if (row.completed_at !== null) goal.completedAt = row.completed_at as TimestampMs;
  if (row.last_reason) goal.lastReason = row.last_reason as NonNullable<ThreadGoal["lastReason"]>;
  return goal;
}

function agentTaskFromRow(row: AgentTaskProjectionRow): AgentTaskRow {
  const task: AgentTaskRow = {
    id: row.id as TaskId,
    path: row.path as AgentPath,
    status: row.status as AgentTaskRow["status"],
    taskName: row.task_name,
    generation: row.generation ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.parent_path) task.parentPath = row.parent_path as AgentPath;
  if (row.parent_session_id) task.parentSessionId = row.parent_session_id as SessionId;
  if (row.parent_thread_id) task.parentThreadId = row.parent_thread_id as ThreadId;
  if (row.child_session_id) task.childSessionId = row.child_session_id as SessionId;
  if (row.child_thread_id) task.childThreadId = row.child_thread_id as ThreadId;
  if (row.cwd) task.cwd = row.cwd;
  if (row.prompt) task.prompt = row.prompt;
  if (row.mode) task.mode = row.mode as NonNullable<AgentTaskRow["mode"]>;
  if (row.current_run_id) task.currentRunId = row.current_run_id;
  if (row.summary) task.summary = row.summary;
  if (row.error) task.error = row.error;
  if (row.completion_json) task.completion = decodeJson<Record<string, unknown>>(row.completion_json, {});
  if (row.lease_owner) task.leaseOwner = row.lease_owner;
  if (row.lease_expires_at !== null) task.leaseExpiresAt = row.lease_expires_at;
  if (row.lease_heartbeat_at !== null) task.leaseHeartbeatAt = row.lease_heartbeat_at;
  if (row.completed_at) task.completedAt = row.completed_at;
  return task;
}

function agentRunFromRow(row: AgentRunProjectionRow): AgentRunRow {
  const run: AgentRunRow = {
    id: row.id,
    path: row.path as AgentPath,
    taskName: row.task_name,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.session_id) run.sessionId = row.session_id as SessionId;
  if (row.thread_id) run.threadId = row.thread_id as ThreadId;
  if (row.task_id) run.taskId = row.task_id as TaskId;
  if (row.parent_path) run.parentPath = row.parent_path as AgentPath;
  if (row.parent_session_id) run.parentSessionId = row.parent_session_id as SessionId;
  if (row.parent_thread_id) run.parentThreadId = row.parent_thread_id as ThreadId;
  if (row.child_session_id) run.childSessionId = row.child_session_id as SessionId;
  if (row.child_thread_id) run.childThreadId = row.child_thread_id as ThreadId;
  if (row.cwd) run.cwd = row.cwd;
  if (row.mode) run.mode = row.mode as NonNullable<AgentRunRow["mode"]>;
  if (row.completed_at) run.completedAt = row.completed_at;
  return run;
}

function agentMailboxFromRow(row: AgentMailboxProjectionRow): AgentMailboxRow {
  const message: AgentMailboxRow = {
    id: row.id,
    path: row.path as AgentPath,
    fromPath: row.from_path as AgentPath,
    triggerTurn: row.trigger_turn === 1,
    status: row.status,
    createdAt: row.created_at,
  };
  if (row.task_id) message.taskId = row.task_id as TaskId;
  if (row.child_session_id) message.childSessionId = row.child_session_id as SessionId;
  if (row.child_thread_id) message.childThreadId = row.child_thread_id as ThreadId;
  if (row.message_json) {
    message.message = decodeJson<AgentMailboxPayload>(row.message_json, { content: "" });
  }
  if (row.consumed_at) message.consumedAt = row.consumed_at;
  return message;
}

function teamFromRow(row: TeamProjectionRow): TeamRow {
  const team: TeamRow = {
    id: row.id as TeamId,
    name: row.name,
    leadPath: row.lead_path as AgentPath,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.session_id) team.sessionId = row.session_id as SessionId;
  if (row.description) team.description = row.description;
  return team;
}

function teamMemberFromRow(row: TeamMemberProjectionRow): TeamMemberRow {
  const member: TeamMemberRow = {
    teamId: row.team_id as TeamId,
    path: row.path as AgentPath,
    name: row.name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.child_session_id) member.childSessionId = row.child_session_id as SessionId;
  if (row.child_thread_id) member.childThreadId = row.child_thread_id as ThreadId;
  if (row.model) member.model = row.model;
  if (row.tool_scope_json) member.toolScope = decodeJson<string[]>(row.tool_scope_json, []);
  if (row.write_scope_json) member.writeScope = decodeJson<string[]>(row.write_scope_json, []);
  if (row.current_task_id) member.currentTaskId = row.current_task_id as TaskId;
  if (row.closed_at) member.closedAt = row.closed_at;
  return member;
}

function teamTaskFromRow(row: TeamTaskProjectionRow): TeamTaskRow {
  const task: TeamTaskRow = {
    id: row.id as TaskId,
    teamId: row.team_id as TeamId,
    title: row.title ?? row.id,
    status: row.status,
    dependsOn: decodeJson<TaskId[]>(row.depends_on_json ?? "[]", []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.session_id) task.sessionId = row.session_id as SessionId;
  if (row.description) task.description = row.description;
  if (row.owner_path) task.ownerPath = row.owner_path as AgentPath;
  if (row.created_by) task.createdBy = row.created_by as AgentPath;
  if (row.summary) task.summary = row.summary;
  if (row.error) task.error = row.error;
  if (row.metadata_json) task.metadata = decodeJson<Record<string, unknown>>(row.metadata_json, {});
  if (row.completed_at) task.completedAt = row.completed_at;
  return task;
}

function teamTaskWriteScope(metadataJson: string | null): string[] {
  if (!metadataJson) return [];
  const metadata = decodeJson<Record<string, unknown>>(metadataJson, {});
  return metadataStringArray(metadata, ["writeScope", "write_scope", "writeScopes", "write_scopes"]) ?? [];
}

function metadataStringArray(metadata: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (!Array.isArray(value)) continue;
    const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items : [];
  }
  return undefined;
}

function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftItem) => right.some((rightItem) => pathScopeContains(leftItem, rightItem) || pathScopeContains(rightItem, leftItem)));
}

function pathScopeContains(scope: string, item: string): boolean {
  const normalizedScope = normalizePathScope(scope);
  const normalizedItem = normalizePathScope(item);
  if (normalizedScope === "*" || normalizedScope === "." || normalizedScope === "/") return true;
  return normalizedItem === normalizedScope || normalizedItem.startsWith(`${normalizedScope}/`);
}

function normalizePathScope(value: string): string {
  let normalized = value.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized || ".";
}

function teamMessageFromRow(row: TeamMessageProjectionRow): TeamMessageRow {
  const message: TeamMessageRow = {
    id: row.id,
    teamId: row.team_id as TeamId,
    fromPath: row.from_path as AgentPath,
    toPath: row.to_path as AgentPath | "*",
    content: row.content,
    kind: row.kind,
    createdAt: row.created_at,
  };
  if (row.delivery) message.delivery = row.delivery;
  if (row.delivery_status) message.deliveryStatus = row.delivery_status;
  if (row.delivery_error) message.deliveryError = row.delivery_error;
  if (row.delivery_updated_at) message.deliveryUpdatedAt = row.delivery_updated_at;
  if (row.delivered_at) message.deliveredAt = row.delivered_at;
  if (row.task_id) message.taskId = row.task_id as TaskId;
  if (row.summary) message.summary = row.summary;
  if (row.metadata_json) message.metadata = decodeJson<Record<string, unknown>>(row.metadata_json, {});
  return message;
}

function teamMessageDeliveryFromRow(row: TeamMessageDeliveryProjectionRow): TeamMessageDeliveryRow {
  const delivery: TeamMessageDeliveryRow = {
    mailboxMessageId: row.mailbox_message_id,
    teamId: row.team_id as TeamId,
    teamMessageId: row.team_message_id,
    path: row.path as AgentPath,
    status: row.status,
    triggerTurn: row.trigger_turn === 1,
    queuedAt: row.queued_at,
    updatedAt: row.updated_at,
  };
  if (row.child_session_id) delivery.childSessionId = row.child_session_id as SessionId;
  if (row.child_thread_id) delivery.childThreadId = row.child_thread_id as ThreadId;
  if (row.error) delivery.error = row.error;
  if (row.delivered_at) delivery.deliveredAt = row.delivered_at;
  return delivery;
}

function teamMailboxMetadata(payload: AgentMailboxPayload | undefined): { teamId: TeamId; teamMessageId: string } | undefined {
  const metadata = payload?.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const teamId = metadata.teamId;
  const teamMessageId = metadata.teamMessageId;
  if (typeof teamId !== "string" || teamId.length === 0) return undefined;
  if (typeof teamMessageId !== "string" || teamMessageId.length === 0) return undefined;
  return { teamId: teamId as TeamId, teamMessageId };
}

function applyPartDelta(part: MessagePart, field: string, delta: string): MessagePart {
  if (field === "text" && (part.type === "text" || part.type === "reasoning")) {
    return { ...part, text: part.text + delta };
  }
  if (field === "output" && part.type === "tool_result") {
    return { ...part, output: part.output + delta };
  }
  return part;
}

function normalizedGeneration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function shouldApplySpawnToTask(current: AgentTaskStateRow, generation: number | undefined): boolean {
  if (generation !== undefined && generation < current.generation) return false;
  if (isFinalTaskStatus(current.status)) {
    return generation !== undefined && generation > current.generation;
  }
  return generation === undefined || generation >= current.generation;
}

function shouldApplyTaskCompletion(
  current: AgentTaskStateRow,
  runId: string | undefined,
  generation: number | undefined,
): boolean {
  if (isFinalTaskStatus(current.status)) return false;
  if (runId && current.current_run_id && current.current_run_id !== runId) return false;
  if (generation !== undefined && generation < current.generation) return false;
  return true;
}

function isFinalTaskStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isFinalTeamTaskStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function verificationStatus(metadataJson: string | null): string | undefined {
  if (!metadataJson) return undefined;
  const metadata = decodeJson<Record<string, unknown>>(metadataJson, {});
  const verification = metadata.verification;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) return undefined;
  const status = (verification as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

function isStalePendingVerification(metadataJson: string | null, stalePendingBefore: number | undefined): boolean {
  if (stalePendingBefore === undefined || verificationStatus(metadataJson) !== "pending") return false;
  const metadata = decodeJson<Record<string, unknown>>(metadataJson ?? "{}", {});
  const verification = metadata.verification;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) return false;
  const startedAt = (verification as Record<string, unknown>).startedAt;
  return typeof startedAt !== "number" || startedAt <= stalePendingBefore;
}

function verificationClaimMetadata(metadataJson: string | null, claimMetadata: Record<string, unknown>): Record<string, unknown> {
  const current = decodeJson<Record<string, unknown>>(metadataJson ?? "{}", {});
  return {
    ...current,
    verification: claimMetadata.verification,
  };
}

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("database is locked") || message.includes("database busy") || message.includes("sqlite_busy");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type { AgentMailboxRow, AgentRunRow, AgentTaskRow };
