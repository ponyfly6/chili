import { Database } from "bun:sqlite";
import type {
  AgentEvent,
  ApprovalEvent,
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  MessageEvent,
  MessagePart,
  SessionId,
  SessionEvent,
  TeamEvent,
  ThreadId,
  ToolEvent,
} from "@chili/protocol";
import { decodeJson, encodeJson } from "./json.js";
import { SQLITE_SCHEMA } from "./schema.js";
import type {
  AgentRunRow,
  ApprovalRow,
  EventMirror,
  EventQuery,
  EventStore,
  SessionRow,
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

export interface SqliteEventStoreOptions {
  mirror?: EventMirror;
  onMirrorError?: (error: unknown, event: ChiliEvent) => void;
}

export class SqliteEventStore implements EventStore {
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
    if (event.type === "agent.spawned") {
      this.db
        .query(
          `insert into agent_runs
             (id, session_id, thread_id, path, parent_path, task_name, status, created_at)
           values (?, ?, ?, ?, ?, ?, 'running', ?)
           on conflict(id) do update set status = 'running'`,
        )
        .run(
          event.payload.runId,
          event.sessionId ?? null,
          event.threadId ?? null,
          event.payload.path,
          event.payload.parentPath ?? null,
          event.payload.taskName,
          event.time,
        );
      return;
    }

    if (event.type === "agent.completed") {
      this.db
        .query(`update agent_runs set status = ?, completed_at = ? where id = ?`)
        .run(event.payload.status, event.time, event.payload.runId);
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

function applyPartDelta(part: MessagePart, field: string, delta: string): MessagePart {
  if (field === "text" && (part.type === "text" || part.type === "reasoning")) {
    return { ...part, text: part.text + delta };
  }
  if (field === "output" && part.type === "tool_result") {
    return { ...part, output: part.output + delta };
  }
  return part;
}

export type { AgentRunRow };
