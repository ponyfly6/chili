import type { Database } from "bun:sqlite";
import {
  RUNTIME_STATE_SNAPSHOT_MAX_BYTES,
  type ChiliEvent, type RuntimeStateSnapshot, type SessionId,
} from "@chili/protocol";

const MAX_SESSIONS = 1_024;
const MAX_REQUIRED_ROWS = 4_096;
const HISTORY_MESSAGES = 40;
const JSON_BYTES = 128_000;
const MAX_NATIVE_JSON_BYTES = 16_000_000;
const OMITTED = "\n[Snapshot display truncated; full content remains in storage.]";
type Row = Record<string, string | number | null>;
interface EventRow extends Row { seq: number; id: string; type: string; time: number; payload_json: string | null; native_too_large: number; }
interface Seed { seq: number; ordinal: number; event: ChiliEvent; sourceSeq?: number; }

export interface RuntimeSnapshotOptions { sessionId?: SessionId; maxBytes?: number; }

export class RuntimeSnapshotLimitError extends Error {
  override readonly name = "RuntimeSnapshotLimitError";
  constructor() { super("Required runtime state exceeds the snapshot capacity; narrow the snapshot to a session."); }
}

/** No awaits inside this transaction: projections and the resume cursor share one SQLite read view. */
export function readRuntimeStateSnapshot(db: Database, options: RuntimeSnapshotOptions = {}): RuntimeStateSnapshot {
  const maxBytes = Math.min(options.maxBytes ?? RUNTIME_STATE_SNAPSHOT_MAX_BYTES, RUNTIME_STATE_SNAPSHOT_MAX_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("snapshot maxBytes must be positive");
  // A UTF-16 character may consume four UTF-8 bytes. Reserve room for multiple display
  // fields and identity anchors even when callers request a smaller response budget.
  const FIELD_CHARS = Math.max(32, Math.min(16_000, Math.floor(maxBytes / 32)));
  return db.transaction(() => {
    const tip = options.sessionId
      ? db.query<{ id: string; seq: number }, [string]>("select id, seq from events where session_id = ? order by seq desc limit 1").get(options.sessionId)
      : db.query<{ id: string; seq: number }, []>("select id, seq from events order by seq desc limit 1").get();
    const sessionIds = db.query<{ id: string }, string[]>(`select id from sessions ${options.sessionId ? "where id = ?" : ""} order by created_at, id limit ${MAX_SESSIONS + 1}`).all(...(options.sessionId ? [options.sessionId] : []));
    if (sessionIds.length > MAX_SESSIONS) throw new RuntimeSnapshotLimitError();
    const sessionRows = queryRows<Row>(db, `select id, substr(cwd, 1, ${FIELD_CHARS}) as cwd,
      substr(title, 1, ${FIELD_CHARS}) as title, status, created_at, updated_at,
      parent_session_id, agent_name, agent_path,
      case when length(cast(agent_policy_json as blob)) <= ${JSON_BYTES} then agent_policy_json end as agent_policy_json
      from sessions ${options.sessionId ? "where id = ?" : ""} order by created_at, id limit ${MAX_SESSIONS + 1}`, ...(options.sessionId ? [options.sessionId] : []));
    const snapshot: RuntimeStateSnapshot = {
      version: 1, ...(tip ? { afterEventId: tip.id } : {}), events: [],
      coveredSessionIds: sessionIds.map((row) => String(row.id) as SessionId),
      truncated: false, temporaryOutput: "not-replayed",
    };
    let usedBytes = Buffer.byteLength(JSON.stringify(snapshot)) + 256;
    let ordinal = 0;
    const seeds: Seed[] = [];
    const history: { sessionId: string; ids: Row[] }[] = [];
    const messageIds = new Set<string>();
    const toolIds = new Set<string>();
    const seededEventSeqs = new Set<number>();
    const markTruncated = () => { snapshot.truncated = true; };
    const text = (value: string | number | null | undefined, originalLength?: string | number | null): string => {
      const result = String(value ?? "");
      if (Number(originalLength ?? Array.from(result).length) > Array.from(result).length) { markTruncated(); return result + OMITTED; }
      return result;
    };
    const add = (type: string, payload: unknown, sessionId: string | undefined, time: number, seq = 0): void => {
      const event = {
        id: `snapshot:${tip?.seq ?? 0}:${ordinal}`, type, time,
        ...(sessionId ? { sessionId } : {}), payload,
      } as ChiliEvent;
      const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (usedBytes + bytes > maxBytes) throw new RuntimeSnapshotLimitError();
      usedBytes += bytes;
      seeds.push({ seq, ordinal: ordinal++, event });
    };
    const boundedJson = (json: string | number | null | undefined, fallback: unknown = {}): unknown => {
      if (json === null || json === undefined) { markTruncated(); return fallback; }
      return JSON.parse(String(json));
    };
    const latest = (sessionId: string, type: string, extra = "", values: string[] = []): EventRow | null => db.query<EventRow, string[]>(
      `select seq, id, type, time, length(cast(payload_json as blob)) > ${MAX_NATIVE_JSON_BYTES} as native_too_large,
       case when length(cast(payload_json as blob)) <= ${JSON_BYTES} then payload_json end as payload_json
       from events where session_id = ? and type = ? ${extra
        ? `and case when length(cast(payload_json as blob)) > ${MAX_NATIVE_JSON_BYTES} then 1 else (${extra.replace(/^and /u, "")}) end`
        : ""} order by seq desc limit 1`,
    ).get(sessionId, type, ...values);
    const eventPayload = (row: EventRow): unknown => {
      if (row.native_too_large) throw new RuntimeSnapshotLimitError();
      if (row.payload_json !== null) return JSON.parse(row.payload_json);
      // Diagnostic strings can exceed the SSE limit. Select only bounded display fields,
      // never load their entire JSON blob into JavaScript just to truncate it afterwards.
      markTruncated();
      const fields: Record<string, string[]> = {
        "session.status_changed": ["sessionId", "status", "turnId", "reason"],
        "turn.retry_scheduled": ["turnId", "attempt", "delayMs", "reason"],
        "turn.completed": ["turnId", "status"],
        "turn.started": ["turnId"],
        "turn.model_metadata": ["turnId", "provider", "model", "responseId", "contextWindowTokens", "maxOutputTokens"],
      };
      const names = fields[row.type];
      if (!names) throw new RuntimeSnapshotLimitError();
      const value = db.query<Row, [number]>(`select ${names.map((name) =>
        `case when json_type(payload_json, '$.${name}') = 'text' then substr(json_extract(payload_json, '$.${name}'), 1, ${FIELD_CHARS}) else json_extract(payload_json, '$.${name}') end as ${name}`).join(", ")}
        from events where seq = ?`).get(row.seq)!;
      return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null));
    };
    const seedEvent = (row: EventRow, sessionId: string): void => {
      if (seededEventSeqs.has(row.seq)) return;
      add(row.type, eventPayload(row), sessionId, row.time, row.seq);
      seededEventSeqs.add(row.seq);
      seeds[seeds.length - 1]!.sourceSeq = row.seq;
    };
    const readMessage = (row: Row, required: boolean): void => {
      const id = String(row.id);
      if (messageIds.has(id)) return;
      const checkpoint = { length: seeds.length, bytes: usedBytes, ordinal };
      try {
        const sessionId = String(row.session_id);
        const seq = Number(row.created_event_seq);
        if (row.turn_id) {
          for (const type of ["turn.started", "turn.completed", "turn.model_metadata"]) {
            const event = latest(sessionId, type, "and json_extract(payload_json, '$.turnId') = ?", [String(row.turn_id)]);
            if (event) seedEvent(event, sessionId);
          }
        }
        add("message.created", { messageId: id, role: row.role, ...(row.turn_id ? { turnId: row.turn_id } : {}) }, sessionId, Number(row.created_at), seq);
        const parts = queryRows<Row>(db, `select id, type, ordinal, delta_event_seq, created_at,
          length(cast(data_json as blob)) > ${MAX_NATIVE_JSON_BYTES} as native_too_large,
          case when length(cast(data_json as blob)) <= ${MAX_NATIVE_JSON_BYTES} then
            case when length(cast(json_remove(data_json, '$.structuredData', '$.modelOutput') as blob)) <= ${JSON_BYTES}
            then json_remove(data_json, '$.structuredData', '$.modelOutput') end end as data_json
          from message_parts where message_id = ? order by ordinal limit ${MAX_REQUIRED_ROWS + 1}`, id);
        let partCount = 0;
        for (const partRow of parts) {
          if (++partCount > MAX_REQUIRED_ROWS) throw new RuntimeSnapshotLimitError();
          if (partRow.native_too_large) throw new RuntimeSnapshotLimitError();
          let part: Record<string, unknown>;
          if (partRow.data_json !== null) part = JSON.parse(String(partRow.data_json)) as Record<string, unknown>;
          else {
            markTruncated();
            // Preserve identity/type anchors even when an image, tool result or text is huge.
            const fields = db.query<Row, [string]>(`select ${["text", "displayText", "output", "error", "callId", "providerCallId", "toolName", "status", "phase", "mimeType", "filename", "sourcePath", "agentPath", "summary", "artifactId", "boundaryMessageId", "reason"].map((field) =>
              `substr(json_extract(data_json, '$.${field}'), 1, ${FIELD_CHARS}) as ${field}`).join(", ")}
              from message_parts where id = ?`).get(String(partRow.id))!;
            part = { id: partRow.id, type: partRow.type, messageId: id, sessionId,
              ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)) };
            if (partRow.type === "image") { part.data = ""; part.displayText = "[Image omitted from recovery snapshot]"; }
            if (partRow.type === "tool_call") part.input = { omitted: "Snapshot input exceeded display limit" };
            if (partRow.type === "patch") part.files = [];
            if (partRow.type === "text" || partRow.type === "reasoning") part.text = String(part.text ?? "") + OMITTED;
            if (partRow.type === "tool_result") part.output = String(part.output ?? "") + OMITTED;
          }
          // The store checkpoints deltas only at turn completion. Fold the pending durable ledger
          // into each seed before advancing the snapshot high-water mark.
          const field = part.type === "text" || part.type === "reasoning" ? "text" : part.type === "tool_result" ? "output" : undefined;
          if (field) {
            if (db.query<{ found: number }, [string, number]>(`select 1 as found from events
              where session_id = ? and type = 'message.part_delta' and seq > ?
                and length(cast(payload_json as blob)) > ${MAX_NATIVE_JSON_BYTES} limit 1`)
              .get(sessionId, Number(partRow.delta_event_seq))) throw new RuntimeSnapshotLimitError();
            let value = String(part[field] ?? "");
            let clipped = value.length > FIELD_CHARS;
            value = unicodePrefix(value, FIELD_CHARS);
            const deltas = queryRows<{ delta: string; size: number }>(db, `select
              substr(json_extract(payload_json, '$.delta'), 1, ${FIELD_CHARS}) as delta,
              length(json_extract(payload_json, '$.delta')) as size from events
              where type = 'message.part_delta' and session_id = ?4 and seq > ?2 and json_extract(payload_json, '$.partId') = ?1
                and json_extract(payload_json, '$.field') = ?3 order by seq`, String(partRow.id), Number(partRow.delta_event_seq), field, sessionId);
            // Once the display prefix is full, only an EXISTS check is needed, never all remaining
            // deltas. The snapshot explicitly marks the display omission while preserving anchors.
            let deltaCount = 0;
            for (const delta of deltas) {
              if (++deltaCount > 65_536) throw new RuntimeSnapshotLimitError();
              const remaining = FIELD_CHARS - value.length;
              const suffix = unicodePrefix(delta.delta, Math.max(0, remaining));
              value += suffix;
              if (suffix.length < delta.delta.length || delta.size > Array.from(delta.delta).length) { clipped = true; break; }
            }
            if (clipped) { markTruncated(); value += OMITTED; }
            part[field] = value;
          }
          add("message.part_added", { messageId: id, part }, sessionId, Number(partRow.created_at), seq + 0.1);
        }
        messageIds.add(id);
      } catch (error) {
        if (required || !(error instanceof RuntimeSnapshotLimitError)) throw error;
        for (const seed of seeds.slice(checkpoint.length)) if (seed.sourceSeq !== undefined) seededEventSeqs.delete(seed.sourceSeq);
        seeds.length = checkpoint.length; usedBytes = checkpoint.bytes; ordinal = checkpoint.ordinal;
        markTruncated();
      }
    };
    const readTools = (sessionId: string, turnId?: string): void => {
      const rows = queryRows<Row>(db, `select id, provider_call_id, parent_call_id, turn_id, tool_name, status,
        case when length(cast(input_json as blob)) <= ${JSON_BYTES} then input_json end as input_json,
        substr(output, 1, ${FIELD_CHARS}) as output, length(output) as output_length,
        substr(error, 1, ${FIELD_CHARS}) as error, length(error) as error_length,
        synthetic, started_at, updated_at,
        (select min(seq) from events where type = 'tool.call_started' and events.session_id = tool_calls.session_id
          and case when length(cast(payload_json as blob)) <= ${MAX_NATIVE_JSON_BYTES}
            then json_extract(payload_json, '$.callId') end = tool_calls.id) as seq
        from tool_calls where session_id = ? and (status not in ('completed', 'failed', 'cancelled') ${turnId ? "or turn_id = ?" : ""}
          or id in (select call_id from approvals where session_id = tool_calls.session_id and status = 'pending')
          or id = (select id from tool_calls where session_id = ? order by updated_at desc, rowid desc limit 1))
        order by started_at, id limit ${MAX_REQUIRED_ROWS + 1}`, sessionId, ...(turnId ? [turnId] : []), sessionId);
      let toolCount = 0;
      for (const row of rows) {
        if (++toolCount > MAX_REQUIRED_ROWS) throw new RuntimeSnapshotLimitError();
        const callId = String(row.id);
        if (toolIds.has(callId)) continue;
        toolIds.add(callId);
        add("tool.call_started", {
          callId, turnId: row.turn_id ?? `snapshot-turn:${sessionId}`, toolName: row.tool_name,
          input: boundedJson(row.input_json, { omitted: "Snapshot input exceeded display limit" }),
          ...(row.provider_call_id ? { providerCallId: row.provider_call_id } : {}),
          ...(row.parent_call_id ? { parentCallId: row.parent_call_id } : {}),
        }, sessionId, Number(row.started_at), Number(row.seq ?? 0));
        if (["completed", "failed", "cancelled"].includes(String(row.status))) {
          add("tool.call_finished", { callId, status: row.status,
            ...(row.output !== null ? { output: text(row.output, row.output_length) } : {}),
            ...(row.error !== null ? { error: text(row.error, row.error_length) } : {}),
            ...(row.synthetic ? { synthetic: true } : {}),
          }, sessionId, Number(row.updated_at), Number(row.seq ?? 0) + 0.2);
        } else if (row.status !== "running") add("tool.call_updated", { callId, status: row.status }, sessionId, Number(row.updated_at), Number(row.seq ?? 0) + 0.2);
      }
    };

    for (const session of sessionRows) {
      const sessionId = String(session.id);
      if (session.parent_session_id && session.agent_policy_json === null) throw new RuntimeSnapshotLimitError();
      add("session.created", { sessionId, cwd: session.cwd,
        ...(session.parent_session_id ? { agent: { parentSessionId: session.parent_session_id,
          name: session.agent_name, path: session.agent_path, policy: boundedJson(session.agent_policy_json) } } : {}),
      }, sessionId, Number(session.created_at), -2);
      if (session.title) add("session.renamed", { sessionId, title: session.title }, sessionId, Number(session.updated_at), -1);
      const started = latest(sessionId, "turn.started");
      const startedPayload = started ? eventPayload(started) as { turnId: string } : undefined;
      const completed = startedPayload ? latest(sessionId, "turn.completed", "and json_extract(payload_json, '$.turnId') = ?", [startedPayload.turnId]) : null;
      const activeTurnId = startedPayload && !completed ? startedPayload.turnId : undefined;
      const requiredMessages = db.query<Row, string[]>(`select * from messages where session_id = ?
        and (${activeTurnId ? "turn_id = ? or" : ""} id = (select id from messages where session_id = ? order by created_event_seq desc, created_at desc, id desc limit 1))
        order by created_event_seq, created_at, id limit ${MAX_REQUIRED_ROWS + 1}`)
        .all(sessionId, ...(activeTurnId ? [activeTurnId] : []), sessionId);
      if (requiredMessages.length > MAX_REQUIRED_ROWS) throw new RuntimeSnapshotLimitError();
      for (const message of requiredMessages) readMessage(message, true);
      readTools(sessionId, activeTurnId ?? startedPayload?.turnId);
      const recent = db.query<Row, [string]>(`select * from messages where session_id = ?
        order by created_event_seq desc, created_at desc, id desc limit ${HISTORY_MESSAGES + 1}`).all(sessionId);
      if (recent.length > HISTORY_MESSAGES) markTruncated();
      history.push({ sessionId, ids: recent.slice(0, HISTORY_MESSAGES).reverse() });
      for (const type of ["session.model_changed", "session.reasoning_changed", "session.service_tier_changed", "session.delegation_changed"]) {
        const event = latest(sessionId, type); if (event) seedEvent(event, sessionId);
      }
      if (started) seedEvent(started, sessionId);
      if (completed) seedEvent(completed, sessionId);
      const metadata = latest(sessionId, "turn.model_metadata"); if (metadata) seedEvent(metadata, sessionId);
      const status = latest(sessionId, "session.status_changed"); if (status) seedEvent(status, sessionId);
      const retry = latest(sessionId, "turn.retry_scheduled");
      if (retry) {
        const clearing = db.query<{ seq: number }, [string]>(`select max(seq) as seq from events where session_id = ? and type in
          ('session.status_changed','turn.started','turn.completed','turn.model_metadata','message.part_added','message.part_delta','tool.call_started')`).get(sessionId);
        if (retry.seq > (clearing?.seq ?? 0)) seedEvent(retry, sessionId);
      }
      const approvals = queryRows<Row>(db, `select id, call_id, permission, max_approval_scope, created_at,
        case when length(cast(patterns_json as blob)) <= ${JSON_BYTES} then patterns_json end as patterns_json,
        case when length(cast(metadata_json as blob)) <= ${JSON_BYTES} then metadata_json end as metadata_json
        from approvals where session_id = ? and status = 'pending' order by created_at limit ${MAX_REQUIRED_ROWS + 1}`, sessionId);
      let approvalCount = 0;
      for (const approval of approvals) {
        if (++approvalCount > MAX_REQUIRED_ROWS) throw new RuntimeSnapshotLimitError();
        if (approval.patterns_json === null) throw new RuntimeSnapshotLimitError();
        add("approval.requested", { approvalId: approval.id, permission: approval.permission,
          patterns: boundedJson(approval.patterns_json), ...(approval.call_id ? { callId: approval.call_id } : {}),
          ...(approval.max_approval_scope ? { maxApprovalScope: approval.max_approval_scope } : {}),
          ...(approval.metadata_json ? { metadata: boundedJson(approval.metadata_json) } : {}),
        }, sessionId, Number(approval.created_at), (tip?.seq ?? 0) + 0.3);
      }
      // Archive/cancellation may update the queue projection without a separate queue event.
      // Read the current projection, excluding private payload/identity columns entirely.
      const dispatch = db.query<Row, [string]>("select paused, revision from session_dispatch where session_id = ?").get(sessionId);
      const inputColumns = `input_id, submission_id, session_id, mode, state, revision, sequence,
        substr(text, 1, ${FIELD_CHARS}) as text, length(text) as text_length, accepted_at, updated_at,
        execution_ref, message_id, result_message_id, turn_id, outcome,
        substr(error, 1, ${FIELD_CHARS}) as error, length(error) as error_length`;
      const activeInputs = queryRows<Row>(db, `select ${inputColumns} from session_inputs
        where session_id = ? and state != 'settled'
        order by resumed desc, case mode when 'steer' then 0 else 1 end, sequence limit ${MAX_REQUIRED_ROWS + 1}`, sessionId);
      const interrupted = db.query<Row, [string, string]>(`select ${inputColumns} from session_inputs
        where session_id = ? and state = 'settled' and outcome != 'completed' and claim_id is not null
          and settled_revision > coalesce((select max(settled_revision) from session_inputs where session_id = ? and outcome = 'completed'), 0)
        order by settled_revision desc limit 1`).get(sessionId, sessionId);
      const items: Record<string, unknown>[] = [];
      let queueBytes = 0;
      const addInput = (row: Row): void => {
        const item = { inputId: row.input_id, submissionId: row.submission_id, sessionId: row.session_id,
          mode: row.mode, state: row.state, revision: row.revision, sequence: row.sequence,
          text: text(row.text, row.text_length), acceptedAt: row.accepted_at, updatedAt: row.updated_at,
          ...(row.execution_ref ? { executionRef: row.execution_ref } : {}),
          ...(row.message_id ? { messageId: row.message_id } : {}),
          ...(row.result_message_id ? { resultMessageId: row.result_message_id } : {}),
          ...(row.turn_id ? { turnId: row.turn_id } : {}), ...(row.outcome ? { outcome: row.outcome } : {}),
          ...(row.error ? { error: text(row.error, row.error_length) } : {}),
        };
        queueBytes += Buffer.byteLength(JSON.stringify(item));
        if (items.length >= MAX_REQUIRED_ROWS || usedBytes + queueBytes > maxBytes) throw new RuntimeSnapshotLimitError();
        items.push(item);
      };
      for (const row of activeInputs) addInput(row);
      if (interrupted) addInput(interrupted);
      if (dispatch || items.length) {
        const activeInput = items.find((item) => item.state === "claimed");
        const interruptedCount = db.query<{ count: number }, [string, string]>(`select count(*) as count from session_inputs
          where session_id = ? and outcome = 'interrupted'
          and settled_revision > coalesce((select max(settled_revision) from session_inputs where session_id = ? and outcome = 'completed'), 0)`)
          .get(sessionId, sessionId)?.count ?? 0;
        add("session.input_queue_changed", { sessionId, paused: dispatch?.paused === 1,
          revision: dispatch?.revision ?? 0, pendingCount: items.filter((item) => item.state === "pending").length,
          interruptedCount, ...(activeInput?.executionRef ? { executionRef: activeInput.executionRef } : {}), items,
        }, sessionId, Number(session.updated_at), (tip?.seq ?? 0) + 0.6);
      }
      if (db.query<{ found: number }, [string]>(`select 1 as found from events where session_id = ?
        and type in ('user_input.requested', 'user_input.resolved', 'user_input.cancelled')
        and length(cast(payload_json as blob)) > ${MAX_NATIVE_JSON_BYTES} limit 1`).get(sessionId)) throw new RuntimeSnapshotLimitError();
      const requests = queryRows<EventRow>(db, `select seq, id, type, time,
        length(cast(payload_json as blob)) > ${MAX_NATIVE_JSON_BYTES} as native_too_large,
        case when length(cast(payload_json as blob)) <= ${JSON_BYTES} then payload_json end as payload_json
        from events requested where session_id = ? and type = 'user_input.requested' and not exists (
          select 1 from events resolved where resolved.type in ('user_input.resolved','user_input.cancelled')
            and resolved.session_id = requested.session_id and resolved.seq > requested.seq
            and json_extract(resolved.payload_json, '$.inputId') = json_extract(requested.payload_json, '$.inputId'))
        order by seq limit ${MAX_REQUIRED_ROWS + 1}`, sessionId);
      let requestCount = 0;
      for (const request of requests) {
        if (++requestCount > MAX_REQUIRED_ROWS) throw new RuntimeSnapshotLimitError();
        seedEvent(request, sessionId);
      }
      if (session.status === "archived") add("session.archived", { sessionId }, sessionId, Number(session.updated_at), (tip?.seq ?? 0) + 0.5);
    }
    for (const item of history) for (const message of item.ids) readMessage(message, false);
    for (const [table, retained] of [["messages", messageIds.size], ["tool_calls", toolIds.size]] as const) {
      const total = db.query<{ count: number }, string[]>(`select count(*) as count from ${table} ${options.sessionId ? "where session_id = ?" : ""}`)
        .get(...(options.sessionId ? [options.sessionId] : []))?.count ?? 0;
      if (total > retained) markTruncated();
    }
    seeds.sort((a, b) => a.seq - b.seq || a.ordinal - b.ordinal);
    snapshot.events = seeds.map((seed) => seed.event);
    if (snapshot.truncated) snapshot.warning = "Recovery restored current durable state. Older history or large display content was truncated; temporary tool output cannot be replayed.";
    if (Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes) throw new RuntimeSnapshotLimitError();
    return snapshot;
  })();
}

function unicodePrefix(value: string, length: number): string {
  const prefix = value.slice(0, length);
  const last = prefix.charCodeAt(prefix.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix;
}

/** Bun iterators need explicit statement finalization when a budget breaks iteration early. */
function* queryRows<T>(db: Database, sql: string, ...bindings: Array<string | number | null>): Generator<T> {
  const statement = db.prepare<T, Array<string | number | null>>(sql);
  try {
    yield* statement.iterate(...bindings);
  } finally {
    statement.finalize();
  }
}
