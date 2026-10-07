import type { Database } from "bun:sqlite";
import type {
  RuntimeEvent, MessageId, PartId, RuntimeInputMode, RuntimeInputOutcome,
  RuntimeInputQueue, RuntimeSessionInput, SessionId, TimestampMs, TurnId,
  MessageImageContent,
} from "@chili/protocol";
import type { SessionRunClaimFence } from "./types.js";
import type { StoredContentCodec } from "./content-store.js";

export interface StoredSessionInput extends RuntimeSessionInput {
  payload: string;
  claimId?: string;
  source: string;
  identity: string;
  /** This input was explicitly resumed after an interrupted or unsuccessful execution. */
  resumed: boolean;
}

export interface SessionInputMutationOptions {
  /** Trusted runtime option, never accepted from the input payload. */
  sessionAccess?: "root" | "child";
}

export type SessionInputAccept = { kind: "accept"; sessionId: SessionId; submissionId: string; inputId: string; mode: RuntimeInputMode; payload: string; text: string; source: string; identity?: string };

export type SessionInputMutation =
  | SessionInputAccept
  | { kind: "claim"; sessionId: SessionId; claimId: string; executionRef: string; leaseDurationMs: number }
  | { kind: "promote"; sessionId: SessionId; inputId: string; claimId: string; text: string; displayText?: string; images?: readonly MessageImageContent[] }
  | { kind: "settle"; sessionId: SessionId; inputId: string; claimId: string; outcome: RuntimeInputOutcome; error?: string; resultMessageId?: MessageId }
  | { kind: "pause"; sessionId: SessionId }
  | { kind: "resume"; sessionId: SessionId; expectedRevision?: number; inputId?: string; expectedInputRevision?: number }
  | { kind: "recover"; sessionId: SessionId }
  | { kind: "cancel"; sessionId: SessionId; inputId: string; expectedRevision: number }
  | { kind: "cancel-source"; sessionId: SessionId; source: string };

export interface SessionInputMutationResult {
  input?: StoredSessionInput;
  queue: RuntimeInputQueue;
  events: RuntimeEvent[];
  duplicate?: boolean;
}

export interface SessionInputStore {
  supportsSessionInputs?(): boolean;
  sessionInputQueue(sessionId: SessionId): RuntimeInputQueue;
  sessionInput(sessionId: SessionId, submissionId: string): StoredSessionInput | undefined;
  sessionInputById(sessionId: SessionId, inputId: string): StoredSessionInput | undefined;
  mutateSessionInputs(input: SessionInputMutation, options?: SessionInputMutationOptions): SessionInputMutationResult;
}

export class SessionInputConflictError extends Error {
  override readonly name = "SessionInputConflictError";
}

interface InputRow {
  sequence: number; input_id: string; submission_id: string; session_id: string;
  mode: RuntimeInputMode; state: RuntimeSessionInput["state"]; revision: number;
  payload: string; identity: string; content_version: number; text: string; source: string;
  accepted_at: number; updated_at: number; claim_id: string | null;
  execution_ref: string | null; message_id: string | null; turn_id: string | null;
  outcome: RuntimeInputOutcome | null; error: string | null;
  result_message_id: string | null; resumed: number;
}

interface InputRepositoryOptions {
  content?: Pick<StoredContentCodec, "storeText" | "readText" | "textBytes">;
  commit(events: readonly RuntimeEvent[], fence?: SessionRunClaimFence): void;
  claim(input: { sessionId: SessionId; claimId: string; sessionAccess: "root" | "child"; time: number; leaseDurationMs: number }): { status: string };
  forgetClaim(sessionId: SessionId, claimId: string): void;
  assertSession(sessionId: SessionId, options: SessionInputMutationOptions): void;
  retry<T>(operation: () => T): T;
}

/** Persists input receipts and queue state. RuntimeService owns dispatch and execution. */
export class SessionInputRepository {
  constructor(private readonly db: Database, private readonly options: InputRepositoryOptions) {}

  get(sessionId: SessionId, submissionId: string): StoredSessionInput | undefined {
    const row = this.db.query<InputRow, [string, string]>(
      "select * from session_inputs where session_id = ? and submission_id = ?",
    ).get(sessionId, submissionId);
    return row ? storedInput(row, this.options.content) : undefined;
  }

  getById(sessionId: SessionId, inputId: string): StoredSessionInput | undefined {
    const row = this.db.query<InputRow, [string, string]>(
      "select * from session_inputs where session_id = ? and input_id = ?",
    ).get(sessionId, inputId);
    return row ? storedInput(row, this.options.content) : undefined;
  }

  queue(sessionId: SessionId): RuntimeInputQueue {
    return this.db.transaction(() => this.readQueue(sessionId))();
  }

  private readQueue(sessionId: SessionId): RuntimeInputQueue {
    const state = this.db.query<{ paused: number; revision: number }, [string]>(
      "select paused, revision from session_dispatch where session_id = ?",
    ).get(sessionId);
    const rows = this.db.query<InputRow, [string]>(
      "select * from session_inputs where session_id = ? and state != 'settled' order by resumed desc, case mode when 'steer' then 0 else 1 end, sequence",
    ).all(sessionId);
    // Steer can finish newer submissions before older queued work. Recovery
    // follows settlement revisions, not the admission sequence.
    const interrupted = this.db.query<InputRow, [string, string]>(
      "select * from session_inputs where session_id = ? and state = 'settled' and outcome != 'completed' and claim_id is not null and settled_revision > coalesce((select max(settled_revision) from session_inputs where session_id = ? and outcome = 'completed'), 0) order by settled_revision desc limit 1",
    ).get(sessionId, sessionId);
    const count = this.db.query<{ count: number }, [string, string]>(
      "select count(*) as count from session_inputs where session_id = ? and outcome = 'interrupted' and settled_revision > coalesce((select max(settled_revision) from session_inputs where session_id = ? and outcome = 'completed'), 0)",
    ).get(sessionId, sessionId)?.count ?? 0;
    const active = rows.find((row) => row.state === "claimed");
    return {
      sessionId, paused: state?.paused === 1, revision: state?.revision ?? 0,
      pendingCount: rows.filter((row) => row.state === "pending").length,
      interruptedCount: count,
      ...(active?.execution_ref ? { executionRef: active.execution_ref } : {}),
      items: [...rows, ...(interrupted ? [interrupted] : [])].map(publicInput),
    };
  }

  mutate(command: SessionInputMutation, options: SessionInputMutationOptions = {}): SessionInputMutationResult {
    const time = Date.now();
    let claimed = false;
    const transact = this.db.transaction((): SessionInputMutationResult => {
      const { sessionId } = command;
      this.options.assertSession(sessionId, options);
      let input: StoredSessionInput | undefined;
      let changed = false;
      let fence: SessionRunClaimFence | undefined;
      const events: RuntimeEvent[] = [];
      if (command.kind === "accept") {
        const existing = this.db.query<InputRow, [string, string]>(
          "select * from session_inputs where session_id = ? and submission_id = ?",
        ).get(sessionId, command.submissionId);
        if (existing) {
          const identity = existing.content_version === 1 ? this.options.content?.readText(existing.identity) ?? existing.identity : existing.identity;
          if (identity !== (command.identity ?? command.payload) || existing.mode !== command.mode || existing.source !== command.source) {
            throw new SessionInputConflictError("Submission ID already belongs to different input or delivery mode");
          }
          return { input: storedInput(existing, this.options.content), queue: this.queue(sessionId), events, duplicate: true };
        }
        const queue = this.queue(sessionId);
        const revoked = this.db.query<{ found: number }, [string, string]>("select 1 as found from session_input_revocations where session_id = ? and source = ?").get(sessionId, command.source);
        if (revoked) throw new SessionInputConflictError("Input authorization was revoked");
        const activeClaim = this.db.query<{ found: number }, [string, number]>(
          "select 1 as found from session_run_claims where session_id = ? and lease_expires_at > ?",
        ).get(sessionId, time);
        if (command.mode === "start" && (activeClaim || queue.pendingCount > 0 || queue.items.some((item) => item.state === "claimed"))) {
          throw new SessionInputConflictError("Session is busy or paused; enqueue input or explicitly resume it");
        }
        const pending = this.db.query<{ payload: string; content_version: number }, []>(
          "select payload, content_version from session_inputs where state = 'pending'",
        ).all();
        const pendingBytes = pending.reduce((bytes, row) => bytes + (row.content_version === 1
          ? this.options.content?.textBytes(row.payload) ?? Buffer.byteLength(row.payload)
          : Buffer.byteLength(row.payload)), 0);
        if (queue.pendingCount >= 128 || pending.length >= 4096 || pendingBytes + Buffer.byteLength(command.payload) > 64 * 1024 * 1024) {
          throw new SessionInputConflictError("Pending input capacity exceeded");
        }
        if (Buffer.byteLength(command.payload) > 16 * 1024 * 1024) throw new Error("Input exceeds 16 MiB");
        const payload = this.options.content?.storeText(command.payload, sessionId) ?? command.payload;
        const identity = command.identity === undefined || command.identity === command.payload
          ? payload
          : this.options.content?.storeText(command.identity, sessionId) ?? command.identity;
        this.db.query("insert or ignore into session_dispatch(session_id) values (?)").run(sessionId);
        // A deliberate fresh start can begin an idle session. It cannot resume
        // older queued work implicitly: pending inputs were rejected above.
        if (command.mode === "start") this.db.query("update session_dispatch set paused = 0 where session_id = ?").run(sessionId);
        this.db.query(`insert into session_inputs(input_id, submission_id, session_id, mode, state, payload, identity, content_version, text, source, accepted_at, updated_at)
          values (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`).run(
          command.inputId, command.submissionId, sessionId, command.mode, payload,
          identity, this.options.content ? 1 : 0, command.text.slice(0, 2000), command.source, time, time,
        );
        input = this.get(sessionId, command.submissionId);
        changed = true;
      } else if (command.kind === "claim") {
        if (this.queue(sessionId).paused) return { queue: this.queue(sessionId), events };
        const orphan = this.db.query<{ found: number }, [string, number]>(`select 1 as found from session_inputs i where i.session_id = ? and i.state = 'claimed'
          and not exists(select 1 from session_run_claims r where r.session_id = i.session_id and r.claim_id = i.claim_id and r.lease_expires_at > ?) limit 1`).get(sessionId, time);
        if (orphan) return this.mutate({ kind: "recover", sessionId }, options);
        // Finish the explicitly resumed execution before later queue/steer
        // inputs. Once it settles, ordinary steer/FIFO ordering applies again.
        const row = this.db.query<InputRow, [string]>(`select * from session_inputs where session_id = ? and state = 'pending'
          order by resumed desc, case mode when 'steer' then 0 else 1 end, sequence limit 1`).get(sessionId);
        if (!row) return { queue: this.queue(sessionId), events };
        const result = this.options.claim({ sessionId, claimId: command.claimId, sessionAccess: options.sessionAccess ?? "root", time, leaseDurationMs: command.leaseDurationMs });
        if (result.status !== "claimed") return { queue: this.queue(sessionId), events };
        claimed = true;
        fence = { sessionId, claimId: command.claimId };
        this.db.query(`update session_inputs set state = 'claimed', revision = revision + 1, updated_at = ?, claim_id = ?, execution_ref = ?, message_id = ?, turn_id = ? where input_id = ?`).run(
          time, command.claimId, command.executionRef, `msg_input_${row.input_id}`, row.turn_id ? `turn_input_${row.input_id}_${row.revision}` : `turn_input_${row.input_id}`, row.input_id,
        );
        input = this.get(sessionId, row.submission_id);
        changed = true;
      } else if (command.kind === "promote" || command.kind === "settle") {
        const row = this.db.query<InputRow, [string, string]>("select * from session_inputs where session_id = ? and input_id = ?").get(sessionId, command.inputId);
        if (!row || row.state !== "claimed" || row.claim_id !== command.claimId) throw new SessionInputConflictError("Input execution no longer owns its claim");
        fence = { sessionId, claimId: command.claimId };
        if (command.kind === "promote") {
          const found = this.db.query<{ found: number }, [string]>("select 1 as found from messages where id = ?").get(row.message_id!);
          if (!found) {
            const messageId = row.message_id as MessageId;
            const turnId = row.turn_id as TurnId;
            const envelope = { time: time as TimestampMs, sessionId };
            events.push({ ...envelope, id: crypto.randomUUID(), type: "message.created", payload: { messageId, turnId, role: "user" } });
            if (command.text.length || !command.images?.length) {
              events.push({ ...envelope, id: crypto.randomUUID(), type: "message.part_added", payload: { messageId, part: {
                id: `part_${row.input_id}_text` as PartId, messageId, sessionId, type: "text", text: command.text,
                ...(command.displayText ? { displayText: command.displayText } : {}),
              } } });
            }
            for (const [index, image] of (command.images ?? []).entries()) {
              events.push({ ...envelope, id: crypto.randomUUID(), type: "message.part_added", payload: { messageId, part: {
                ...image, id: `part_${row.input_id}_image_${index}` as PartId, messageId, sessionId, type: "image",
              } } });
            }
            changed = true;
          }
        } else {
          if (command.resultMessageId) {
            // The receipt points at this execution's response, never a later
            // Session response or an earlier run's last assistant message.
            const result = this.db.query<{ found: number }, [string, string, string, string, number]>(`select 1 as found from messages m
              where m.id = ? and m.session_id = ? and m.role = 'assistant'
              and m.created_event_seq > (select min(e.seq) from events e, json_each(e.payload_json, '$.items') item
                where e.type = 'session.input_queue_changed' and e.session_id = m.session_id
                and json_extract(item.value, '$.inputId') = ? and json_extract(item.value, '$.executionRef') = ?
                and json_extract(item.value, '$.state') = 'claimed'
                and json_extract(item.value, '$.revision') = ?)`).get(command.resultMessageId, sessionId, row.input_id, row.execution_ref!, row.revision);
            if (!result) throw new SessionInputConflictError("Result message does not belong to this input execution");
          }
          this.db.query("update session_inputs set state = 'settled', outcome = ?, error = ?, result_message_id = ?, revision = revision + 1, updated_at = ?, settled_revision = (select revision + 1 from session_dispatch where session_id = session_inputs.session_id) where input_id = ?").run(
            command.outcome, command.error?.slice(0, 2000) ?? null, command.resultMessageId ?? null, time, row.input_id,
          );
          changed = true;
        }
        input = this.get(sessionId, row.submission_id);
      } else if (command.kind === "pause" || command.kind === "resume") {
        if (command.kind === "resume" && command.expectedRevision !== undefined && this.queue(sessionId).revision !== command.expectedRevision) {
          throw new SessionInputConflictError("Input queue changed; refresh before resuming");
        }
        if (command.kind === "resume" && command.inputId !== undefined) {
          const row = this.getById(sessionId, command.inputId);
          if (!row || row.state !== "settled" || row.outcome === "completed"
            || (command.expectedInputRevision !== undefined && row.revision !== command.expectedInputRevision)) {
            throw new SessionInputConflictError("Input changed or cannot be resumed");
          }
          const revoked = this.db.query<{ found: number }, [string, string]>("select 1 as found from session_input_revocations where session_id = ? and source = ?").get(sessionId, row.source);
          if (revoked) throw new SessionInputConflictError("Input authorization was revoked");
          this.db.query("update session_inputs set state = 'pending', outcome = null, error = null, result_message_id = null, claim_id = null, execution_ref = null, resumed = 1, revision = revision + 1, updated_at = ? where input_id = ?").run(time, row.inputId);
          input = this.getById(sessionId, row.inputId);
          changed = true;
        }
        const paused = command.kind === "pause" ? 1 : 0;
        this.db.query("insert or ignore into session_dispatch(session_id) values (?)").run(sessionId);
        changed = this.db.query("update session_dispatch set paused = ? where session_id = ? and (paused != ? or ? = 1)").run(paused, sessionId, paused, paused).changes > 0 || changed;
      } else if (command.kind === "recover") {
        const live = this.db.query<{ found: number }, [string, number]>("select 1 as found from session_run_claims where session_id = ? and lease_expires_at > ?").get(sessionId, time);
        if (!live && this.queue(sessionId).items.some((item) => item.state !== "settled")) {
          const recovered = this.db.query(`update session_inputs set state = 'settled', outcome = 'interrupted', error = 'Execution was interrupted. Check the workspace before continuing; tool effects may already exist.', revision = revision + 1, updated_at = ?, settled_revision = (select revision + 1 from session_dispatch where session_id = session_inputs.session_id) where session_id = ? and state = 'claimed'`).run(time, sessionId);
          const paused = this.db.query("update session_dispatch set paused = 1 where session_id = ? and paused = 0").run(sessionId);
          changed = recovered.changes > 0 || paused.changes > 0;
          if (recovered.changes > 0) {
            const latestTurn = this.db.query<{ turn_id: string }, [string]>(`select json_extract(payload_json, '$.turnId') as turn_id from events
              where session_id = ? and type = 'turn.started' order by seq desc limit 1`).get(sessionId);
            const finished = latestTurn && this.db.query<{ found: number }, [string, string]>(`select 1 as found from events
              where session_id = ? and type = 'turn.completed' and json_extract(payload_json, '$.turnId') = ? limit 1`).get(sessionId, latestTurn.turn_id);
            if (latestTurn && !finished) events.push({ id: crypto.randomUUID(), type: "turn.completed", sessionId, time: time as TimestampMs,
              payload: { turnId: latestTurn.turn_id as TurnId, status: "failed" } });
            events.push({ id: crypto.randomUUID(), type: "session.status_changed", sessionId, time: time as TimestampMs,
              payload: { sessionId, status: "failed", reason: "input_execution_interrupted" } });
            const tools = this.db.query<{ id: string }, [string]>("select id from tool_calls where session_id = ? and status in ('pending', 'running', 'waiting_for_approval')").all(sessionId);
            for (const tool of tools) events.push({ id: crypto.randomUUID(), type: "tool.call_finished", sessionId, time: time as TimestampMs, payload: {
              callId: tool.id as import("@chili/protocol").ToolCallId, status: "failed", synthetic: true,
              error: "Execution interrupted; the external outcome is unknown. Inspect current state before retrying this operation.",
            } });
          }
          const remote = this.db.query(`update session_inputs set state = 'settled', outcome = 'cancelled', error = 'Remote authorization must be renewed after runtime recovery', revision = revision + 1, updated_at = ? where session_id = ? and state = 'pending' and source like 'remote:%'`).run(time, sessionId);
          changed ||= remote.changes > 0;
        }
      } else {
        if (command.kind === "cancel-source") {
          this.db.query("insert or ignore into session_input_revocations(session_id, source) values (?, ?)").run(sessionId, command.source);
        }
        const result = command.kind === "cancel"
          ? this.db.query("update session_inputs set state = 'settled', outcome = 'cancelled', revision = revision + 1, updated_at = ? where session_id = ? and input_id = ? and state = 'pending' and revision = ?").run(time, sessionId, command.inputId, command.expectedRevision)
          : this.db.query("update session_inputs set state = 'settled', outcome = 'cancelled', revision = revision + 1, updated_at = ? where session_id = ? and source = ? and state = 'pending'").run(time, sessionId, command.source);
        changed = result.changes > 0;
        if (command.kind === "cancel" && !changed) throw new SessionInputConflictError("Queued input changed or has already started");
      }
      if (changed) {
        this.db.query("update session_dispatch set revision = revision + 1 where session_id = ?").run(sessionId);
        events.push({ id: crypto.randomUUID(), type: "session.input_queue_changed", sessionId, time: time as TimestampMs, payload: this.queue(sessionId) });
      }
      this.options.commit(events, fence);
      return { ...(input ? { input } : {}), queue: this.queue(sessionId), events };
    });
    return this.options.retry(() => {
      claimed = false;
      try { return transact.immediate(); } catch (error) {
        if (claimed && command.kind === "claim") this.options.forgetClaim(command.sessionId, command.claimId);
        throw error;
      }
    });
  }
}

function publicInput(row: InputRow): RuntimeSessionInput {
  return {
    inputId: row.input_id, submissionId: row.submission_id, sessionId: row.session_id as SessionId,
    mode: row.mode, state: row.state, revision: row.revision, sequence: row.sequence,
    text: row.text.slice(0, 2000), acceptedAt: row.accepted_at, updatedAt: row.updated_at,
    ...(row.execution_ref ? { executionRef: row.execution_ref } : {}),
    ...(row.message_id ? { messageId: row.message_id as MessageId } : {}),
    ...(row.turn_id ? { turnId: row.turn_id as TurnId } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}), ...(row.error ? { error: row.error } : {}),
    ...(row.result_message_id ? { resultMessageId: row.result_message_id as MessageId } : {}),
  };
}

function storedInput(row: InputRow, content?: Pick<StoredContentCodec, "storeText" | "readText" | "textBytes">): StoredSessionInput {
  const storedContent = row.content_version === 1 ? content : undefined;
  return { ...publicInput(row), payload: storedContent?.readText(row.payload) ?? row.payload, identity: storedContent?.readText(row.identity) ?? row.identity, source: row.source, resumed: row.resumed === 1, ...(row.claim_id ? { claimId: row.claim_id } : {}) };
}
