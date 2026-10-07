import { expect, test } from "bun:test";
import type { ChiliEvent, RuntimeInputQueue, RuntimeSessionStatus, SessionId } from "@chili/protocol";
import type { RuntimeSnapshot, UserInputRequest } from "../shared/contracts.js";
import { SidebarActivityMemory } from "./sidebar-activity-memory.js";

test("retains each session independently and isolates equal IDs in different projects", () => {
  const memory = new SidebarActivityMemory();
  memory.ingest("project-a", status("same", "running", "a-running"));
  memory.ingest("project-a", status("other", "waiting_for_approval", "other-review"));
  memory.ingest("project-b", status("same", "idle", "b-idle"));
  expect(memory.read("project-a", "same").status).toBe("running");
  expect(memory.read("project-a", "other").status).toBe("waiting_for_approval");
  expect(memory.read("project-b", "same").status).toBe("idle");
  expect(memory.read("missing", "same")).toEqual({});
  memory.ingest(undefined, status("same", "failed", "unscoped"));
  expect(memory.read(undefined, "same")).toEqual({});
});

test("tracks simultaneous input requests and prevents settled requests from returning", () => {
  const memory = new SidebarActivityMemory();
  memory.ingest("a", requested("s", "one"));
  memory.ingest("a", requested("s", "two"));
  memory.ingest("a", inputEvent("s", "one", "user_input.resolved"));
  expect(memory.read("a", "s").pendingInput).toBe(true);
  memory.ingest("a", inputEvent("s", "two", "user_input.cancelled"));
  expect(memory.read("a", "s").pendingInput).toBe(false);
  memory.ingest("a", { ...requested("s", "one"), id: "late-request" });
  memory.seed("a", snapshot("s", [], [input("s", "one")]));
  expect(memory.read("a", "s").pendingInput).toBe(false);
});

test("terminal sessions clear pending requests without discarding paused queued messages", () => {
  for (const terminal of ["idle", "cancelled", "failed"] as const) {
    const memory = new SidebarActivityMemory();
    memory.ingest("a", requested("s", "one"));
    memory.ingest("a", queueEvent(queue("s", 3, true, 2)));
    memory.ingest("a", status("s", terminal, "terminal"));
    expect(memory.read("a", "s")).toMatchObject({ status: terminal, pendingInput: false, paused: true, queuedCount: 2 });
    memory.seed("a", snapshot("s", [], [input("s", "one")]));
    expect(memory.read("a", "s").pendingInput).toBe(false);
  }
});

test("ignores lower and equal queue revisions from live events and selected snapshots", () => {
  const memory = new SidebarActivityMemory();
  memory.ingest("a", queueEvent(queue("s", 5, true, 3)));
  memory.ingest("a", queueEvent(queue("s", 4, false, 0)));
  memory.seed("a", { ...snapshot("s"), inputQueue: queue("s", 5, false, 0) });
  expect(memory.read("a", "s")).toMatchObject({ paused: true, queuedCount: 3 });
  memory.seed("a", { ...snapshot("s"), inputQueue: queue("s", 6, false, 1) });
  expect(memory.read("a", "s")).toMatchObject({ paused: false, queuedCount: 1 });
});

test("seeds input requests from the authoritative list instead of crash-replayed history", () => {
  const memory = new SidebarActivityMemory();
  memory.ingest("a", requested("other", "other-input"));
  const history = [status("s", "running", "running"), requested("s", "historical")];
  memory.seed("a", snapshot("s", history));
  expect(memory.read("a", "s")).toMatchObject({ status: "running", pendingInput: false });
  expect(memory.read("a", "other").pendingInput).toBe(true);
  memory.seed("a", snapshot("s", history, [input("s", "historical")]));
  expect(memory.read("a", "s").pendingInput).toBe(true);
  memory.seed("a", snapshot("s", [...history, inputEvent("s", "historical", "user_input.resolved")], [input("s", "historical")]));
  expect(memory.read("a", "s").pendingInput).toBe(false);
});

test("duplicate snapshot events cannot roll back newer live status and clock rollback is accepted", () => {
  const memory = new SidebarActivityMemory();
  const running = status("s", "running", "running");
  memory.seed("a", snapshot("s", [running]));
  memory.ingest("a", { ...status("s", "idle", "idle"), time: 0 as never });
  memory.seed("a", snapshot("s", [running]));
  expect(memory.read("a", "s").status).toBe("idle");
});

test("first hydration cannot replay an unseen running status over an observed terminal status", () => {
  const memory = new SidebarActivityMemory();
  const running = status("s", "running", "running");
  const idle = status("s", "idle", "idle");
  memory.ingest("a", idle);
  memory.seed("a", snapshot("s", [running, idle]));
  expect(memory.read("a", "s").status).toBe("idle");
});

test("stale status history preserves later live state and a covering snapshot can advance it", () => {
  const memory = new SidebarActivityMemory();
  const running = status("s", "running", "running");
  const reviewing = status("s", "waiting_for_approval", "reviewing");
  const idle = status("s", "idle", "idle");
  const resumed = { ...status("s", "running", "resumed"), time: 0 as never };
  memory.ingest("a", idle);
  memory.seed("a", snapshot("s", [running, reviewing]));
  expect(memory.read("a", "s").status).toBe("idle");
  memory.seed("a", snapshot("s", [running, reviewing, idle, resumed]));
  expect(memory.read("a", "s").status).toBe("running");
});

test("historical terminal status cannot settle an authoritative current input request", () => {
  const memory = new SidebarActivityMemory();
  const running = status("s", "running", "running");
  memory.ingest("a", running);
  memory.ingest("a", requested("s", "current"));
  memory.seed("a", snapshot("s", [status("s", "idle", "old-idle"), running], [input("s", "current")]));
  expect(memory.read("a", "s")).toMatchObject({ status: "running", pendingInput: true });
});

test("archives clear pending attention and ignore delayed requests", () => {
  const memory = new SidebarActivityMemory();
  memory.ingest("a", requested("s", "one"));
  memory.ingest("a", { id: "archive", time: 2 as never, type: "session.archived", sessionId: "s" as SessionId, payload: { sessionId: "s" as SessionId } });
  memory.ingest("a", requested("s", "late"));
  expect(memory.read("a", "s")).toMatchObject({ archived: true, pendingInput: false });
});

test("ignores transcript events and mismatched session envelopes", () => {
  const memory = new SidebarActivityMemory();
  memory.ingest("a", { id: "message", time: 1 as never, sessionId: "s" as SessionId, type: "message.created", payload: { messageId: "m" as never, role: "user" } });
  memory.ingest("a", { ...status("s", "running", "wrong"), sessionId: "other" as SessionId });
  expect(memory.read("a", "s")).toEqual({});
  expect(memory.read("a", "other")).toEqual({});
});

function status(sessionId: string, value: RuntimeSessionStatus, id: string): ChiliEvent {
  return { id, time: 1 as never, sessionId: sessionId as SessionId, type: "session.status_changed", payload: { sessionId: sessionId as SessionId, status: value } };
}

function requested(sessionId: string, inputId: string): ChiliEvent {
  return { id: `request-${inputId}`, time: 1 as never, sessionId: sessionId as SessionId, type: "user_input.requested", payload: { inputId: inputId as never, callId: "call" as never, questions: [] } };
}

function inputEvent(sessionId: string, inputId: string, type: "user_input.resolved" | "user_input.cancelled"): ChiliEvent {
  const common = { id: `${type}-${inputId}`, time: 2 as never, sessionId: sessionId as SessionId };
  return type === "user_input.resolved"
    ? { ...common, type, payload: { inputId: inputId as never, answers: {} } }
    : { ...common, type, payload: { inputId: inputId as never } };
}

function queue(sessionId: string, revision: number, paused: boolean, pendingCount: number): RuntimeInputQueue {
  return { sessionId: sessionId as SessionId, revision, paused, pendingCount, interruptedCount: 0, items: [] };
}

function queueEvent(payload: RuntimeInputQueue): ChiliEvent {
  return { id: `queue-${payload.revision}`, time: 1 as never, sessionId: payload.sessionId, type: "session.input_queue_changed", payload };
}

function input(sessionId: string, id: string): UserInputRequest {
  return { id, sessionId, callId: "call", questions: [], createdAt: 1 };
}

function snapshot(sessionId: string, events: ChiliEvent[] = [], pendingInputs: UserInputRequest[] = []): RuntimeSnapshot {
  return { sessionId, events, pendingInputs, agents: [], pendingApprovals: [] };
}
