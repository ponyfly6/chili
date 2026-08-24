import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  AgentPath,
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  PartId,
  RuntimeModelDescriptor,
  SessionId,
  TaskId,
  TeamId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import { SqliteEventStore, type ApprovalRow, type EventQuery, type EventStore, type SessionRow } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import type { AgentRunner, AppendUserMessageInput, CreateSessionInput, RunTurnInput, RunTurnResult } from "./runner.js";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";
import {
  RuntimeBusyError,
  RuntimeSessionNotFoundError,
  RuntimeService,
  RuntimeSubagentSessionAccessError,
} from "./runtime-service.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

test("RuntimeService accepts an AgentRunner implementation", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_fake" as SessionId;
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: () => [
      {
        id: "test.base",
        layer: "base",
        source: "core",
        priority: 0,
        lifecycle: "turn",
        trust: "system",
        content: "be brief",
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const handle = await service.createSession({
    cwd: "/workspace",
  });
  store.addSession(handle.sessionId, "interactive", "/workspace");
  const result = await service.submitPrompt({
    sessionId: handle.sessionId,
    text: "hello",
    cwd: "/workspace",
  });

  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    expect(result.finishReason).toBe("stop");
  }
  expect(handle).toEqual({ sessionId });
  expect(runner.createInputs[0]).toEqual({
    cwd: "/workspace",
  });
  expect(runner.userMessages[0]).toMatchObject({
    sessionId,
    text: "hello",
  });
  expect(runner.userMessages[0]?.turnId).toBe(runner.turnInputs[0]?.turnId);
  expect(runner.turnInputs[0]?.cwd).toBe("/workspace");
  expect(runner.turnInputs[0]?.system).toEqual(["be brief"]);
  expect(runner.turnInputs[0]?.signal?.aborted).toBe(false);
  expect(statuses(store)).toEqual(["idle", "running", "idle"]);
});

test("root RuntimeService rejects direct subagent turns while an explicit child service remains usable", async () => {
  const sessionId = "session_guarded_child" as SessionId;
  const store = new SessionSourceEventStore({
    id: sessionId,
    cwd: "/repo",
    source: "subagent",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  });
  const rootRunner = new FakeAgentRunner();
  const root = new RuntimeService({ runtime: rootRunner, store, cwd: "/repo" });
  const input = { sessionId, text: "bypass child policy" };

  await expect(root.submitPrompt(input)).rejects.toBeInstanceOf(RuntimeSubagentSessionAccessError);
  const asyncError = new Promise<unknown>((resolve) => {
    root.submitPromptAsync({ ...input, text: "async bypass" }, resolve);
  });
  await expect(asyncError).resolves.toBeInstanceOf(RuntimeSubagentSessionAccessError);
  expect(root.isRunning(sessionId)).toBe(false);
  await expect(root.appendUserMessage(input)).rejects.toThrow("Use task_followup for the owning task");
  await expect(root.compactSession({ sessionId })).rejects.toBeInstanceOf(
    RuntimeSubagentSessionAccessError,
  );
  await expect(root.setGoal({ sessionId, objective: "bypass through goal continuation" })).rejects.toBeInstanceOf(
    RuntimeSubagentSessionAccessError,
  );
  expect(rootRunner.userMessages).toEqual([]);
  expect(rootRunner.turnInputs).toEqual([]);

  const childRunner = new FakeAgentRunner();
  const child = new RuntimeService({
    runtime: childRunner,
    store,
    cwd: "/repo",
    allowSubagentSessions: true,
  });
  await expect(child.submitPrompt({ ...input, text: "authorized child continuation" })).resolves.toMatchObject({
    status: "completed",
  });
  expect(childRunner.userMessages).toHaveLength(1);
  expect(childRunner.turnInputs).toHaveLength(1);
});

test("RuntimeService rejects a pending child before its session row exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-pending-child-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_guard_pending_parent" as SessionId;
  const childSessionId = "session_guard_pending_child" as SessionId;
  const runner = new FakeAgentRunner();

  try {
    await store.append({
      id: "event_guard_pending_task",
      type: "agent.task_created",
      time: 1 as TimestampMs,
      sessionId: parentSessionId,
      payload: {
        taskId: "task_guard_pending_child" as TaskId,
        path: "/root/pending-child" as AgentPath,
        parentPath: "/root" as AgentPath,
        parentSessionId,
        childSessionId,
        taskName: "pending child",
        cwd: "/repo",
        prompt: "wait for a lifecycle permit",
        mode: "background",
      },
    });
    expect(await store.sessions()).toEqual([]);

    const root = new RuntimeService({ runtime: runner, store, cwd: "/repo" });
    const input = { sessionId: childSessionId, text: "race the pending child" };
    await expect(root.submitPrompt(input)).rejects.toBeInstanceOf(RuntimeSubagentSessionAccessError);
    const asyncError = new Promise<unknown>((resolve) => {
      root.submitPromptAsync({ ...input, text: "race asynchronously" }, resolve);
    });
    await expect(asyncError).resolves.toBeInstanceOf(RuntimeSubagentSessionAccessError);

    expect(root.isRunning(childSessionId)).toBe(false);
    expect(runner.userMessages).toEqual([]);
    expect(runner.turnInputs).toEqual([]);
    expect((await store.agentTasks({ childSessionId }))[0]).toMatchObject({ status: "pending" });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RuntimeService rejects team sessions before their session rows exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-runtime-pending-team-worker-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const rootSessionId = "session_guard_team_root" as SessionId;
  const workerSessionId = "session_guard_team_worker" as SessionId;
  const teamId = "team_guard_pending_worker" as TeamId;
  const runner = new FakeAgentRunner();

  try {
    await store.appendMany([
      {
        id: "event_guard_pending_team",
        type: "team.created",
        time: 1 as TimestampMs,
        sessionId: rootSessionId,
        payload: { teamId, name: "pending worker guard", leadPath: "/root" as AgentPath },
      },
      {
        id: "event_guard_pending_team_lead",
        type: "team.member_added",
        time: 2 as TimestampMs,
        sessionId: rootSessionId,
        payload: {
          teamId,
          path: "/root" as AgentPath,
          name: "lead",
          role: "leader",
          childSessionId: rootSessionId,
        },
      },
      {
        id: "event_guard_pending_team_worker",
        type: "team.member_added",
        time: 3 as TimestampMs,
        sessionId: rootSessionId,
        payload: {
          teamId,
          path: "/root/worker" as AgentPath,
          name: "worker",
          role: "implementer",
          childSessionId: workerSessionId,
        },
      },
    ]);
    expect(await store.sessions()).toEqual([]);

    const root = new RuntimeService({ runtime: runner, store, cwd: "/repo" });
    await expect(root.assertSessionTurnAllowed(rootSessionId)).rejects.toBeInstanceOf(RuntimeSessionNotFoundError);
    await expect(root.submitPrompt({
      sessionId: workerSessionId,
      text: "race the team worker",
    })).rejects.toBeInstanceOf(RuntimeSubagentSessionAccessError);

    expect(runner.userMessages).toEqual([]);
    expect(runner.turnInputs).toEqual([]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RuntimeService rejects an unknown session without writing orphan events", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({ runtime: runner, store, cwd: "/repo" });
  const sessionId = "session_unknown" as SessionId;

  await expect(service.submitPrompt({ sessionId, text: "do not persist this" })).rejects.toBeInstanceOf(
    RuntimeSessionNotFoundError,
  );

  expect(store.items).toEqual([]);
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
  expect(service.isRunning(sessionId)).toBe(false);
});

test("RuntimeService preserves safe model connection metadata", async () => {
  const service = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store: new MemoryEventStore(),
    cwd: "/repo",
    models: [
      {
        provider: "codex-api",
        model: "gpt-5.6-sol",
        connectionLabel: "Codex API",
        authSource: "environment",
        endpoint: "https://gateway.example",
      },
    ],
  });

  expect(await service.listModels()).toEqual([
    {
      provider: "codex-api",
      model: "gpt-5.6-sol",
      connectionLabel: "Codex API",
      authSource: "environment",
      endpoint: "https://gateway.example",
    },
  ]);
});

test("RuntimeService rejects prompt images for text-only models before appending user messages", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_text_only_image" as SessionId);
  const runner = new FakeAgentRunner();
  const model = textOnlyModel();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    models: [model],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_text_only_image" as SessionId,
    text: "[Image #1] what is this?",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
    modelSelection: { provider: model.provider, model: model.model },
  });

  expect(result.status).toBe("failed");
  if (result.status === "completed") throw new Error("expected prompt to fail");
  expect(result.error?.message).toContain("does not support image input");
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
  expect(statuses(store)).toEqual(["failed"]);
});

test("RuntimeService converts sourced prompt images to tool-readable text for text-only models", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_text_only_image_path" as SessionId);
  const runner = new FakeAgentRunner();
  const model = textOnlyModel();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    models: [model],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_text_only_image_path" as SessionId,
    text: "[Image #1] what is this?",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png", sourcePath: ".chili/clipboard-images/paste.png" }],
    modelSelection: { provider: model.provider, model: model.model },
  });

  expect(result.status).toBe("completed");
  expect(runner.userMessages).toHaveLength(1);
  expect(runner.userMessages[0]?.text).toContain("[Image #1] what is this?");
  expect(runner.userMessages[0]?.text).toContain("<pasted_image_files>");
  expect(runner.userMessages[0]?.text).toContain("path=.chili/clipboard-images/paste.png");
  expect(runner.userMessages[0]?.text).toContain("absolutePath=/repo/.chili/clipboard-images/paste.png");
  expect(runner.userMessages[0]?.displayText).toBe("[Image #1] what is this?");
  expect(runner.userMessages[0]?.images).toBeUndefined();
  expect(runner.turnInputs).toHaveLength(1);
  expect(runner.turnInputs[0]?.preferExternalImageTools).toBe(true);
  expect(runner.turnInputs[0]?.system?.some((item) => item.includes("pasted image file path"))).toBe(true);
  expect(runner.turnInputs[0]?.promptDebug?.fragments).toContainEqual(expect.objectContaining({
    id: "runtime.path_image_input",
  }));
  expect(statuses(store)).toEqual(["running", "idle"]);
});

test("RuntimeService prefers direct image input over external image tools for image-capable turns", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_direct_image" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_direct_image" as SessionId,
    text: "[Image #1] what is this?",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png", sourcePath: ".chili/clipboard-images/paste.png" }],
  });

  expect(result.status).toBe("completed");
  expect(runner.userMessages[0]?.images).toHaveLength(1);
  expect(runner.turnInputs[0]?.suppressExternalImageTools).toBe(true);
  expect(runner.turnInputs[0]?.system?.some((item) => item.includes("direct image attachment"))).toBe(true);
  expect(runner.turnInputs[0]?.promptDebug?.fragments).toContainEqual(expect.objectContaining({
    id: "runtime.direct_image_input",
    metadata: { imageCount: 1 },
  }));
});

test("RuntimeService allows external image tools when the prompt explicitly asks for tools", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_direct_image_tool" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_direct_image_tool" as SessionId,
    text: "[Image #1] 用 MCP 工具识别",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png", sourcePath: ".chili/clipboard-images/paste.png" }],
  });

  expect(result.status).toBe("completed");
  expect(runner.turnInputs[0]?.suppressExternalImageTools).toBeUndefined();
});

test("RuntimeService allows text-only model turns when retained tool history contains image content", async () => {
  const sessionId = "session_text_only_tool_image" as SessionId;
  const callId = "call_read_image" as ToolCallId;
  const store = new MemoryEventStore();
  store.addSession(sessionId);
  store.messageRows.push({
    id: "msg_tool_result_image_history" as MessageId,
    sessionId,
    role: "user",
    createdAt: 1 as TimestampMs,
    parts: [
      {
        id: "part_tool_result_image_history" as PartId,
        messageId: "msg_tool_result_image_history" as MessageId,
        sessionId,
        type: "tool_result",
        callId,
        output: "MCP read image result text\n[image image/png 6 bytes]",
        content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      },
    ],
  });
  const runner = new FakeAgentRunner();
  const model = textOnlyModel();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    models: [model],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId,
    text: "hi",
    modelSelection: { provider: model.provider, model: model.model },
  });

  expect(result.status).toBe("completed");
  expect(runner.userMessages).toHaveLength(1);
  expect(runner.turnInputs).toHaveLength(1);
});

test("RuntimeService passes promptFragments by prompt layer", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_prompt_layers" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: () => [
      {
        id: "base",
        layer: "base",
        source: "core",
        priority: 0,
        lifecycle: "stable",
        trust: "system",
        content: "base system",
      },
      {
        id: "skills",
        layer: "developer",
        source: "skills",
        priority: 10,
        lifecycle: "session",
        trust: "tool",
        content: "skills catalog",
      },
      {
        id: "memory",
        layer: "contextual_user",
        source: "memory",
        priority: 10,
        lifecycle: "session",
        trust: "user",
        content: "memory context",
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_prompt_layers" as SessionId,
    text: "hello",
  });

  expect(result.status).toBe("completed");
  expect(runner.turnInputs[0]?.system).toEqual(["base system"]);
  expect(runner.turnInputs[0]?.developer?.[0]).toBe("skills catalog");
  expect(runner.turnInputs[0]?.developer?.[1]).toContain("Delegation policy is explicit");
  expect(runner.turnInputs[0]?.contextualUser).toEqual(["memory context"]);
  expect(runner.turnInputs[0]?.promptDebug?.fragments.map((fragment) => [fragment.id, fragment.source, fragment.layer])).toEqual([
    ["base", "core", "base"],
    ["skills", "skills", "developer"],
    ["chili.delegation.explicit", "runtime", "developer"],
    ["memory", "memory", "contextual_user"],
  ]);
});

test("RuntimeService passes current turn text and skill mentions to prompt fragments", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_skill_turn" as SessionId);
  const runner = new FakeAgentRunner();
  const observed: unknown[] = [];
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: (input) => {
      observed.push(input.turn);
      return input.turn?.skillMentions?.length
        ? [
            {
              id: "chili.skill.reviewer",
              layer: "contextual_user",
              source: "skills",
              priority: 30,
              lifecycle: "turn",
              trust: "tool",
              content: `skill for ${input.turn.text}`,
            },
          ]
        : [];
    },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId: "session_skill_turn" as SessionId,
    text: "use $reviewer",
    skillMentions: [{ name: "reviewer", path: "/repo/.chili/skills/reviewer/SKILL.md" }],
  });

  expect(result.status).toBe("completed");
  expect(observed).toEqual([
    {
      text: "use $reviewer",
      skillMentions: [{ name: "reviewer", path: "/repo/.chili/skills/reviewer/SKILL.md" }],
    },
  ]);
  expect(runner.turnInputs[0]?.contextualUser).toEqual(["skill for use $reviewer"]);
  expect(runner.turnInputs[0]?.promptDebug?.fragments).toContainEqual(expect.objectContaining({
    id: "chili.skill.reviewer",
    lifecycle: "turn",
  }));
});

test("RuntimeService assembles turn prompt after appending submitted user message", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_prompt_after_append" as SessionId;
  store.addSession(sessionId);
  const observedUserMessages: AppendUserMessageInput[][] = [];
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: () => {
      observedUserMessages.push([...runner.userMessages]);
      return [
        {
          id: "runtime.latest_user_message",
          layer: "contextual_user",
          source: "runtime",
          priority: 0,
          lifecycle: "turn",
          trust: "user",
          content: `latest user: ${runner.userMessages.at(-1)?.text ?? "missing"}`,
        },
      ];
    },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const result = await service.submitPrompt({
    sessionId,
    text: "what changed?",
  });

  expect(result.status).toBe("completed");
  expect(observedUserMessages[0]?.[0]).toMatchObject({
    sessionId,
    text: "what changed?",
  });
  expect(runner.turnInputs[0]?.contextualUser).toEqual(["latest user: what changed?"]);
});

test("RuntimeService inspectPrompt includes conversation context as a prompt fragment", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_prompt_conversation" as SessionId;
  store.messageRows.push(textMessage({
    id: "msg_existing_user" as MessageId,
    sessionId,
    role: "user",
    text: "existing request",
  }));
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: () => [
      {
        id: "debug.base",
        layer: "base",
        source: "core",
        priority: 0,
        lifecycle: "stable",
        trust: "system",
        content: "base instructions",
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const inspected = await service.inspectPrompt({
    sessionId,
    cwd: "/repo",
    text: "current turn",
    includeContent: true,
  });

  const conversation = inspected.fragments.find((fragment) => fragment.layer === "conversation");
  expect(inspected.debug.fragments.map((fragment) => fragment.layer)).toEqual(["base", "developer", "conversation"]);
  expect(conversation).toMatchObject({
    id: "runtime.conversation",
    source: "runtime",
    lifecycle: "turn",
    metadata: {
      kind: "conversation_context",
      messageCount: 2,
    },
  });
  expect(conversation?.content).toContain("existing request");
  expect(conversation?.content).toContain("current turn");
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
});

test("RuntimeService injects proactive delegation guidance for ultra reasoning", async () => {
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store: new MemoryEventStore(),
    cwd: "/repo",
    defaultReasoningLevel: "ultra",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const inspected = await service.inspectPrompt({
    sessionId: "session_ultra_prompt" as SessionId,
    cwd: "/repo",
    includeContent: true,
  });

  expect(inspected.fragments.find((fragment) => fragment.id === "chili.delegation.proactive")).toMatchObject({
    layer: "developer",
    lifecycle: "turn",
    metadata: { policy: "proactive" },
  });
  expect(inspected.fragments.find((fragment) => fragment.id === "chili.delegation.proactive")?.content).toContain(
    "Proactively delegate",
  );
});

test("RuntimeService applies session delegation policy independently of model reasoning support", async () => {
  const store = new MemoryEventStore();
  const sessionId = "session_delegation_policy" as SessionId;
  const service = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "minimax", model: "MiniMax-M3[1m]" },
    models: [{
      provider: "minimax",
      model: "MiniMax-M3[1m]",
      default: true,
      capabilities: { reasoning: false, toolCalls: true },
      reasoningLevels: [],
    }],
    defaultDelegationPolicy: "proactive",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  expect(await service.getDelegationConfig(sessionId)).toEqual({
    sessionId,
    policy: "proactive",
    source: "default",
  });
  const proactive = await service.inspectPrompt({ sessionId, cwd: "/repo", includeContent: true });
  expect(proactive.fragments.some((fragment) => fragment.id === "chili.delegation.proactive")).toBe(true);

  expect(await service.setDelegationPolicy({ sessionId, policy: "off" })).toEqual({
    sessionId,
    policy: "off",
    source: "session",
  });
  expect((await store.events({ sessionId, type: "session.delegation_changed" })).at(-1)?.payload).toEqual({
    sessionId,
    policy: "off",
  });

  const resumed = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    defaultDelegationPolicy: "proactive",
  });
  expect(await resumed.getDelegationConfig(sessionId)).toEqual({
    sessionId,
    policy: "off",
    source: "session",
  });
  const disabled = await resumed.inspectPrompt({ sessionId, cwd: "/repo", includeContent: true });
  expect(disabled.fragments.find((fragment) => fragment.id === "chili.delegation.off")?.content).toContain(
    "Do not spawn",
  );
});

test("RuntimeService reports model-specific advanced reasoning levels", async () => {
  const store = new MemoryEventStore();
  const service = new RuntimeService({
    runtime: new FakeAgentRunner(),
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "openai-codex", model: "gpt-5.6-sol" },
    defaultReasoningLevel: "ultra",
    models: [
      {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        default: true,
        reasoningLevels: ["off", "low", "medium", "high", "xhigh", "max", "ultra"],
      },
      {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        reasoningLevels: ["off", "low", "medium", "high", "xhigh", "max"],
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_reasoning_levels" as SessionId;

  const solConfig = await service.getModelConfig(sessionId);
  expect(solConfig.availableReasoningLevels).toEqual([
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  expect(solConfig.reasoningLevel).toBe("ultra");
  const lunaConfig = await service.setModel({
    sessionId,
    modelSelection: { provider: "openai-codex", model: "gpt-5.6-luna" },
  });
  expect(lunaConfig.availableReasoningLevels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  expect(lunaConfig.reasoningLevel).toBe("max");
  expect((await store.events({ sessionId, type: "session.reasoning_changed" })).at(-1)?.payload).toMatchObject({
    reasoningLevel: "max",
  });

  const requestedUltra = await service.setReasoning({
    sessionId,
    reasoningLevel: "ultra",
  });
  expect(requestedUltra.reasoningLevel).toBe("max");

  const inspected = await service.inspectPrompt({ sessionId, cwd: "/repo", includeContent: true });
  expect(inspected.fragments.some((fragment) => fragment.id === "chili.delegation.proactive")).toBe(false);
  expect(inspected.fragments.some((fragment) => fragment.id === "chili.delegation.explicit")).toBe(true);
});

test("RuntimeService clears and rejects controls unsupported by a known model", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "minimax", model: "MiniMax-M3[1m]" },
    defaultReasoningLevel: "high",
    defaultServiceTier: "fast",
    models: [
      {
        provider: "minimax",
        model: "MiniMax-M3[1m]",
        default: true,
        reasoningLevels: [],
      },
      {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningLevels: ["off", "low", "medium", "high"],
        serviceTiers: ["standard", "fast"],
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_unsupported_model_controls" as SessionId;
  store.addSession(sessionId);

  const minimaxConfig = await service.getModelConfig(sessionId);
  expect(minimaxConfig.availableReasoningLevels).toEqual([]);
  expect(minimaxConfig.reasoningLevel).toBeUndefined();
  expect(minimaxConfig.serviceTier).toBeUndefined();
  const minimaxPrompt = await service.submitPrompt({
    sessionId,
    text: "hello from MiniMax",
  });
  expect(minimaxPrompt.status).toBe("completed");
  expect(runner.turnInputs[0]?.modelSelection).toEqual({ provider: "minimax", model: "MiniMax-M3[1m]" });
  expect(runner.turnInputs[0]?.reasoningLevel).toBeUndefined();
  expect(runner.turnInputs[0]?.serviceTier).toBeUndefined();
  await expect(service.setReasoning({ sessionId, reasoningLevel: "high" })).rejects.toThrow(
    "does not support configurable reasoning",
  );
  await expect(service.setServiceTier({ sessionId, serviceTier: "fast" })).rejects.toThrow(
    "does not support service tier fast",
  );

  await service.setModel({
    sessionId,
    modelSelection: { provider: "openai-codex", model: "gpt-5.6-sol" },
  });
  const reasoningConfig = await service.setReasoning({ sessionId, reasoningLevel: "high" });
  const serviceTierConfig = await service.setServiceTier({ sessionId, serviceTier: "fast" });
  expect(reasoningConfig.reasoningLevel).toBe("high");
  expect(serviceTierConfig.serviceTier).toBe("fast");

  await service.setModel({
    sessionId,
    modelSelection: { provider: "custom", model: "future-model" },
  });
  await expect(service.setServiceTier({ sessionId, serviceTier: "fast" })).rejects.toThrow(
    "does not support service tier fast",
  );
});

test("RuntimeService inspectPrompt only assembles prompt debug output", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: ({ cwd }) => [
      {
        id: "debug.base",
        layer: "base",
        source: "core",
        priority: 0,
        lifecycle: "stable",
        trust: "system",
        content: "base instructions",
      },
      {
        id: "debug.project",
        layer: "contextual_user",
        source: "project",
        priority: 100,
        lifecycle: "session",
        trust: "project",
        content: "project instructions",
        metadata: {
          path: `${cwd}/AGENTS.md`,
          kind: "project_instruction",
          scope: "project",
          truncated: false,
        },
      },
      {
        id: "debug.skills",
        layer: "developer",
        source: "skills",
        priority: 50,
        lifecycle: "session",
        trust: "tool",
        content: "skills catalog",
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const debug = await service.inspectPrompt({
    sessionId: "session_prompt_debug" as SessionId,
    cwd: "/repo/app",
  });

  expect(debug.fragments.map((fragment) => [fragment.id, fragment.layer, fragment.source])).toEqual([
    ["debug.base", "base", "core"],
    ["chili.delegation.explicit", "developer", "runtime"],
    ["debug.skills", "developer", "skills"],
    ["debug.project", "contextual_user", "project"],
  ]);
  expect(debug.fragments[0]).not.toHaveProperty("content");
  expect(debug.fragments.find((fragment) => fragment.id === "debug.project")?.metadata).toMatchObject({
    path: "/repo/app/AGENTS.md",
    kind: "project_instruction",
    scope: "project",
    truncated: false,
  });
  expect(debug.totalChars).toBe(
    "base instructions".length
      + "skills catalog".length
      + "project instructions".length
      + debug.fragments.find((fragment) => fragment.id === "chili.delegation.explicit")!.chars,
  );
  expect(runner.createInputs).toEqual([]);
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
  expect(store.items).toEqual([]);
});

test("RuntimeService inspectPrompt only returns fragment content when requested", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    promptFragments: () => [
      {
        id: "debug.content",
        layer: "base",
        source: "core",
        priority: 0,
        lifecycle: "turn",
        trust: "system",
        content: "visible only with content flag",
      },
    ],
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  const debug = await service.inspectPrompt({
    sessionId: "session_prompt_debug_no_content" as SessionId,
    cwd: "/repo",
    includeContent: false,
  });
  const withContent = await service.inspectPrompt({
    sessionId: "session_prompt_debug_content" as SessionId,
    cwd: "/repo",
    includeContent: true,
  });

  expect(debug.fragments[0]).not.toHaveProperty("content");
  expect(withContent.debug.fragments[0]).not.toHaveProperty("content");
  expect(withContent.fragments[0]?.content).toBe("visible only with content flag");
  expect(runner.createInputs).toEqual([]);
  expect(runner.userMessages).toEqual([]);
  expect(runner.turnInputs).toEqual([]);
  expect(store.items).toEqual([]);
});

test("RuntimeService clears running reservation when initial running status write fails with a fake runner", async () => {
  const store = new ThrowingStatusStore();
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_status_failure" as SessionId;
  store.addSession(sessionId);

  await expect(
    service.submitPrompt({
      sessionId,
      text: "hello",
    }),
  ).rejects.toThrow("status write failed");
  expect(service.isRunning(sessionId)).toBe(false);
  expect(runner.userMessages).toHaveLength(0);
});

test("RuntimeService reserves busy sessions before the runner reaches runTurn", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const gate = deferred<void>();
  runner.runTurnWait = gate.promise;
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const sessionId = "session_busy" as SessionId;
  store.addSession(sessionId);

  const first = service.submitPrompt({
    sessionId,
    text: "first",
  });

  expect(service.isRunning(sessionId)).toBe(true);
  await expect(
    service.submitPrompt({
      sessionId,
      text: "second",
    }),
  ).rejects.toThrow(RuntimeBusyError);
  expect(() =>
    service.submitPromptAsync({
      sessionId,
      text: "third",
    }),
  ).toThrow(RuntimeBusyError);

  gate.resolve();
  const result = await first;

  expect(result.status).toBe("completed");
  expect(service.isRunning(sessionId)).toBe(false);
  expect(runner.userMessages).toHaveLength(1);
});

test("RuntimeService continues after OpenAI-compatible tool_calls finish reason", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_tool_calls" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.onRunTurn = async () => {
    const turnNumber = runner.turnInputs.length;
    runner.runTurnResult = {
      status: "completed",
      turnId: `turn_${turnNumber}` as TurnId,
      assistantMessageId: `message_assistant_${turnNumber}` as MessageId,
      finishReason: turnNumber === 1 ? "tool_calls" : "stop",
    };
  };

  const result = await service.submitPrompt({
    sessionId: "session_tool_calls" as SessionId,
    text: "use a tool",
    maxTurns: 3,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("stop");
  expect(runner.turnInputs).toHaveLength(2);
  expect(statuses(store)).toEqual(["running", "idle"]);
});

test("RuntimeService adds a no-tool final turn after the tool continuation limit", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_final_after_tools" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.onRunTurn = async () => {
    const turnNumber = runner.turnInputs.length;
    runner.runTurnResult = {
      status: "completed",
      turnId: `turn_${turnNumber}` as TurnId,
      assistantMessageId: `message_assistant_${turnNumber}` as MessageId,
      finishReason: turnNumber <= 2 ? "tool_use" : "stop",
    };
  };

  const result = await service.submitPrompt({
    sessionId: "session_final_after_tools" as SessionId,
    text: "inspect deeply",
    maxTurns: 2,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("stop");
  expect(runner.turnInputs).toHaveLength(3);
  expect(runner.turnInputs[2]?.toolMode).toBe("disabled");
  expect(runner.turnInputs[2]?.system?.at(-1)).toContain("Do not call tools");
  expect(statuses(store)).toEqual(["running", "idle"]);
});

test("RuntimeService uses the last persisted model config for new sessions", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const firstService = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "minimax", model: "MiniMax-M2.7" },
    defaultReasoningLevel: "medium",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });

  await firstService.setModel({
    sessionId: "session_previous" as SessionId,
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
  });
  await firstService.setReasoning({
    sessionId: "session_previous" as SessionId,
    reasoningLevel: "high",
  });
  await firstService.setServiceTier({
    sessionId: "session_previous" as SessionId,
    serviceTier: "fast",
  });

  const nextRunner = new FakeAgentRunner();
  const nextService = new RuntimeService({
    runtime: nextRunner,
    store,
    cwd: "/repo",
    defaultModelSelection: { provider: "minimax", model: "MiniMax-M2.7" },
    defaultReasoningLevel: "medium",
    createId: createSequentialId(),
    now: () => 2 as TimestampMs,
  });

  await nextService.createSession({
    sessionId: "session_next" as SessionId,
  });
  store.addSession("session_next" as SessionId);
  const config = await nextService.getModelConfig("session_next" as SessionId);
  expect(config.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  expect(config.reasoningLevel).toBe("high");
  expect(config.serviceTier).toBe("fast");

  const result = await nextService.submitPrompt({
    sessionId: "session_next" as SessionId,
    text: "hello",
  });

  expect(result.status).toBe("completed");
  expect(nextRunner.turnInputs[0]?.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  expect(nextRunner.turnInputs[0]?.reasoningLevel).toBe("high");
  expect(nextRunner.turnInputs[0]?.serviceTier).toBe("fast");
});

test("RuntimeService still stops on Anthropic-style end_turn finish reason", async () => {
  const store = new MemoryEventStore();
  store.addSession("session_end_turn" as SessionId);
  const runner = new FakeAgentRunner();
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.runTurnResult = {
    status: "completed",
    turnId: "turn_end_turn" as TurnId,
    assistantMessageId: "message_assistant_end_turn" as MessageId,
    finishReason: "end_turn",
  };

  const result = await service.submitPrompt({
    sessionId: "session_end_turn" as SessionId,
    text: "answer directly",
    maxTurns: 3,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("end_turn");
  expect(runner.turnInputs).toHaveLength(1);
  expect(statuses(store)).toEqual(["running", "idle"]);
});

test("RuntimeService stops before another tool-use turn when interrupted", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_interrupt_loop" as SessionId;
  store.addSession(sessionId);
  const service = new RuntimeService({
    runtime: runner,
    store,
    cwd: "/repo",
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  runner.runTurnResult = {
    status: "completed",
    turnId: "turn_tool_use" as TurnId,
    assistantMessageId: "message_assistant_tool_use" as MessageId,
    finishReason: "tool_use",
  };
  runner.onRunTurn = async () => {
    await service.interrupt(sessionId, "complete_task");
  };

  const result = await service.submitPrompt({
    sessionId,
    text: "finish by tool",
    maxTurns: 3,
  });

  expect(result.status).toBe("cancelled");
  expect(runner.turnInputs).toHaveLength(1);
  expect(statuses(store)).toEqual(["running", "cancelling", "cancelled"]);
  const cancelling = store.items.find(
    (event) => event.type === "session.status_changed" && event.payload.status === "cancelling",
  );
  expect(cancelling?.sessionId).toBe(sessionId);
});

test("SingleAgentRuntime satisfies AgentRunner without changing aborted turn behavior", async () => {
  const store = new MemoryEventStore();
  const registry = new InMemoryToolRegistry();
  let modelCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelCalls++;
      expect(input.signal?.aborted).toBe(true);
      throw abortError("provider aborted");
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    retryPolicy: { maxAttempts: 3, initialDelayMs: 0 },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
  const runner: AgentRunner = runtime;
  const controller = new AbortController();
  controller.abort();

  const result = await runner.runTurn({
    sessionId: "session_abort" as SessionId,
    cwd: "/repo",
    signal: controller.signal,
  });

  expect(result.status).toBe("cancelled");
  expect(modelCalls).toBe(1);
  expect(store.items.some((event) => event.type === "turn.retry_scheduled")).toBe(false);
});

test("RuntimeService excludes cancelled prompt with no assistant output from subsequent model context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-core-cancelled-prompt-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const registry = new InMemoryToolRegistry();
  const createId = createSequentialId();
  let now = 0;
  const modelInputs: ModelStreamInput[] = [];
  const firstCallStarted = deferred<void>();
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelInputs.push(input);
      if (modelInputs.length === 1) {
        firstCallStarted.resolve();
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) {
            resolve();
            return;
          }
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw abortError("provider aborted");
      }
      yield { type: "text_delta", text: "ok" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    createId,
    now: () => ++now as TimestampMs,
  });
  const service = new RuntimeService({
    runtime,
    store,
    cwd: "/repo",
    createId,
    now: () => ++now as TimestampMs,
  });
  const sessionId = "session_cancelled_prompt_context" as SessionId;

  try {
    await service.createSession({ sessionId });
    const cancelled = service.submitPrompt({
      sessionId,
      text: "理解一下这个幕落",
    });
    await firstCallStarted.promise;
    await service.interrupt(sessionId, "user_interrupt");

    const cancelledResult = await cancelled;
    expect(cancelledResult.status).toBe("cancelled");

    const completedResult = await service.submitPrompt({
      sessionId,
      text: "理解一下这个目录",
    });

    expect(completedResult.status).toBe("completed");
    expect(modelInputs).toHaveLength(2);
    const secondContext = messageTextContent(modelInputs[1]?.messages ?? []);
    expect(secondContext).not.toContain("理解一下这个幕落");
    expect(secondContext).toContain("理解一下这个目录");

    const transcriptText = messageTextContent(await store.messages(sessionId));
    expect(transcriptText).toContain("理解一下这个幕落");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RuntimeService persists encrypted reasoning output into the next turn context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-core-reasoning-output-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const registry = new InMemoryToolRegistry();
  const createId = createSequentialId();
  let now = 0;
  const modelInputs: ModelStreamInput[] = [];
  const modelOutput = {
    apiFamily: "openai-responses",
    outputIndex: 0,
    item: {
      id: "reasoning_persisted",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Checked the repository." }],
      status: "completed",
      encrypted_content: "complete-ciphertext",
      provider_extension: { retained: true },
    },
  } as const;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelInputs.push(input);
      if (modelInputs.length === 1) {
        yield { type: "reasoning_item", output: modelOutput };
        yield { type: "text_delta", text: "First answer." };
      } else {
        yield { type: "text_delta", text: "Second answer." };
      }
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    createId,
    now: () => ++now as TimestampMs,
  });
  const service = new RuntimeService({
    runtime,
    store,
    cwd: "/repo",
    createId,
    now: () => ++now as TimestampMs,
  });
  const sessionId = "session_reasoning_output_context" as SessionId;

  try {
    await service.createSession({ sessionId });
    expect((await service.submitPrompt({ sessionId, text: "First prompt." })).status).toBe("completed");
    expect((await service.submitPrompt({ sessionId, text: "Continue." })).status).toBe("completed");

    expect(modelInputs).toHaveLength(2);
    const replayedPart = modelInputs[1]?.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "reasoning" && part.modelOutput !== undefined);
    expect(replayedPart).toMatchObject({ type: "reasoning", text: "", modelOutput });

    const storedPart = (await store.messages(sessionId))
      .flatMap((message) => message.parts)
      .find((part) => part.type === "reasoning" && part.modelOutput !== undefined);
    expect(storedPart).toMatchObject({ type: "reasoning", text: "", modelOutput });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RuntimeService excludes a failed prompt with only a synthetic error from subsequent model context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-core-failed-prompt-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const registry = new InMemoryToolRegistry();
  const createId = createSequentialId();
  let now = 0;
  const modelInputs: ModelStreamInput[] = [];
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelInputs.push(input);
      if (modelInputs.length === 1) throw new Error("startup exploded");
      yield { type: "text_delta", text: "ok" };
      yield { type: "finish", reason: "stop" };
    },
  };
  const runtime = new SingleAgentRuntime({
    store,
    model,
    toolRegistry: registry,
    toolExecutor: new ToolExecutor({
      registry,
      events: { publish: (event) => store.append(event) },
      approvals: { decide: async () => ({ action: "allow_once" }) },
    }),
    retryPolicy: { maxAttempts: 1 },
    createId,
    now: () => ++now as TimestampMs,
  });
  const service = new RuntimeService({
    runtime,
    store,
    cwd: "/repo",
    createId,
    now: () => ++now as TimestampMs,
  });
  const sessionId = "session_failed_prompt_context" as SessionId;

  try {
    await service.createSession({ sessionId });
    const failedResult = await service.submitPrompt({
      sessionId,
      text: "prompt that fails",
    });
    expect(failedResult.status).toBe("failed");

    const completedResult = await service.submitPrompt({
      sessionId,
      text: "prompt that succeeds",
    });

    expect(completedResult.status).toBe("completed");
    expect(modelInputs).toHaveLength(2);
    const secondContext = messageTextContent(modelInputs[1]?.messages ?? []);
    expect(secondContext).not.toContain("prompt that fails");
    expect(secondContext).not.toContain("Model request failed: startup exploded");
    expect(secondContext).toContain("prompt that succeeds");

    const transcript = await store.messages(sessionId);
    expect(messageTextContent(transcript)).toContain("Model request failed: startup exploded");
    const failurePart = transcript
      .flatMap((message) => message.parts)
      .find((part) => part.type === "text" && part.text.includes("startup exploded"));
    expect(failurePart).toMatchObject({ type: "text", synthetic: true });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeAgentRunner implements AgentRunner {
  readonly createInputs: CreateSessionInput[] = [];
  readonly userMessages: AppendUserMessageInput[] = [];
  readonly turnInputs: RunTurnInput[] = [];
  runTurnWait?: Promise<void>;
  onRunTurn?: (input: RunTurnInput) => Promise<void>;
  runTurnResult: RunTurnResult = {
    status: "completed",
    turnId: "turn_fake" as TurnId,
    assistantMessageId: "message_assistant_fake" as MessageId,
    finishReason: "stop",
  };

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    this.createInputs.push(input);
    return input.sessionId ?? ("session_fake" as SessionId);
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<MessageId> {
    this.userMessages.push(input);
    return "message_user_fake" as MessageId;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    this.turnInputs.push(input);
    await this.runTurnWait;
    await this.onRunTurn?.(input);
    return this.runTurnResult;
  }
}

class MemoryEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];
  readonly messageRows: Message[] = [];
  readonly sessionRows: SessionRow[] = [];

  async append(event: ChiliEvent): Promise<void> {
    this.items.push(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const afterIndex = query.afterEventId
      ? this.items.findIndex((event) => event.id === query.afterEventId)
      : -1;
    const limit = query.limit ?? 500;
    return this.items
      .slice(afterIndex + 1)
      .filter((event) => {
        if (query.sessionId && event.sessionId !== query.sessionId) return false;
        if (query.type && event.type !== query.type) return false;
        return true;
      })
      .slice(0, limit);
  }

  async sessions(): Promise<SessionRow[]> {
    return this.sessionRows.map((row) => ({ ...row }));
  }

  addSession(
    sessionId: SessionId,
    source: SessionRow["source"] = "interactive",
    cwd = "/repo",
  ): void {
    this.sessionRows.push({
      id: sessionId,
      cwd,
      source,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
  }

  async messages(sessionId: SessionId): Promise<Message[]> {
    return this.messageRows
      .filter((message) => message.sessionId === sessionId)
      .map((message) => ({ ...message, parts: message.parts.map((part) => ({ ...part }) as Message["parts"][number]) }));
  }

  async pendingApprovals(): Promise<ApprovalRow[]> {
    return [];
  }
}

class SessionSourceEventStore extends MemoryEventStore {
  constructor(private readonly row: SessionRow) {
    super();
  }

  override async sessions(): Promise<SessionRow[]> {
    return [{ ...this.row }];
  }
}

class ThrowingStatusStore extends MemoryEventStore {
  override async append(event: ChiliEvent): Promise<void> {
    if (event.type === "session.status_changed") {
      throw new Error("status write failed");
    }
    await super.append(event);
  }
}

function statuses(store: MemoryEventStore): string[] {
  return store.items.flatMap((event) => (event.type === "session.status_changed" ? [event.payload.status] : []));
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function textMessage(input: {
  id: MessageId;
  sessionId: SessionId;
  role: Message["role"];
  text: string;
}): Message {
  return {
    id: input.id,
    sessionId: input.sessionId,
    role: input.role,
    createdAt: 1 as TimestampMs,
    parts: [
      {
        id: `${input.id}_part` as PartId,
        messageId: input.id,
        sessionId: input.sessionId,
        type: "text",
        text: input.text,
      },
    ],
  };
}

function messageTextContent(messages: readonly Message[]): string {
  return messages
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function textOnlyModel(): RuntimeModelDescriptor {
  return {
    provider: "minimax",
    model: "MiniMax-M2.7-highspeed",
    inputCapabilities: ["text"],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
