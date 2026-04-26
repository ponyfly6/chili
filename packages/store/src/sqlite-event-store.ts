import { Database } from "bun:sqlite";
import type {
  AgentCompleteTaskPayload,
  AgentEvent,
  ApprovalEvent,
  ChiliEvent,
  EventEnvelope,
  AgentPath,
  AgentMailboxPayload,
  Message,
  MessageId,
  MessageEvent,
  MessagePart,
  SessionId,
  TaskId,
  SessionEvent,
  TeamEvent,
  ThreadId,
  ToolEvent,
} from "@chili/protocol";
import { decodeJson, encodeJson } from "./json.js";
import { SQLITE_SCHEMA } from "./schema.js";
import type {
  AgentMailboxQuery,
  AgentMailboxRow,
  AgentRunRow,
  AgentRunQuery,
  AgentTaskQuery,
  AgentTaskRow,
  ApprovalRow,
  EventMirror,
  EventQuery,
  EventStore,
  SessionRow,
  SubagentProjectionStore,
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
  role: "system" | "user" | "assistant" | "tool";
  parent_id: string | null;
  created_at: number;
}

interface PartRow {
  data_json: string;
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
  created_at: number;
  updated_at: number;
  completed_at: number | null;
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

export interface SqliteEventStoreOptions {
  mirror?: EventMirror;
  onMirrorError?: (error: unknown, event: ChiliEvent) => void;
}

export class SqliteEventStore implements EventStore, SubagentProjectionStore {
  private readonly db: Database;

  constructor(path = ".chili/chili.sqlite", private readonly options: SqliteEventStoreOptions = {}) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("pragma journal_mode = WAL");
    this.db.exec("pragma foreign_keys = ON");
    const [eventTableStatement, ...remainingStatements] = SQLITE_SCHEMA;
    if (eventTableStatement) {
      this.db.exec(eventTableStatement);
    }
    this.migrateEventSequence();
    for (const statement of remainingStatements) {
      this.db.exec(statement);
    }
    this.migrateSubagentSchema();
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

    const rows = this.db
      .query<StoredEventRow, any>(
        `select seq, id, type, time, session_id, thread_id, payload_json
         from events
         ${where}
         order by seq asc
         limit $limit`,
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
        `select id, session_id, thread_id, role, parent_id, created_at
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
                created_at, updated_at, completed_at
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
                child_session_id, child_thread_id, task_name, cwd, mode, status, created_at, completed_at
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

  private writeTransaction(events: readonly ChiliEvent[]): void {
    const run = this.db.transaction((items: readonly ChiliEvent[]) => {
      for (const event of items) {
        this.insertEvent(event);
        this.applyProjection(event);
      }
    });
    run(events);
  }

  private async writeMirror(event: ChiliEvent): Promise<void> {
    if (!this.options.mirror) return;
    try {
      await this.options.mirror.write(event);
    } catch (error) {
      this.options.onMirrorError?.(error, event);
    }
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
    this.addColumnIfMissing("agent_mailbox", "consumed_at", "integer");
    this.db.exec(`create index if not exists agent_runs_task_idx on agent_runs(task_id)`);
    this.db.exec(`create index if not exists agent_runs_child_session_idx on agent_runs(child_session_id)`);
    this.db.exec(`create index if not exists agent_mailbox_status_idx on agent_mailbox(status, created_at)`);
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
          `insert into messages (id, session_id, thread_id, role, parent_id, created_at)
           values (?, ?, ?, ?, null, ?)
           on conflict(id) do nothing`,
        )
        .run(event.payload.messageId, event.sessionId, event.threadId ?? null, event.payload.role, event.time);
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
             (id, session_id, thread_id, call_id, permission, patterns_json, status, created_at)
           values (?, ?, ?, ?, ?, ?, 'pending', ?)
           on conflict(id) do update set status = 'pending'`,
        )
        .run(
          event.payload.approvalId,
          event.sessionId ?? null,
          event.threadId ?? null,
          event.payload.callId ?? null,
          event.payload.permission,
          encodeJson(event.payload.patterns),
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
      this.db
        .query(
          `insert into agent_runs
             (id, session_id, thread_id, task_id, path, parent_path, parent_session_id, parent_thread_id,
              child_session_id, child_thread_id, task_name, cwd, mode, status, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
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
             completed_at = null`,
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
          event.time,
        );
      if (event.payload.taskId) {
        this.db
          .query(
            `insert into agent_tasks
               (id, path, parent_path, parent_session_id, parent_thread_id, child_session_id, child_thread_id,
                task_name, cwd, mode, status, current_run_id, created_at, updated_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
             on conflict(id) do update set
               status = 'running',
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
               updated_at = excluded.updated_at`,
          )
          .run(
            event.payload.taskId,
            event.payload.path,
            event.payload.parentPath ?? null,
            parentSessionId,
            parentThreadId,
            event.payload.childSessionId ?? null,
            event.payload.childThreadId ?? null,
            event.payload.taskName,
            event.payload.cwd ?? null,
            event.payload.mode ?? null,
            event.payload.runId,
            event.time,
            event.time,
          );
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
      return;
    }

    if (event.type === "agent.message_consumed") {
      this.db
        .query(`update agent_mailbox set status = 'consumed', consumed_at = ? where id = ?`)
        .run(event.time, event.payload.messageId);
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
           set status = ?, completed_at = ?, task_id = coalesce(?, task_id)
           where id = ?`,
        )
        .run(event.payload.status, event.time, event.payload.taskId ?? null, event.payload.runId);
      if (event.payload.taskId) {
        this.applyAgentTaskCompletion(
          {
            taskId: event.payload.taskId,
            path: event.payload.path,
            runId: event.payload.runId,
            status: event.payload.status,
            ...(event.payload.summary ? { summary: event.payload.summary } : {}),
            ...(event.payload.error ? { error: event.payload.error } : {}),
          },
          event.time,
        );
      }
    }
  }

  private applyAgentTaskCompletion(payload: AgentCompleteTaskPayload, time: number): void {
    this.db
      .query(
        `insert into agent_tasks
           (id, path, task_name, status, current_run_id, summary, error, completion_json, created_at, updated_at, completed_at)
         values (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           path = excluded.path,
           status = excluded.status,
           current_run_id = coalesce(excluded.current_run_id, agent_tasks.current_run_id),
           summary = excluded.summary,
           error = excluded.error,
           completion_json = excluded.completion_json,
           updated_at = excluded.updated_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        payload.taskId,
        payload.path,
        payload.status,
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
        .query(`update agent_runs set status = ?, completed_at = ?, task_id = coalesce(task_id, ?) where id = ?`)
        .run(payload.status, time, payload.taskId, payload.runId);
    }
  }

  private applyTeamEvent(event: TeamEvent): void {
    if (event.type === "team.created") {
      this.db
        .query(
          `insert into teams (id, session_id, name, lead_path, status, created_at, updated_at)
           values (?, ?, ?, ?, 'active', ?, ?)
           on conflict(id) do update set updated_at = excluded.updated_at`,
        )
        .run(event.payload.teamId, event.sessionId ?? null, event.payload.name, event.payload.leadPath, event.time, event.time);
      return;
    }

    if (event.type === "team.task_created") {
      this.db
        .query(
          `insert into team_tasks (id, team_id, session_id, owner_path, status, created_at, updated_at)
           values (?, ?, ?, ?, 'pending', ?, ?)
           on conflict(id) do nothing`,
        )
        .run(
          event.payload.taskId,
          event.payload.teamId,
          event.sessionId ?? null,
          event.payload.ownerPath ?? null,
          event.time,
          event.time,
        );
      return;
    }

    if (event.type === "team.task_updated") {
      this.db
        .query(`update team_tasks set status = ?, updated_at = ? where id = ?`)
        .run(event.payload.status, event.time, event.payload.taskId);
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
  if (row.decision) approval.decision = row.decision as NonNullable<ApprovalRow["decision"]>;
  if (row.feedback) approval.feedback = String(row.feedback);
  if (row.resolved_at) approval.resolvedAt = Number(row.resolved_at);
  return approval;
}

function agentTaskFromRow(row: AgentTaskProjectionRow): AgentTaskRow {
  const task: AgentTaskRow = {
    id: row.id as TaskId,
    path: row.path as AgentPath,
    status: row.status as AgentTaskRow["status"],
    taskName: row.task_name,
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

function applyPartDelta(part: MessagePart, field: string, delta: string): MessagePart {
  if (field === "text" && (part.type === "text" || part.type === "reasoning")) {
    return { ...part, text: part.text + delta };
  }
  if (field === "output" && part.type === "tool_result") {
    return { ...part, output: part.output + delta };
  }
  return part;
}

export type { AgentMailboxRow, AgentRunRow, AgentTaskRow };
