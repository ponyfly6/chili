import { describe, expect, test } from "bun:test";
import { normalizePersistedError, SESSION_TITLE_MAX_CHARS } from "@chili/protocol";
import { presentSession } from "../renderer/view-model.js";
import {
  DESKTOP_INVOKE_CLOSING_RESPONSE,
  desktopJsonUtf8Bytes,
  parseDesktopEvent,
  parseDesktopEventAck,
  parseDesktopEventEnvelope,
  parseDesktopEventReady,
  parseDesktopInvokeResponse,
  parseDesktopRequest,
  parseDesktopResponse,
  parseDesktopState,
} from "./contracts.js";

describe("desktop IPC contracts", () => {
  test("accepts compact model audit references and rejects malformed resolved identities", () => {
    const prepared = runtimeEnvelope("model.request_prepared", {
      turnId: "turn_1", requestId: "request_1", attempt: 1, contentVersion: "sha256:content",
    }, "prepared_1");
    const resolved = runtimeEnvelope("model.request_identity", {
      turnId: "turn_1", requestId: "request_1", attempt: 1,
      identity: { provider: "test", model: "test-model", profileId: "profile-a", credentialVersion: "sha256:credential" },
    }, "identity_1");
    for (const event of [prepared, resolved]) {
      expect(parseDesktopEvent({ type: "runtime.event", event })).toMatchObject({ type: "runtime.event", event });
    }
    expect(() => parseDesktopEvent({ type: "runtime.event", event: {
      ...prepared, payload: { turnId: "turn_1", requestId: "request_1", attempt: 1 },
    } })).toThrow("contentVersion");
    expect(() => parseDesktopEvent({ type: "runtime.event", event: {
      ...resolved, payload: { ...resolved.payload, identity: { provider: "test", model: 5 } },
    } })).toThrow("model");
    expect(() => parseDesktopEvent({ type: "runtime.event", event: {
      ...resolved, payload: { ...resolved.payload, identity: { provider: "test", model: "test-model", accessToken: "fake-secret" } },
    } })).toThrow("unsupported field");
  });

  test("validates execution identity for both new and legacy session binding events", () => {
    const identity = {
      profileId: "profile-a", profilePath: "/tmp/profile-a", authPath: "/tmp/profile-a/auth.json",
      projectId: "project-a", projectRoot: "/tmp/project-a",
      workspaceId: "workspace-a", workspaceRoot: "/tmp/project-a/worktree",
    };
    for (const type of ["session.created", "session.identity_bound"]) {
      const event = runtimeEnvelope(type, { sessionId: "session_1", cwd: "/tmp", identity }, `${type}_1`);
      expect(parseDesktopEvent({ type: "runtime.event", event })).toMatchObject({ type: "runtime.event", event });
      expect(() => parseDesktopEvent({ type: "runtime.event", event: {
        ...event, payload: { ...event.payload, identity: { ...identity, workspaceId: 4 } },
      } })).toThrow("workspaceId");
    }
    expect(() => parseDesktopEvent({ type: "runtime.event", event:
      runtimeEnvelope("session.identity_bound", { sessionId: "other-session", identity }, "binding_1"),
    })).toThrow("sessionId");
  });

  test("validates project-scoped requests and bounded project summaries", () => {
    const request = { type: "session.stop", projectId: "project-a", sessionId: "session-1" } as const;
    expect(parseDesktopRequest(request)).toEqual(request);
    expect(parseDesktopRequest({ type: "workspace.activate", id: "project-b" })).toEqual({ type: "workspace.activate", id: "project-b" });
    expect(() => parseDesktopRequest({ ...request, projectId: "../outside" })).toThrow();
    expect(() => parseDesktopRequest({ type: "workspace.activate", id: "project-b", path: "/arbitrary" })).toThrow();
    const project = { id: "project-a", path: "/a", phase: "healthy" as const, runningCount: 1, attentionCount: 0,
      tasksLoaded: true, recentTasks: [{ id: "session-1", title: "Task A", status: "active" as const, updatedAt: 1 }] };
    const state = { projectId: "project-a", workspace: "/a", projects: [project], sidecar: { phase: "healthy" as const, attempt: 0 }, queuedBySession: {} };
    expect(parseDesktopState(state)).toEqual(state);
    expect(() => parseDesktopState({ ...state, workspace: "/b" })).toThrow("Active project");
    expect(() => parseDesktopState({ ...state, projects: [project, project] })).toThrow("Duplicate projects");
    expect(() => parseDesktopState({ ...state, projects: Array(65).fill(project) })).toThrow("project list");
    expect(() => parseDesktopState({ ...state, projects: [{ ...project, runningCount: -1 }] })).toThrow();
    expect(() => parseDesktopState({ ...state, projects: [{ ...project, recentTasks: Array(9).fill(project.recentTasks[0]) }] })).toThrow("project tasks");
    expect(parseDesktopEvent({ type: "queue.changed", projectId: "project-b", sessionId: "session-1", count: 2 }))
      .toEqual({ type: "queue.changed", projectId: "project-b", sessionId: "session-1", count: 2 });
  });

  test("validates appearance preferences and rejects arbitrary settings at the IPC boundary", () => {
    expect(parseDesktopRequest({ type: "appearance.get" })).toEqual({ type: "appearance.get" });
    for (const theme of ["system", "dark", "light"] as const) {
      expect(parseDesktopRequest({ type: "appearance.set", theme })).toEqual({ type: "appearance.set", theme });
      expect(parseDesktopResponse({ type: "appearance.get" }, { theme })).toEqual({ theme });
      expect(parseDesktopResponse({ type: "appearance.set", theme }, { theme })).toEqual({ theme });
    }
    expect(() => parseDesktopRequest({ type: "appearance.set", theme: "unknown" })).toThrow();
    expect(() => parseDesktopRequest({ type: "appearance.set", theme: "light", path: "/tmp/settings" })).toThrow();
    expect(() => parseDesktopResponse({ type: "appearance.get" }, { theme: "unknown" })).toThrow();
    expect(() => parseDesktopResponse({ type: "appearance.get" }, { theme: "light", path: "/tmp/settings" })).toThrow();
  });

  test("turns the resolved shutdown sentinel into a renderer-local rejection", () => {
    expect(() => parseDesktopInvokeResponse(
      { type: "app.state" },
      DESKTOP_INVOKE_CLOSING_RESPONSE,
    )).toThrow("Desktop is closing");
    expect(() => parseDesktopInvokeResponse(
      { type: "app.state" },
      { ...DESKTOP_INVOKE_CLOSING_RESPONSE, unexpected: true },
    )).toThrow("Unexpected request field: unexpected");
  });

  test("accepts a typed session send request", () => {
    expect(parseDesktopRequest({
      type: "session.send",
      sessionId: "session_1",
      text: "continue",
      mode: "steer",
    })).toEqual({ type: "session.send", sessionId: "session_1", text: "continue", mode: "steer" });
  });

  test("validates the complete New Task and Goal control surface", () => {
    expect(parseDesktopRequest({
      type: "sessions.create",
      title: "Overnight",
      prompt: "finish the release",
      modelSelection: { provider: "openai", model: "gpt-5" },
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionProfile: "auto-review",
      delegationPolicy: "proactive",
      goal: { objective: "finish the release", tokenBudget: 20_000 },
    })).toMatchObject({
      type: "sessions.create",
      goal: { objective: "finish the release", tokenBudget: 20_000 },
    });
    expect(() => parseDesktopRequest({
      type: "sessions.create",
      prompt: "one objective",
      goal: { objective: "different objective" },
    })).toThrow("Goal objective must match");
    expect(() => parseDesktopRequest({
      type: "sessions.create",
      prompt: "work",
      permissionProfile: "unrestricted",
    })).toThrow("unsupported value");
    expect(parseDesktopRequest({
      type: "session.goal.update",
      sessionId: "session_1",
      status: "active",
      tokenBudget: 40_000,
    })).toMatchObject({ status: "active", tokenBudget: 40_000 });
    expect(() => parseDesktopRequest({
      type: "session.goal.update",
      sessionId: "session_1",
    })).toThrow("must change");
  });

  test("exports one shared canonical session title limit", () => {
    expect(SESSION_TITLE_MAX_CHARS).toBe(120);
  });

  test("enforces the runtime's canonical 120-character session title limit", () => {
    const maximumTitle = "x".repeat(SESSION_TITLE_MAX_CHARS);
    const overLimitTitle = `${maximumTitle}x`;

    expect(parseDesktopRequest({
      type: "sessions.create",
      title: maximumTitle,
    })).toMatchObject({ title: maximumTitle });
    expect(parseDesktopRequest({
      type: "session.rename",
      sessionId: "session_1",
      title: maximumTitle,
    })).toMatchObject({ title: maximumTitle });
    expect(() => parseDesktopRequest({
      type: "sessions.create",
      title: overLimitTitle,
    })).toThrow("120");
    expect(() => parseDesktopRequest({
      type: "session.rename",
      sessionId: "session_1",
      title: overLimitTitle,
    })).toThrow("120");
  });

  test("normalizes session title whitespace at the Desktop request boundary", () => {
    expect(parseDesktopRequest({
      type: "sessions.create",
      title: "  Overnight   Goal\nconsole  ",
    })).toMatchObject({ title: "Overnight Goal console" });
    expect(parseDesktopRequest({
      type: "session.rename",
      sessionId: "session_1",
      title: "  Overnight   Goal\nconsole  ",
    })).toMatchObject({ title: "Overnight Goal console" });
    expect(() => parseDesktopRequest({
      type: "sessions.create",
      title: " \n\t ",
    })).toThrow("empty");
  });

  test("validates aggregate desktop session configuration", () => {
    const request = parseDesktopRequest({ type: "session.config.get", sessionId: "session_1" });
    expect(parseDesktopResponse(request, {
      model: {
        sessionId: "session_1",
        availableReasoningLevels: ["low", "high"],
        models: [{ provider: "openai", model: "gpt-5", available: true }],
        modelSelection: { provider: "openai", model: "gpt-5" },
        reasoningLevel: "high",
        serviceTier: "fast",
      },
      permission: {
        profile: "default",
        profiles: [
          { id: "default", label: "Default", description: "Review writes", current: true },
          { id: "auto-review", label: "Auto review", description: "Review risky actions", current: false },
        ],
      },
      delegation: { sessionId: "session_1", policy: "proactive", source: "session" },
      goal: null,
      mcp: {
        servers: [{ name: "github", status: "running", enabled: true, toolCount: 4 }],
        summary: { total: 1, running: 1, disabled: 0, authRequired: 0, errored: 0 },
      },
    })).toMatchObject({
      model: { sessionId: "session_1", reasoningLevel: "high" },
      delegation: { policy: "proactive" },
      goal: null,
      mcp: { summary: { running: 1 } },
    });
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

    const request = parseDesktopRequest({ type: "session.snapshot", sessionId: "session_1" });
    expect(parseDesktopResponse(request, {
      sessionId: "session_1",
      events: [opaqueEvent],
      agents: [{ agentId: "session_child", name: "research", path: "/root/research", parentAgentId: "session_1", state: "idle" }],
      pendingApprovals: [],
      pendingInputs: [],
    })).toMatchObject({
      sessionId: "session_1",
      events: [{ payload: { input: { userId: 42 } } }],
      agents: [{ agentId: "session_child" }],
    });
  });

  test("validates the unified Agent snapshot and rejects old active task shapes", () => {
    const request = parseDesktopRequest({ type: "session.snapshot", sessionId: "session_1" });
    const agent = { agentId: "session_child", name: "research", path: "/root/research", parentAgentId: "session_1", state: "running" };
    const snapshot = { sessionId: "session_1", events: [], agents: [agent], pendingApprovals: [], pendingInputs: [] };
    expect(parseDesktopResponse(request, snapshot)).toMatchObject({ agents: [agent] });
    for (const field of ["agentId", "parentAgentId"]) {
      expect(() => parseDesktopResponse(request, { ...snapshot, agents: [{ ...agent, [field]: "__proto__" }] })).toThrow("prototype property name");
    }
    expect(() => parseDesktopResponse(request, { ...snapshot, agents: [{ ...agent, state: "completed" }] })).toThrow("agent.state");
    expect(() => parseDesktopResponse(request, { ...snapshot, agents: [{ ...agent, taskId: "task_legacy" }] })).toThrow("Unexpected request field");
    expect(() => parseDesktopResponse(request, { ...snapshot, agents: Array(2_001).fill(agent) })).toThrow("snapshot agents");
    expect(() => parseDesktopResponse(request, { ...snapshot, agents: undefined })).toThrow();
    expect(() => parseDesktopResponse(request, { ...snapshot, tasks: [] })).toThrow("Unexpected request field");
    expect(() => parseDesktopResponse(request, { ...snapshot, agentTree: { nodes: [] } })).toThrow("Unexpected request field");
  });

  test("Agent IPC preserves caller scope, input budgets, and exact response identity", () => {
    const request = { type: "agent.send" as const, sessionId: "session_1", agentId: "session_child", text: "Continue the inspection" };
    expect(parseDesktopRequest(request)).toEqual(request);
    expect(parseDesktopRequest({ ...request, mode: "steer", projectId: "project_1" })).toMatchObject({ mode: "steer", projectId: "project_1" });
    expect(() => parseDesktopRequest({ ...request, mode: "start" })).toThrow("mode");
    expect(() => parseDesktopRequest({ ...request, text: "x".repeat(200_001) })).toThrow("200000");
    expect(() => parseDesktopRequest({ ...request, policy: { allowedTools: ["bash"] } })).toThrow("Unexpected request field");
    for (const field of ["sessionId", "agentId"]) {
      expect(() => parseDesktopRequest({ ...request, [field]: "constructor" })).toThrow("prototype property name");
    }
    const parsed = parseDesktopRequest(request);
    expect(parseDesktopResponse(parsed, { agentId: "session_child", inputId: "input_1" })).toEqual({ agentId: "session_child", inputId: "input_1" });
    expect(() => parseDesktopResponse(parsed, { agentId: "session_other", inputId: "input_1" })).toThrow("different agentId");
    expect(() => parseDesktopResponse(parsed, { agentId: "session_child" })).toThrow("inputId");
    expect(() => parseDesktopResponse(parsed, { agentId: "session_child", inputId: "__proto__" })).toThrow("prototype property name");
    for (const type of ["agent.stop", "agent.resume"] as const) {
      const control = parseDesktopRequest({ type, sessionId: "session_1", agentId: "session_child" });
      expect(parseDesktopResponse(control, { agentId: "session_child" })).toEqual({ agentId: "session_child" });
    }
    const stop = parseDesktopRequest({ type: "agent.stop", sessionId: "session_1", agentId: "session_child" });
    expect(() => parseDesktopResponse(stop, { agentId: "session_child", inputId: "input_1" })).toThrow("Unexpected request field");
    const resume = parseDesktopRequest({ type: "agent.resume", sessionId: "session_1", agentId: "session_child" });
    expect(parseDesktopResponse(resume, { agentId: "session_child", inputId: "input_resumed" })).toMatchObject({ inputId: "input_resumed" });
  });

  test("new Session identity and durable input references receive protocol and map-key validation", () => {
    const agent = { parentSessionId: "session_parent", name: "child", path: "/root/child", policy: { writeScope: [] } };
    const created = runtimeEnvelope("session.created", { sessionId: "session_1", cwd: "/repo", agent }, "created_agent");
    expect(parseDesktopEvent({ type: "runtime.event", event: created })).toMatchObject({ event: { payload: { agent } } });
    expect(() => parseDesktopEvent({ type: "runtime.event", event: { ...created, payload: { ...created.payload, agent: { ...agent, parentSessionId: "__proto__" } } } })).toThrow("prototype property name");
    expect(() => parseDesktopEvent({ type: "runtime.event", event: { ...created, payload: { ...created.payload, agent: { ...agent, policy: { allowSubagentSessions: true } } } } })).toThrow();
    const receipt = { inputId: "input_1", submissionId: "submission_1", sessionId: "session_1", mode: "queue", state: "settled", revision: 3, sequence: 1, text: "inspect", acceptedAt: 1, updatedAt: 2, outcome: "completed", resultMessageId: "message_result" };
    const queue = { sessionId: "session_1", paused: false, revision: 3, pendingCount: 0, interruptedCount: 0, items: [receipt] };
    const queueEvent = runtimeEnvelope("session.input_queue_changed", queue, "queue_event");
    expect(parseDesktopEvent({ type: "runtime.event", event: queueEvent })).toMatchObject({ event: { payload: queue } });
    expect(() => parseDesktopEvent({ type: "runtime.event", event: { ...queueEvent, payload: { ...queue, items: [{ ...receipt, resultMessageId: "constructor" }] } } })).toThrow("prototype property name");
    expect(() => parseDesktopEvent({ type: "runtime.event", event: { ...queueEvent, payload: { ...queue, items: [{ ...receipt, sessionId: "session_other" }] } } })).toThrow();
  });

  test("historical Team events remain readable without the old live task snapshot", () => {
    const historical = runtimeEnvelope("team.task_updated", { teamId: "team_old", taskId: "task_old", status: "completed" }, "historical_team");
    const request = parseDesktopRequest({ type: "session.snapshot", sessionId: "session_1" });
    expect(parseDesktopResponse(request, { sessionId: "session_1", events: [historical], agents: [], pendingApprovals: [], pendingInputs: [] })).toMatchObject({ events: [historical], agents: [] });
  });

  test("validates authoritative pending approvals without requiring event anchors", () => {
    const request = parseDesktopRequest({ type: "session.snapshot", sessionId: "session_1" });
    const snapshot = {
      sessionId: "session_1",
      events: [],
      agents: [],
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
      agents: [],
      pendingApprovals: [],
      pendingInputs: [],
    })).not.toThrow();
    expect(presentSession({
      sessionId: "session_1",
      events,
      agents: [],
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
    expect(parseDesktopResponse(request, {
      sessionId: "session_1",
      status: "created",
      startState: "not_started",
      started: false,
    })).toEqual({ sessionId: "session_1", status: "created", startState: "not_started", started: false });
    expect(() => parseDesktopResponse(request, {
      sessionId: "",
      status: "created",
      startState: "not_started",
      started: false,
    })).toThrow("must not be empty");
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
