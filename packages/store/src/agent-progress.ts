import type { Database } from "bun:sqlite";
import type { RuntimeAgentProgress, RuntimeInputOutcome } from "@chili/protocol";
import type { StoredContentCodec } from "./content-store.js";

type Receipt = { state: string; outcome: RuntimeInputOutcome | null; text: string; error: string | null; accepted_at: number; updated_at: number; result_message_id: string | null };
/** Bounded task metadata only. Listing Agents must never load their conversation pages or tool payloads. */
export function readAgentProgress(db: Database, content: StoredContentCodec, sessionId: string): RuntimeAgentProgress {
  return db.transaction(() => {
    const receipt = db.query<Receipt, [string]>(`select state, outcome, substr(text, 1, 2000) as text, substr(error, 1, 640) as error,
      accepted_at, updated_at, result_message_id from session_inputs where session_id = ? and parent_input_id is null
      and not (state = 'settled' and claim_id is null) order by case state when 'claimed' then 0 when 'pending' then 1 else 2 end, sequence desc limit 1`).get(sessionId);
    const paused = db.query<{ paused: number }, [string]>("select paused from session_dispatch where session_id = ?").get(sessionId)?.paused;
    const status = db.query<{ status: string; reason: string | null; time: number }, [string]>(`select json_extract(payload_json, '$.status') as status,
      substr(json_extract(payload_json, '$.reason'), 1, 640) as reason, time from events where session_id = ? and type = 'session.status_changed' order by seq desc limit 1`).get(sessionId);
    let state: RuntimeAgentProgress["state"] = paused ? "paused" : receipt?.state === "pending" ? "queued"
      : receipt?.state === "claimed" ? "running" : receipt?.outcome === "completed" ? "completed" : receipt?.outcome === "failed" ? "failed"
      : receipt?.outcome ? "stopped" : "waiting";
    if (state === "running" && status?.status === "waiting_for_approval") state = "attention";
    if (!receipt && status) {
      if (status.status === "failed") state = "failed";
      if (status.status === "cancelled") state = "stopped";
    }
    const first = db.query<{ text: string }, [string]>("select substr(text, 1, 2000) as text from session_inputs where session_id = ? order by sequence limit 1").get(sessionId);
    const result = receipt?.result_message_id ? db.query<{ text: string; content_version: number }, [string, string]>(`select
      substr(coalesce(json_extract(data_json, '$.displayText'), json_extract(data_json, '$.text')), 1, 2000) as text, content_version
      from message_parts where session_id = ? and message_id = ? and type = 'text'
      and coalesce(json_extract(data_json, '$.phase'), '') != 'commentary' order by ordinal limit 1`).get(sessionId, receipt.result_message_id) : undefined;
    const tool = state === "running" || state === "attention" ? db.query<{ tool_name: string; display_subject: string | null }, [string]>(
      "select tool_name, display_subject from tool_calls where session_id = ? and status in ('running', 'waiting_for_approval') order by started_at desc limit 1").get(sessionId) : undefined;
    if (tool?.tool_name === "request_user_input") state = "attention";
    const detail = state === "failed" ? receipt?.error ?? status?.reason : result?.text
      ? content.textChunk(result.content_version === 1 && result.text.startsWith('{"$chiliContent":') ? JSON.parse(result.text) : result.text, 0, 640, result.content_version === 1).text : undefined;
    return { state, ...(first ? { task: first.text } : {}), ...(detail ? { detail } : {}),
      ...(tool ? { action: tool.tool_name, ...(tool.display_subject ? { subject: tool.display_subject } : {}) } : {}),
      ...(receipt ? { startedAt: receipt.accepted_at, updatedAt: receipt.updated_at } : {}) };
  })();
}
