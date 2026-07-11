import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { SQLITE_JOURNAL_SIZE_LIMIT_BYTES, SQLITE_WAL_AUTO_CHECKPOINT_PAGES } from "./sqlite-event-store.js";

export interface SqliteEventStoreDiagnostics {
  path: string;
  files: {
    database: DiagnosticFile;
    wal: DiagnosticFile;
    shm: DiagnosticFile;
  };
  toolResultFiles: DiagnosticDirectory;
  configuredWal: {
    autoCheckpointPages: number;
    journalSizeLimitBytes: number;
  };
  pragmas: {
    journalMode: string;
    pageSize: number;
    pageCount: number;
    freelistCount: number;
  };
  events: {
    rows: number;
    totalPayloadBytes: number;
    byType: EventPayloadSummary[];
    bySession: SessionPayloadSummary[];
    largestPayloads: LargestEventPayload[];
  };
  messageParts: {
    rows: number;
    totalDataBytes: number;
    byType: MessagePartPayloadSummary[];
    toolResultsByTool: ToolOutputSummary[];
    largestParts: LargestMessagePartPayload[];
  };
  toolCalls: {
    rows: number;
    totalOutputBytes: number;
    byTool: ToolOutputSummary[];
    largestOutputs: LargestToolOutput[];
  };
}

export interface DiagnosticFile {
  path: string;
  exists: boolean;
  bytes: number;
}

export interface DiagnosticDirectory {
  path: string;
  exists: boolean;
  files: number;
  totalBytes: number;
  largestFiles: DiagnosticFile[];
}

export interface EventPayloadSummary {
  type: string;
  rows: number;
  payloadBytes: number;
}

export interface SessionPayloadSummary {
  sessionId: string | null;
  rows: number;
  payloadBytes: number;
}

export interface LargestEventPayload {
  id: string;
  type: string;
  sessionId: string | null;
  threadId: string | null;
  time: number;
  payloadBytes: number;
}

export interface MessagePartPayloadSummary {
  type: string;
  rows: number;
  dataBytes: number;
}

export interface LargestMessagePartPayload {
  id: string;
  messageId: string;
  sessionId: string;
  type: string;
  dataBytes: number;
}

export interface LargestToolOutput {
  id: string;
  sessionId: string | null;
  threadId: string | null;
  toolName: string;
  status: string;
  outputBytes: number;
}

export interface ToolOutputSummary {
  toolName: string;
  rows: number;
  outputBytes: number;
}

const TOP_ROWS_LIMIT = 10;

export async function inspectSqliteEventStore(path: string): Promise<SqliteEventStoreDiagnostics> {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    return {
      path,
      files: {
        database: await fileDiagnostic(path),
        wal: await fileDiagnostic(`${path}-wal`),
        shm: await fileDiagnostic(`${path}-shm`),
      },
      toolResultFiles: await directoryDiagnostic(join(dirname(path), "tool-results")),
      configuredWal: {
        autoCheckpointPages: SQLITE_WAL_AUTO_CHECKPOINT_PAGES,
        journalSizeLimitBytes: SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
      },
      pragmas: {
        journalMode: pragmaString(db, "journal_mode"),
        pageSize: pragmaNumber(db, "page_size"),
        pageCount: pragmaNumber(db, "page_count"),
        freelistCount: pragmaNumber(db, "freelist_count"),
      },
      events: {
        rows: scalarNumber(db, `select count(*) from events`),
        totalPayloadBytes: scalarNumber(db, `select coalesce(sum(length(cast(payload_json as blob))), 0) from events`),
        byType: db.query<EventPayloadSummary, [number]>(
          `select
             type,
             count(*) as rows,
             coalesce(sum(length(cast(payload_json as blob))), 0) as payloadBytes
           from events
           group by type
           order by payloadBytes desc, rows desc, type asc
           limit ?`,
        ).all(TOP_ROWS_LIMIT),
        bySession: db.query<SessionPayloadSummary, [number]>(
          `select
             session_id as sessionId,
             count(*) as rows,
             coalesce(sum(length(cast(payload_json as blob))), 0) as payloadBytes
           from events
           group by session_id
           order by payloadBytes desc, rows desc, session_id asc
           limit ?`,
        ).all(TOP_ROWS_LIMIT),
        largestPayloads: db.query<LargestEventPayload, [number]>(
          `select
             id,
             type,
             session_id as sessionId,
             thread_id as threadId,
             time,
             length(cast(payload_json as blob)) as payloadBytes
           from events
           order by payloadBytes desc, seq desc
           limit ?`,
        ).all(TOP_ROWS_LIMIT),
      },
      messageParts: {
        rows: scalarNumber(db, `select count(*) from message_parts`),
        totalDataBytes: scalarNumber(db, `select coalesce(sum(length(cast(data_json as blob))), 0) from message_parts`),
        byType: db.query<MessagePartPayloadSummary, [number]>(
          `select
             type,
             count(*) as rows,
             coalesce(sum(length(cast(data_json as blob))), 0) as dataBytes
           from message_parts
           group by type
           order by dataBytes desc, rows desc, type asc
           limit ?`,
        ).all(TOP_ROWS_LIMIT),
        toolResultsByTool: db.query<ToolOutputSummary, [number]>(
          `select
             coalesce(nullif(tc.tool_name, ''), '<unknown>') as toolName,
             count(*) as rows,
             coalesce(sum(length(cast(coalesce(json_extract(mp.data_json, '$.output'), '') as blob))), 0) as outputBytes
           from message_parts mp
           left join tool_calls tc on tc.id = json_extract(mp.data_json, '$.callId')
           where mp.type = 'tool_result'
           group by toolName
           order by outputBytes desc, rows desc, toolName asc
           limit ?`,
        ).all(TOP_ROWS_LIMIT),
        largestParts: db.query<LargestMessagePartPayload, [number]>(
          `select
             id,
             message_id as messageId,
             session_id as sessionId,
             type,
             length(cast(data_json as blob)) as dataBytes
           from message_parts
           order by dataBytes desc, ordinal desc
           limit ?`,
        ).all(TOP_ROWS_LIMIT),
      },
      toolCalls: {
        rows: scalarNumber(db, `select count(*) from tool_calls`),
        totalOutputBytes: scalarNumber(db, `select coalesce(sum(length(cast(output as blob))), 0) from tool_calls where output is not null`),
        byTool: db.query<ToolOutputSummary, [number]>(
          `select
             tool_name as toolName,
             count(*) as rows,
             coalesce(sum(length(cast(output as blob))), 0) as outputBytes
           from tool_calls
           group by tool_name
           order by outputBytes desc, rows desc, tool_name asc
           limit ?`,
        ).all(TOP_ROWS_LIMIT),
        largestOutputs: db.query<LargestToolOutput, [number]>(
          `select
             id,
             session_id as sessionId,
             thread_id as threadId,
             tool_name as toolName,
             status,
             coalesce(length(cast(output as blob)), 0) as outputBytes
           from tool_calls
           order by outputBytes desc, updated_at desc
           limit ?`,
        ).all(TOP_ROWS_LIMIT),
      },
    };
  } finally {
    db.close();
  }
}

async function fileDiagnostic(path: string): Promise<DiagnosticFile> {
  const result = await stat(path).catch(() => undefined);
  return {
    path,
    exists: result !== undefined,
    bytes: result?.size ?? 0,
  };
}

async function directoryDiagnostic(path: string): Promise<DiagnosticDirectory> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
  if (!entries) {
    return {
      path,
      exists: false,
      files: 0,
      totalBytes: 0,
      largestFiles: [],
    };
  }

  const files = (await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => fileDiagnostic(join(path, entry.name))),
  )).filter((file) => file.exists);
  files.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));

  return {
    path,
    exists: true,
    files: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    largestFiles: files.slice(0, TOP_ROWS_LIMIT),
  };
}

function pragmaNumber(db: Database, name: string): number {
  return Number(pragmaValue(db, name));
}

function pragmaString(db: Database, name: string): string {
  return String(pragmaValue(db, name));
}

function pragmaValue(db: Database, name: string): unknown {
  const row = db.query<Record<string, unknown>, []>(`pragma ${name}`).get();
  const value = row ? Object.values(row)[0] : undefined;
  if (value === undefined) throw new Error(`Missing PRAGMA value: ${name}`);
  return value;
}

function scalarNumber(db: Database, sql: string): number {
  const row = db.query<Record<string, unknown>, []>(sql).get();
  const value = row ? Object.values(row)[0] : undefined;
  return Number(value ?? 0);
}
