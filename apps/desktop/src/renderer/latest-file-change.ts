import type { ChiliRuntimeView, RuntimeAgentRecord } from "@chili/sdk";
import type { RuntimeSnapshot } from "../shared/contracts.js";

export interface FileChangeTarget {
  sessionId: string;
  turnId: string;
}

type FileChangeSnapshot = Pick<RuntimeSnapshot, "sessionId" | "events" | "agents">;
type FileChangeRuntime = Pick<ChiliRuntimeView, "toolCalls">;
interface FileCall {
  sessionId: string;
  turnId?: string;
  toolName?: string;
  status?: string;
  error?: string;
  synthetic?: boolean;
  time: number;
  order?: number;
}
interface Candidate extends FileChangeTarget {
  time: number;
  order?: number;
  snapshot: boolean;
}

const FILE_WRITERS = new Set(["write", "write_file", "edit", "replace", "apply_patch"]);

/** Locate the last file-changing operation, not a later text-only answer turn. */
export function latestFileChange(
  snapshot: FileChangeSnapshot | undefined,
  runtime?: FileChangeRuntime,
): FileChangeTarget | undefined {
  if (!snapshot?.sessionId) return undefined;
  const allowed = descendantSessions(snapshot.sessionId, snapshot.agents);
  const calls = new Map<string, FileCall>();
  for (const call of Object.values(runtime?.toolCalls ?? {})) {
    if (!call.sessionId || !allowed.has(call.sessionId)) continue;
    calls.set(callKey(call.sessionId, call.id), {
      sessionId: call.sessionId, time: call.updatedAt, status: call.status, toolName: call.toolName,
      ...(call.turnId ? { turnId: call.turnId } : {}),
      ...(call.error ? { error: call.error } : {}),
      ...(call.synthetic ? { synthetic: true } : {}),
    });
  }
  for (const [order, event] of snapshot.events.entries()) {
    if (!event.sessionId || !allowed.has(event.sessionId)) continue;
    if (event.type !== "tool.call_started" && event.type !== "tool.call_updated" && event.type !== "tool.call_finished") continue;
    const key = callKey(event.sessionId, event.payload.callId);
    const call: FileCall = calls.get(key) ?? { sessionId: event.sessionId, time: event.time };
    call.order = order;
    call.time = event.time;
    if (event.type === "tool.call_started") {
      call.turnId = event.payload.turnId;
      call.toolName = event.payload.toolName;
    } else {
      call.status = event.payload.status;
      if (event.type === "tool.call_updated" && event.payload.toolName) call.toolName = event.payload.toolName;
      if (event.type === "tool.call_finished") {
        if (event.payload.error) call.error = event.payload.error;
        else delete call.error;
        if (event.payload.synthetic) call.synthetic = true;
        else delete call.synthetic;
      }
    }
    calls.set(key, call);
  }

  const candidates = new Map<string, Candidate>();
  for (const [order, event] of snapshot.events.entries()) {
    if (event.type !== "snapshot.created" || !event.sessionId || !allowed.has(event.sessionId)
      || !event.payload.callId || !event.payload.paths.some((path) => path.trim().length > 0)) continue;
    const key = callKey(event.sessionId, event.payload.callId);
    const call = calls.get(key);
    if (!call?.turnId) continue;
    // A baseline also lets the user inspect partial changes after a tool fails.
    candidates.set(key, { sessionId: event.sessionId, turnId: call.turnId, snapshot: true,
      time: Math.max(event.time, call.time), order: Math.max(order, call.order ?? order) });
  }
  for (const [key, call] of calls) {
    if (candidates.has(key) || !call.turnId || call.status !== "completed" || call.error || call.synthetic
      || !call.toolName || !FILE_WRITERS.has(call.toolName)) continue;
    candidates.set(key, { sessionId: call.sessionId, turnId: call.turnId, time: call.time, snapshot: false,
      ...(call.order !== undefined ? { order: call.order } : {}) });
  }
  let latest: Candidate | undefined;
  for (const candidate of candidates.values()) {
    if (!latest || compareCandidates(candidate, latest) > 0) latest = candidate;
  }
  return latest ? { sessionId: latest.sessionId, turnId: latest.turnId } : undefined;
}

function descendantSessions(root: string, agents: readonly RuntimeAgentRecord[]): Set<string> {
  const allowed = new Set([root]);
  const children = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.parentAgentId) continue;
    const siblings = children.get(agent.parentAgentId) ?? [];
    siblings.push(agent.agentId);
    children.set(agent.parentAgentId, siblings);
  }
  const pending = [root];
  while (pending.length) {
    for (const id of children.get(pending.pop()!) ?? []) {
      if (allowed.has(id)) continue;
      allowed.add(id);
      pending.push(id);
    }
  }
  return allowed;
}

function callKey(sessionId: string, callId: string): string { return JSON.stringify([sessionId, callId]); }

function compareCandidates(left: Candidate, right: Candidate): number {
  // Durable event order survives clock rollback. Only a compacted, runtime-only
  // candidate needs timestamp ordering against the retained event window.
  const order = left.order !== undefined && right.order !== undefined ? left.order - right.order : left.time - right.time;
  return order || Number(left.snapshot) - Number(right.snapshot);
}
