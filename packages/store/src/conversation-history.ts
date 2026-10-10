import type { Database } from "bun:sqlite";
import type { ConversationPage, HistoryMessage, HistoryContent, HistoryToolPage, HistoryPart, MessageRole } from "@chili/protocol";
import type { StoredContentCodec } from "./content-store.js";

export interface ConversationQuery { sessionId: string; beforeMessageId?: string; limit?: number; }
export interface HistoryMessageQuery { sessionId: string; messageId: string; partOffset?: number; }
export interface HistoryContentQuery { sessionId: string; kind: "part" | "tool"; id: string; field: HistoryContent["field"]; offset?: number; }
export interface HistoryToolsQuery { sessionId: string; parentCallId: string; afterToolId?: string; }
type MessageRow = { id: string; session_id: string; role: MessageRole; created_at: number; turn_id: string | null; created_event_seq: number };
type PartRow = { id: string; type: string; data_json: string; content_version: number; delta_event_seq: number };

/** Page the materialized message index, never the size-dependent event replay window. */
export class ConversationHistoryReader {
  constructor(private readonly db: Database, private readonly content: StoredContentCodec) {}

  page(query: ConversationQuery): ConversationPage {
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    return this.db.transaction(() => {
      const cursor = query.beforeMessageId ? this.messageRow(query.sessionId, query.beforeMessageId) : undefined;
      const rows = this.db.query<MessageRow, (string | number)[]>(`select * from messages where session_id = ?
        ${cursor ? "and (created_event_seq, created_at, id) < (?, ?, ?)" : ""}
        order by created_event_seq desc, created_at desc, id desc limit ?`)
        .all(query.sessionId, ...(cursor ? [cursor.created_event_seq, cursor.created_at, cursor.id] : []), limit + 1);
      const chosen = rows.slice(0, limit).reverse();
      return { sessionId: query.sessionId, messages: chosen.map((row) => this.message(row)),
        ...(rows.length > limit && chosen[0] ? { nextBeforeMessageId: chosen[0].id } : {}) };
    })();
  }

  messagePage(query: HistoryMessageQuery): HistoryMessage {
    return this.db.transaction(() => this.message(this.messageRow(query.sessionId, query.messageId), query.partOffset ?? 0))();
  }

  async read(query: HistoryContentQuery): Promise<HistoryContent> {
    const offset = query.offset ?? 0;
    let chunk: { text: string; nextOffset?: number };
    if (query.kind === "part") {
      if (query.field !== "text") throw new Error("Message parts expose display text only");
      const row = this.db.query<PartRow, [string, string]>("select id, type, data_json, content_version, delta_event_seq from message_parts where session_id = ? and id = ?").get(query.sessionId, query.id);
      if (!row) throw new Error("Unknown history part");
      chunk = this.partChunk(query.sessionId, row, offset, 32768);
    } else {
      if (query.field === "text") throw new Error("Invalid tool content field");
      const row = this.db.query<{ input_json: string | null; input_content_version: number; output: string | null; error: string | null; output_content_version: number }, [string, string]>(
        "select input_json, input_content_version, output, error, output_content_version from tool_calls where session_id = ? and id = ?").get(query.sessionId, query.id);
      if (!row) throw new Error("Unknown history tool");
      if (query.field === "input") {
        const stored: unknown = JSON.parse(row.input_json ?? "null");
        chunk = await this.content.jsonTextChunk(stored, offset, row.input_content_version === 1);
      } else chunk = row.output_content_version === 1 ? this.content.storedTextChunk(row[query.field] ?? "", offset) : this.content.textChunk(row[query.field] ?? "", offset);
    }
    return { sessionId: query.sessionId, id: query.id, field: query.field, offset, ...chunk };
  }

  tools(query: HistoryToolsQuery): HistoryToolPage {
    if (!this.db.query("select 1 from tool_calls where session_id = ? and id = ?").get(query.sessionId, query.parentCallId)) throw new Error("Unknown parent tool");
    let cursor = 0;
    if (query.afterToolId) {
      const row = this.db.query<{ rowid: number }, [string, string, string]>("select rowid from tool_calls where session_id = ? and parent_call_id = ? and id = ?")
        .get(query.sessionId, query.parentCallId, query.afterToolId);
      if (!row) throw new Error("Unknown tool cursor");
      cursor = row.rowid;
    }
    const rows = this.db.query<{ id: string; tool_name: string; status: string; started_at: number; updated_at: number }, [string, string, number]>(
      "select id, tool_name, status, started_at, updated_at from tool_calls where session_id = ? and parent_call_id = ? and rowid > ? order by rowid limit 51")
      .all(query.sessionId, query.parentCallId, cursor);
    const tools = rows.slice(0, 50).map((row) => ({ id: row.id, name: row.tool_name, status: row.status, startedAt: row.started_at, updatedAt: row.updated_at }));
    return { sessionId: query.sessionId, parentCallId: query.parentCallId, tools,
      ...(rows.length > 50 ? { nextAfterToolId: tools.at(-1)!.id } : {}) };
  }

  private messageRow(sessionId: string, id: string): MessageRow {
    const row = this.db.query<MessageRow, [string, string]>("select * from messages where session_id = ? and id = ?").get(sessionId, id);
    if (!row) throw new Error("Unknown message cursor");
    return row;
  }

  private partChunk(sessionId: string, part: PartRow, offset: number, limit: number): { text: string; nextOffset?: number } {
    const stored = JSON.parse(part.data_json) as Record<string, unknown>;
    // Never hydrate opaque provider state, image bytes, or structured tool results.
    const field = stored.displayText !== undefined ? "displayText" : stored.text !== undefined ? "text" : "summary";
    const value = stored[field] ?? "";
    const baseBytes = this.content.displayTextBytes(value, part.content_version === 1);
    const deltas = field === "text" && (part.type === "text" || part.type === "reasoning")
      ? this.db.query<{ seq: number; bytes: number }, [string, string, number]>(`select seq,
          length(cast(json_extract(payload_json, '$.delta') as blob)) as bytes from events
          where session_id = ? and type = 'message.part_delta' and json_extract(payload_json, '$.partId') = ?
          and seq > ? and json_extract(payload_json, '$.field') = 'text'
          and json_type(payload_json, '$.delta') = 'text' order by seq`).all(sessionId, part.id, part.delta_event_seq)
      : [];
    const total = baseBytes + deltas.reduce((sum, delta) => sum + delta.bytes, 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new RangeError("Invalid content offset");
    if (offset === total) return { text: "" };
    if (limit < 4) return { text: "", nextOffset: offset };
    let text = "";
    let position = offset;
    let remaining = limit;
    if (position < baseBytes) {
      const chunk = this.content.textChunk(value, position, remaining, part.content_version === 1);
      text = chunk.text;
      const bytes = Buffer.byteLength(text);
      position += bytes; remaining -= bytes;
      if (chunk.nextOffset !== undefined) return { text, nextOffset: position };
    }
    let start = baseBytes;
    for (const delta of deltas) {
      if (remaining < 4) break;
      if (position >= start + delta.bytes) { start += delta.bytes; continue; }
      const row = this.db.query<{ bytes: Uint8Array }, [number, number, number]>(
        "select substr(cast(json_extract(payload_json, '$.delta') as blob), ?, ?) as bytes from events where seq = ?")
        .get(position - start + 1, remaining + 4, delta.seq)!;
      const bytes = Buffer.from(row.bytes);
      if ((bytes[0]! & 0xc0) === 0x80) throw new RangeError("Content cursor is inside a UTF-8 character");
      let end = Math.min(remaining, bytes.length);
      while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
      text += bytes.subarray(0, end).toString("utf8");
      position += end; remaining -= end;
      if (position < start + delta.bytes) break;
      start += delta.bytes;
    }
    return { text, ...(position < total ? { nextOffset: position } : {}) };
  }

  private message(row: MessageRow, offset = 0): HistoryMessage {
    // Project legacy inline rows inside SQLite too: image/provider/tool bodies
    // must not be transferred or JSON-decoded merely to list a message.
    const fields = ["text", "displayText", "summary"].map((field) => `'${field}', case when json_type(data_json, '$.${field}') = 'text'
      then substr(json_extract(data_json, '$.${field}'), 1, 8004) else json_extract(data_json, '$.${field}') end`);
    fields.push(...["callId", "toolName", "status", "completion", "filename", "mimeType"].map((field) => `'${field}', json_extract(data_json, '$.${field}')`));
    const rows = this.db.query<PartRow, [string, number]>(`select id, type,
      json_patch('{}', json_object(${fields.join(",")})) as data_json, content_version, delta_event_seq
      from message_parts where message_id = ? order by ordinal, id limit 33 offset ?`).all(row.id, offset);
    let remaining = 8000;
    const parts = rows.slice(0, 32).map((part): HistoryPart => {
      const stored = JSON.parse(part.data_json) as Record<string, unknown>;
      if (part.type === "tool_call" || part.type === "tool_result") {
        const callId = String(stored.callId);
        const tool = this.db.query<{ tool_name: string; status: string }, [string, string]>("select tool_name, status from tool_calls where session_id = ? and id = ?").get(row.session_id, callId);
        let delivery = "";
        if (tool?.tool_name === "present_file" && tool.status === "completed") {
          const result = this.db.query<{ output: string | null; output_content_version: number }, [string, string]>("select output, output_content_version from tool_calls where session_id = ? and id = ?").get(row.session_id, callId);
          if (result?.output) {
            const storedOutput: unknown = result.output_content_version === 1 ? JSON.parse(result.output) : result.output;
            const output = result.output_content_version === 1 ? this.content.resolveBounded(storedOutput, 4000) : storedOutput;
            if (typeof output === "string" && Buffer.byteLength(output) <= Math.min(4000, remaining)) delivery = output;
          }
        }
        remaining -= Buffer.byteLength(delivery);
        return { id: part.id, type: part.type, text: delivery, hasMore: true, callId,
          toolName: tool?.tool_name ?? String(stored.toolName ?? "tool"), status: tool?.status ?? String(stored.status ?? "completed") };
      }
      const chunk = this.partChunk(row.session_id, part, 0, remaining);
      remaining -= Buffer.byteLength(chunk.text);
      return { id: part.id, type: part.type, text: chunk.text, hasMore: chunk.nextOffset !== undefined,
        ...(["completed", "cancelled", "failed"].includes(String(stored.completion)) ? { completion: stored.completion as NonNullable<HistoryPart["completion"]> } : {}),
        ...(typeof stored.filename === "string" && stored.filename ? { filename: stored.filename.slice(0, 512) } : {}),
        ...(typeof stored.mimeType === "string" && stored.mimeType ? { mimeType: stored.mimeType.slice(0, 512) } : {}) };
    });
    return { id: row.id, sessionId: row.session_id, role: row.role, createdAt: row.created_at,
      ...(row.turn_id ? { turnId: row.turn_id } : {}), parts,
      ...(rows.length > 32 ? { nextPartOffset: offset + 32 } : {}) };
  }
}
