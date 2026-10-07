import { expect, test } from "bun:test";
import type { SessionEvent } from "@chili/protocol";
import { parseDesktopEvent, parseDesktopEventEnvelope, parseDesktopResponse } from "./contracts.js";
import { presentSession } from "../renderer/view-model.js";

const loaded = {
  id: "event_tools", type: "session.tools_loaded", time: 10, sessionId: "session_1",
  payload: { sessionId: "session_1", turnId: "turn_1", callId: "call_search", names: ["grep", "mcp__minimax__web_search", "mcp__minimax__understand_image", "memory", "read_image"] },
};

test("tool discovery crosses both live event and snapshot boundaries without interrupting the session", () => {
  const desktop = { type: "runtime.event", projectId: "project_1", event: loaded };
  expect(parseDesktopEvent(desktop)).toMatchObject(desktop);
  const envelope = { version: 1, streamId: "stream_1", sequence: 5, event: desktop };
  expect(parseDesktopEventEnvelope(envelope)).toMatchObject(envelope);
  const snapshot = parseDesktopResponse({ type: "session.snapshot", sessionId: "session_1" }, {
    sessionId: "session_1", events: [
      { id: "event_session", type: "session.created", sessionId: "session_1", time: 1, payload: { sessionId: "session_1", cwd: "/repo" } },
      loaded,
      { id: "event_message", type: "message.created", sessionId: "session_1", time: 11, payload: { messageId: "message_1", role: "assistant", turnId: "turn_1" } },
    ], agents: [], pendingInputs: [], pendingApprovals: [],
  });
  expect(snapshot.events[1]).toMatchObject(loaded);
  expect(() => presentSession(snapshot)).not.toThrow();
});

test("tool discovery rejects malformed ownership, IDs and tool names instead of ignoring events", () => {
  for (const payload of [
    { ...loaded.payload, sessionId: "another_session" },
    { ...loaded.payload, turnId: undefined },
    { ...loaded.payload, callId: 42 },
    { ...loaded.payload, names: "mcp__minimax__web_search" },
    { ...loaded.payload, names: ["valid", 42] },
    { ...loaded.payload, turnId: "__proto__" },
    { ...loaded.payload, callId: "constructor" },
  ]) expect(() => parseDesktopEvent({ type: "runtime.event", event: { ...loaded, payload } })).toThrow();
  expect(() => parseDesktopEvent({ type: "runtime.event", event: { ...loaded, sessionId: undefined } })).toThrow();
  expect(() => parseDesktopEvent({ type: "runtime.event", event: { ...loaded, type: "session.future_unknown" } })).toThrow("Unsupported runtime event type");
});

test("every declared session event used alongside skills has a desktop transport path", () => {
  const identity = { profileId: "profile", profilePath: "/profile", authPath: "/profile/auth.json", projectId: "project", projectRoot: "/repo", workspaceId: "workspace", workspaceRoot: "/repo" };
  // This exhaustive type check makes a future session event require a fixture.
  const payloads: Record<SessionEvent["type"], Record<string, unknown>> = {
    "session.tools_loaded": loaded.payload,
    "session.input_queue_changed": { sessionId: "session_1", paused: false, revision: 0, pendingCount: 0, interruptedCount: 0, items: [] },
    "session.created": { sessionId: "session_1", cwd: "/repo" },
    "session.identity_bound": { sessionId: "session_1", identity },
    "session.renamed": { sessionId: "session_1", title: "Skill result" },
    "session.status_changed": { sessionId: "session_1", status: "running", turnId: "turn_1" },
    "session.model_changed": { sessionId: "session_1", modelSelection: { provider: "minimax", model: "MiniMax-M3" } },
    "session.reasoning_changed": { sessionId: "session_1", reasoningLevel: "high" },
    "session.service_tier_changed": { sessionId: "session_1", serviceTier: "standard" },
    "session.delegation_changed": { sessionId: "session_1", policy: "explicit" },
    "session.archived": { sessionId: "session_1" },
  };
  for (const [type, payload] of Object.entries(payloads)) {
    const event = { ...loaded, id: `event_${type}`, type, payload };
    expect(parseDesktopEvent({ type: "runtime.event", event })).toMatchObject({ type: "runtime.event", event });
  }
  // Skill activation uses the existing tool lifecycle, not an invented session event.
  expect(parseDesktopEvent({ type: "runtime.event", event: {
    ...loaded, type: "tool.call_started", payload: { turnId: "turn_1", callId: "skill_call", toolName: "activate_skill", input: { name: "design-dna" } },
  } })).toMatchObject({ event: { payload: { toolName: "activate_skill" } } });
});
