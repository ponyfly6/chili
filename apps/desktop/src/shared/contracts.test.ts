import { describe, expect, test } from "bun:test";
import { normalizePersistedError } from "@chili/protocol";
import { presentSession } from "../renderer/view-model.js";
import {
  desktopJsonUtf8Bytes,
  parseDesktopEvent,
  parseDesktopEventAck,
  parseDesktopEventEnvelope,
  parseDesktopEventReady,
  parseDesktopRequest,
  parseDesktopResponse,
  parseDesktopState,
} from "./contracts.js";

describe("desktop IPC contracts", () => {
  test("accepts a typed session send request", () => {
    expect(parseDesktopRequest({
      type: "session.send",
      sessionId: "session_1",
      text: "continue",
      mode: "steer",
    })).toEqual({ type: "session.send", sessionId: "session_1", text: "continue", mode: "steer" });
  });

  test("rejects unknown operations, fields, and invalid answers", () => {
    expect(() => parseDesktopRequest({ type: "shell.exec", command: "rm" })).toThrow();
    expect(() => parseDesktopRequest({ type: "app.state", token: "secret" })).toThrow("Unexpected request field");
    expect(() => parseDesktopRequest({ type: "user-input.resolve", inputId: "input_1", answers: {} })).toThrow("between 1 and 3");
    expect(() => parseDesktopRequest({
      type: "user-input.resolve",
      inputId: "input_1",
      answers: { one: ["1"], two: ["2"], three: ["3"], four: ["4"] },
    })).toThrow("between 1 and 3");
  });

  test("rejects prototype property names in answer and queued-session maps", () => {
    const protoAnswer = JSON.parse(
      '{"type":"user-input.resolve","inputId":"input_1","answers":{"__proto__":["polluted"]}}',
    ) as unknown;
    const constructorAnswer = JSON.parse(
      '{"type":"user-input.resolve","inputId":"input_1","answers":{"constructor":["polluted"]}}',
    ) as unknown;
    const protoQueue = JSON.parse(
      '{"sidecar":{"phase":"healthy","attempt":0},"queuedBySession":{"__proto__":1}}',
    ) as unknown;

    expect(() => parseDesktopRequest(protoAnswer)).toThrow("prototype property name");
    expect(() => parseDesktopRequest(constructorAnswer)).toThrow("prototype property name");
    expect(() => parseDesktopState(protoQueue)).toThrow("prototype property name");
    expect(() => parseDesktopEvent({ type: "queue.changed", sessionId: "constructor", count: 1 })).toThrow(
      "prototype property name",
    );
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test("rejects prototype property names in every external object-key identifier", () => {
    expect(() => parseDesktopRequest({ type: "session.snapshot", sessionId: "__proto__" })).toThrow(
      "prototype property name",
    );
    expect(() => parseDesktopEvent({
      type: "runtime.event",
      event: {
        id: "event_1",
        type: "message.created",
        time: 1,
        sessionId: "session_1",
        payload: { messageId: "constructor", role: "assistant" },
      },
    })).toThrow("prototype property name");
    expect(() => parseDesktopEvent({
      type: "runtime.event",
      event: {
        id: "event_2",
        type: "tool.call_started",
        time: 1,
        sessionId: "session_1",
        payload: { turnId: "turn_1", callId: "prototype", toolName: "read", input: {} },
      },
    })).toThrow("prototype property name");
    expect(() => parseDesktopEvent({
      type: "runtime.event",
      event: {
        id: "event_3",
        type: "team.task_updated",
        time: 1,
        sessionId: "session_1",
        payload: { teamId: "team_1", taskId: "__proto__", dependsOn: ["task_1"] },
      },
    })).toThrow("prototype property name");
    expect(() => parseDesktopEvent({
      type: "runtime.event",
      event: {
        id: "event_4",
        type: "message.part_added",
        time: 1,
        sessionId: "session_1",
        payload: {
          messageId: "message_1",
          part: { id: "constructor", messageId: "message_1", sessionId: "session_1", type: "text", text: "x" },
        },
      },
    })).toThrow("prototype property name");
  });

  test("accepts identifier-like fields inside opaque tool and snapshot provider data", () => {
    const opaqueEvent = {
      id: "event_opaque",
      type: "tool.call_started",
      time: 1,
      sessionId: "session_1",
      payload: {
        turnId: "turn_1",
        callId: "call_1",
        toolName: "provider_tool",
        input: { userId: 42, provider: { responseId: 7, metadata: { taskId: false } } },
      },
    };
    expect(parseDesktopEvent({ type: "runtime.event", event: opaqueEvent })).toMatchObject({
      event: { payload: { input: { userId: 42 } } },
    });

    const task = {
      id: "task_1",
      path: "/root/task",
      status: "completed",
      taskName: "task",
      generation: 0,
      completion: { userId: 42, provider: { responseId: 7 } },
      createdAt: 1,
      updatedAt: 2,
    };
    const request = parseDesktopRequest({ type: "session.snapshot", sessionId: "session_1" });
    expect(parseDesktopResponse(request, {
      sessionId: "session_1",
      events: [opaqueEvent],
      agentTree: {
        nodes: [],
        agents: [],
        tasks: [task],
        mailbox: [{ id: "mail_1", path: "/root", to: "*", content: "ok", metadata: { userId: 42 } }],
      },
      tasks: [task],
      pendingApprovals: [],
      pendingInputs: [],
    })).toMatchObject({
      sessionId: "session_1",
      tasks: [{ completion: { userId: 42 } }],
    });
  });

  test("still rejects malicious known IDs in snapshot structures", () => {
    const request = parseDesktopRequest({ type: "session.snapshot", sessionId: "session_1" });
    expect(() => parseDesktopResponse(request, {
      sessionId: "session_1",
      events: [],
      agentTree: {
        nodes: [],
        agents: [],
        tasks: [],
        mailbox: [{
          id: "mail_1",
          path: "/root",
          fromPath: "/root/source",
          triggerTurn: false,
          status: "queued",
          recipientSessionId: "__proto__",
          createdAt: 1,
        }],
      },
      tasks: [],
      pendingApprovals: [],
      pendingInputs: [],
    })).toThrow("prototype property name");
  });

  test("validates authoritative pending approvals without requiring event anchors", () => {
    const request = parseDesktopRequest({ type: "session.snapshot", sessionId: "session_1" });
    const snapshot = {
      sessionId: "session_1",
      events: [],
      agentTree: { nodes: [], agents: [], tasks: [], mailbox: [] },
      tasks: [],
      pendingApprovals: [{
        id: "approval_1",
        sessionId: "session_1",
        callId: "call_missing_from_window",
        permission: "tool.bash",
        patterns: ["bun test"],
        maxApprovalScope: "session",
        createdAt: 1,
      }],
      pendingInputs: [],
    };
    expect(parseDesktopResponse(request, snapshot)).toMatchObject({
      pendingApprovals: [{ id: "approval_1", callId: "call_missing_from_window" }],
    });
    expect(() => parseDesktopResponse(request, {
      ...snapshot,
      pendingApprovals: [{ ...snapshot.pendingApprovals[0], metadata: { hostile: "x".repeat(70_000) } }],
    })).toThrow("Pending approval exceeds the JSON byte budget");
  });

  test("validates state and pushed events", () => {
    expect(parseDesktopState({ sidecar: { phase: "healthy", attempt: 0 }, queuedBySession: {} })).toMatchObject({
      sidecar: { phase: "healthy" },
    });
    expect(parseDesktopEvent({ type: "queue.changed", sessionId: "session_1", count: 2 })).toEqual({
      type: "queue.changed",
      sessionId: "session_1",
      count: 2,
    });
    expect(() => parseDesktopEvent({ type: "queue.changed", sessionId: "session_1", count: -1 })).toThrow("Invalid queue count");
    expect(parseDesktopEvent({
      type: "runtime.resync",
      barrierId: "barrier_1",
      reason: "outbox_overflow",
    })).toEqual({ type: "runtime.resync", barrierId: "barrier_1", reason: "outbox_overflow" });
    expect(() => parseDesktopEvent({
      type: "runtime.resync",
      barrierId: "barrier_1",
      reason: "arbitrary renderer text",
    })).toThrow("Invalid desktop resync reason");
  });

  test("projects every accepted MessagePart variant without renderer type faults", () => {
    const events = [
      runtimeEnvelope("session.created", { sessionId: "session_1", cwd: "/repo" }, "event_session"),
      runtimeEnvelope("message.created", { messageId: "message_1", role: "assistant", turnId: "turn_1" }, "event_message"),
      ...[
        { id: "part_text", messageId: "message_1", sessionId: "session_1", type: "text", text: "hello" },
        { id: "part_image", messageId: "message_1", sessionId: "session_1", type: "image", data: "AA==", mimeType: "image/png" },
        { id: "part_reasoning", messageId: "message_1", sessionId: "session_1", type: "reasoning", text: "think", modelOutput: { apiFamily: "responses", item: { userId: 42 } } },
        { id: "part_call", messageId: "message_1", sessionId: "session_1", type: "tool_call", callId: "call_1", toolName: "read", input: { userId: 42 }, status: "completed" },
        { id: "part_result", messageId: "message_1", sessionId: "session_1", type: "tool_result", callId: "call_1", output: "ok", content: [{ type: "text", text: "ok" }] },
        { id: "part_patch", messageId: "message_1", sessionId: "session_1", type: "patch", files: ["a.ts"], artifactId: "artifact_1" },
        { id: "part_artifact", messageId: "message_1", sessionId: "session_1", type: "artifact", artifactId: "artifact_2" },
        { id: "part_compaction", messageId: "message_1", sessionId: "session_1", type: "compaction", boundaryMessageId: "message_0", reason: "manual" },
        { id: "part_handoff", messageId: "message_1", sessionId: "session_1", type: "agent_handoff", agentPath: "/root/worker", summary: "done" },
      ].map((part, index) => runtimeEnvelope("message.part_added", { messageId: "message_1", part }, `event_part_${index}`)),
    ].map((event) => {
      const parsed = parseDesktopEvent({ type: "runtime.event", event });
      if (parsed.type !== "runtime.event") throw new Error("Expected runtime event");
      return parsed.event;
    });

    expect(() => presentSession({
      sessionId: "session_1",
      events,
      agentTree: { nodes: [], agents: [], tasks: [], mailbox: [] },
      tasks: [],
      pendingApprovals: [],
      pendingInputs: [],
    })).not.toThrow();
    expect(presentSession({
      sessionId: "session_1",
      events,
      agentTree: { nodes: [], agents: [], tasks: [], mailbox: [] },
      tasks: [],
      pendingApprovals: [],
      pendingInputs: [],
    }).runtime.messages.message_1?.parts).toHaveLength(9);
  });

  test("rejects malformed projection-consumed event fields before renderer code", () => {
    const malformed: Array<[string, ReturnType<typeof runtimeEnvelope>]> = [
      ["unknown event", runtimeEnvelope("provider.unknown", {}, "bad_unknown")],
      ["session cwd", runtimeEnvelope("session.created", { sessionId: "session_1", cwd: { path: "/repo" } }, "bad_session")],
      ["session status", runtimeEnvelope("session.status_changed", { sessionId: "session_1", status: "sleeping" }, "bad_status")],
      ["turn retry", runtimeEnvelope("turn.retry_scheduled", { turnId: "turn_1", attempt: "one", delayMs: 1, reason: "retry" }, "bad_retry")],
      ["message role", runtimeEnvelope("message.created", { messageId: "message_1", role: "owner" }, "bad_role")],
      ["text part", runtimeEnvelope("message.part_added", { messageId: "message_1", part: { id: "part_1", messageId: "message_1", sessionId: "session_1", type: "text", text: { not: "a string" } } }, "bad_text")],
      ["part type", runtimeEnvelope("message.part_added", { messageId: "message_1", part: { id: "part_1", messageId: "message_1", sessionId: "session_1", type: "provider_blob" } }, "bad_part")],
      ["delta field", runtimeEnvelope("message.part_delta", { messageId: "message_1", partId: "part_1", field: {}, delta: "x" }, "bad_delta")],
      ["tool status", runtimeEnvelope("tool.call_updated", { callId: "call_1", status: "unknown" }, "bad_tool")],
      ["tool bytes", runtimeEnvelope("tool.output_delta", { callId: "call_1", stream: "stdout", delta: "x", bytes: "1" }, "bad_bytes")],
      ["approval patterns", runtimeEnvelope("approval.requested", { approvalId: "approval_1", permission: "read", patterns: {} }, "bad_approval")],
      ["input questions", runtimeEnvelope("user_input.requested", { inputId: "input_1", callId: "call_1", questions: "question" }, "bad_input")],
      ["goal objective", runtimeEnvelope("goal.updated", { goal: { sessionId: "session_1", objective: {}, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } }, "bad_goal")],
      ["agent task name", runtimeEnvelope("agent.spawned", { runId: "run_1", path: "/root/worker", taskName: {}, status: "running" }, "bad_agent")],
      ["team counts", runtimeEnvelope("team.run_progress", { teamId: "team_1", runId: "run_1", cycle: 1, phase: "load", counts: { dispatched: "one" } }, "bad_team")],
      ["mcp status", runtimeEnvelope("mcp.progress", { serverName: "server", operation: "connect", status: "unknown" }, "bad_mcp")],
    ];

    for (const [label, event] of malformed) {
      expect(() => parseDesktopEvent({ type: "runtime.event", event }), label).toThrow();
    }
  });

  test("validates sequenced event envelopes and private stream control messages", () => {
    const envelope = {
      version: 1,
      streamId: "stream_1",
      sequence: 7,
      event: { type: "queue.changed", sessionId: "session_1", count: 2 },
    } as const;
    expect(parseDesktopEventEnvelope(envelope)).toEqual(envelope);
    expect(parseDesktopEventAck({ version: 1, streamId: "stream_1", sequence: 7 })).toEqual({
      version: 1,
      streamId: "stream_1",
      sequence: 7,
    });
    expect(parseDesktopEventReady({ version: 1, streamId: "stream_1" })).toEqual({ version: 1, streamId: "stream_1" });
    expect(() => parseDesktopEventEnvelope({ ...envelope, sequence: 0 })).toThrow("positive integer");
    expect(() => parseDesktopEventAck({ version: 1, streamId: "stream_1", sequence: 8, extra: true })).toThrow(
      "Unexpected request field",
    );
  });

  test("counts exact serialized UTF-8 bytes including JSON escapes", () => {
    const value = { text: "😀\n\\\"" };
    expect(desktopJsonUtf8Bytes(value)).toBe(Buffer.byteLength(JSON.stringify(value), "utf8"));
  });

  test("rejects runtime events whose cumulative strings exceed the IPC byte budget", () => {
    const base64Chunk = "A".repeat(600_000);
    expect(() => parseDesktopEvent({
      type: "runtime.event",
      event: {
        id: "event_oversized_content",
        type: "tool.call_finished",
        time: 1,
        sessionId: "session_1",
        payload: {
          content: Array.from({ length: 21 }, () => ({ type: "image", data: base64Chunk })),
        },
      },
    })).toThrow("JSON byte budget");
  });

  test("carries a normalized worst-escaped 5 MiB error below the desktop IPC cap without cause data", () => {
    const secret = "CAUSE_SECRET_MUST_NOT_CROSS_IPC";
    const hostile = Object.assign(new Error("\u0000".repeat(5 * 1024 * 1024)), {
      cause: { secret },
      code: "E_PROVIDER",
    });
    const normalized = normalizePersistedError(hostile);
    const envelope = parseDesktopEventEnvelope({
      version: 1,
      streamId: "stream_1",
      sequence: 1,
      event: {
        type: "runtime.event",
        event: {
          id: "event_error",
          type: "tool.call_finished",
          time: 1,
          sessionId: "session_1",
          payload: {
            callId: "call_1",
            status: "failed",
            error: normalized.message,
            errorDetails: normalized.persistedErrorDetails,
          },
        },
      },
    });
    const serialized = JSON.stringify(envelope);
    expect(desktopJsonUtf8Bytes(envelope)).toBeLessThan(12_000_000);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("cause");
    expect(envelope.event).toMatchObject({
      event: { payload: { errorDetails: { truncated: true, name: "Error" } } },
    });
  });

  test("validates responses at both ends of the IPC bridge", () => {
    const request = parseDesktopRequest({ type: "sessions.create" });
    expect(parseDesktopResponse(request, { sessionId: "session_1" })).toEqual({ sessionId: "session_1" });
    expect(() => parseDesktopResponse(request, { sessionId: "" })).toThrow("must not be empty");
    expect(() => parseDesktopResponse(
      { type: "session.send", sessionId: "session_1", text: "hi", mode: "queue" },
      { status: "unknown" },
    )).toThrow("Invalid send status");

    const resync = parseDesktopRequest({ type: "events.resync.complete", barrierId: "barrier_1" });
    expect(parseDesktopResponse(resync, { status: "completed" })).toEqual({ status: "completed" });
    expect(() => parseDesktopResponse(resync, { status: "unknown" })).toThrow("Invalid resync completion status");
  });
});

function runtimeEnvelope(type: string, payload: Record<string, unknown>, id: string) {
  return { id, type, time: 1, sessionId: "session_1", payload };
}
