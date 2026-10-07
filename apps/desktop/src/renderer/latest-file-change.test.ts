import { expect, test } from "bun:test";
import type { ChiliEvent } from "@chili/protocol";
import type { RuntimeAgentRecord, RuntimeToolCallView } from "@chili/sdk";
import { latestFileChange } from "./latest-file-change.js";

function event(type: string, sessionId: string, payload: unknown, time = 1): ChiliEvent {
  return { id: `${sessionId}:${type}:${time}`, type, sessionId, payload, time } as ChiliEvent;
}
function started(sessionId: string, turnId: string, callId: string, toolName = "write", time = 1): ChiliEvent {
  return event("tool.call_started", sessionId, { turnId, callId, toolName, input: {} }, time);
}
function finished(sessionId: string, callId: string, status = "completed", time = 2): ChiliEvent {
  return event("tool.call_finished", sessionId, { callId, status }, time);
}
function baseline(sessionId: string, callId?: string, paths = ["file.txt"], time = 3): ChiliEvent {
  return event("snapshot.created", sessionId, { snapshotId: `snapshot:${time}`, callId, paths, reason: "before write" }, time);
}
function call(sessionId: string, turnId: string, toolName = "write", updatedAt = 10, extra: Partial<RuntimeToolCallView> = {}): RuntimeToolCallView {
  return { id: `${sessionId}:${turnId}` as never, sessionId: sessionId as never, turnId: turnId as never,
    toolName, input: {}, status: "completed", updatedAt, ...extra };
}
function snapshot(events: ChiliEvent[] = [], agents: RuntimeAgentRecord[] = []) { return { sessionId: "root", events, agents }; }
function agent(agentId: string, parentAgentId?: string): RuntimeAgentRecord {
  return { agentId, name: agentId, path: "/root", state: "idle", ...(parentAgentId ? { parentAgentId } : {}) };
}

test("empty and read-only sessions have no file change target", () => {
  expect(latestFileChange(undefined)).toBeUndefined();
  expect(latestFileChange(snapshot())).toBeUndefined();
  const events = [event("turn.started", "root", { turnId: "answer" }), started("root", "answer", "read", "read"), finished("root", "read")];
  expect(latestFileChange(snapshot(events))).toBeUndefined();
  for (const toolName of ["read", "read_image", "glob", "grep", "present_file", "bash", "tool_search"]) {
    expect(latestFileChange(snapshot(), { toolCalls: { read: call("root", "read", toolName) } })).toBeUndefined();
  }
});

test("a later final-answer or read-only turn does not replace the previous file modification", () => {
  const events = [started("root", "edited", "write"), baseline("root", "write"), finished("root", "write"),
    event("turn.completed", "root", { turnId: "edited" }, 4), event("turn.started", "root", { turnId: "answer" }, 5),
    started("root", "answer", "read", "read", 6), finished("root", "read", "completed", 7),
    event("turn.completed", "root", { turnId: "answer" }, 8)];
  expect(latestFileChange(snapshot(events))).toEqual({ sessionId: "root", turnId: "edited" });
});

test("a nonempty snapshot associates a nonstandard file tool with its own turn", () => {
  const events = [started("root", "changed", "mcp", "mcp__filesystem__update"), baseline("root", "mcp")];
  expect(latestFileChange(snapshot(events))).toEqual({ sessionId: "root", turnId: "changed" });
});

test("snapshot evidence survives a failed tool so partial changes can be inspected", () => {
  const events = [started("root", "partial", "write"), baseline("root", "write"), finished("root", "write", "failed", 4)];
  expect(latestFileChange(snapshot(events))).toEqual({ sessionId: "root", turnId: "partial" });
});

test("empty and unassociated snapshots cannot guess a turn from other activity", () => {
  const events = [event("turn.started", "root", { turnId: "unrelated" }), baseline("root"), baseline("root", "missing"),
    started("root", "read", "reader", "read"), baseline("root", "reader", []), baseline("root", "reader", [" "])];
  expect(latestFileChange(snapshot(events))).toBeUndefined();
});

test("successful file tools are a fallback when no baseline was retained", () => {
  for (const toolName of ["write", "write_file", "edit", "replace", "apply_patch"]) {
    const events = [started("root", "changed", "call", toolName), finished("root", "call")];
    expect(latestFileChange(snapshot(events))).toEqual({ sessionId: "root", turnId: "changed" });
    expect(latestFileChange(snapshot(), { toolCalls: { call: call("root", "changed", toolName) } })).toEqual({ sessionId: "root", turnId: "changed" });
  }
});

test("failed, pending, running, cancelled, and synthetic tools are not fallback evidence", () => {
  for (const status of ["pending", "running", "failed", "cancelled"] as const) {
    expect(latestFileChange(snapshot(), { toolCalls: { call: call("root", "changed", "write", 10, { status }) } })).toBeUndefined();
  }
  for (const extra of [{ error: "failed" }, { synthetic: true }, { turnId: undefined }, { sessionId: undefined }]) {
    const value = { ...call("root", "changed"), ...extra } as RuntimeToolCallView;
    expect(latestFileChange(snapshot(), { toolCalls: { call: value } })).toBeUndefined();
  }
});

test("newer successful writes take precedence over old snapshots and later answers", () => {
  const events = [started("root", "old", "old", "edit", 1), baseline("root", "old", ["a"], 2), finished("root", "old", "completed", 3),
    started("root", "new", "new", "write", 4), finished("root", "new", "completed", 5),
    event("turn.completed", "root", { turnId: "summary" }, 6)];
  expect(latestFileChange(snapshot(events))).toEqual({ sessionId: "root", turnId: "new" });
});

test("snapshot associations can use scoped projected calls when start events were compacted", () => {
  const runtime = { toolCalls: { compacted: call("root", "compacted-turn", "mcp__update", 2, { id: "compacted" as never }) } };
  expect(latestFileChange(snapshot([baseline("root", "compacted")]), runtime)).toEqual({ sessionId: "root", turnId: "compacted-turn" });
});

test("root and nested descendants are eligible regardless of record ordering", () => {
  const agents = [agent("nested", "child"), agent("child", "root"), agent("root")];
  const events = [started("root", "root-turn", "root-call"), finished("root", "root-call"),
    started("nested", "nested-turn", "nested-call", "edit", 4), baseline("nested", "nested-call", ["a"], 5)];
  expect(latestFileChange(snapshot(events, agents))).toEqual({ sessionId: "nested", turnId: "nested-turn" });
});

test("unrelated roots, orphan agents, and cycles cannot pollute a selected session", () => {
  const agents = [agent("other"), agent("other-child", "other"), agent("orphan", "missing"), agent("a", "b"), agent("b", "a")];
  const events = [started("other", "other-turn", "other-call"), baseline("other", "other-call")];
  const toolCalls = Object.fromEntries(["other", "other-child", "orphan", "a", "b", "unknown"].map((id) => [id, call(id, `${id}-turn`)]));
  expect(latestFileChange(snapshot(events, agents), { toolCalls })).toBeUndefined();
});

test("a shared call ID never associates a foreign call with a root snapshot", () => {
  const foreign = call("foreign", "foreign-turn", "write", 50, { id: "shared" as never });
  expect(latestFileChange(snapshot([baseline("root", "shared")]), { toolCalls: { shared: foreign } })).toBeUndefined();
  const events = [started("root", "root-turn", "shared"), baseline("root", "shared"), started("foreign", "foreign-turn", "shared", "write", 99)];
  expect(latestFileChange(snapshot(events), { toolCalls: { shared: foreign } })).toEqual({ sessionId: "root", turnId: "root-turn" });
});

test("durable event order selects the most recent mutation despite clock rollback", () => {
  const events = [started("root", "old", "old", "write", 100), finished("root", "old", "completed", 101),
    started("root", "new", "new", "edit", 3), baseline("root", "new", ["a"], 4)];
  expect(latestFileChange(snapshot(events))).toEqual({ sessionId: "root", turnId: "new" });
});

test("new runtime-only modification evidence can follow a compacted event window", () => {
  const events = [started("root", "old", "old", "write", 1), baseline("root", "old", ["a"], 2)];
  expect(latestFileChange(snapshot(events), { toolCalls: { newest: call("root", "new", "write", 100) } }))
    .toEqual({ sessionId: "root", turnId: "new" });
});
