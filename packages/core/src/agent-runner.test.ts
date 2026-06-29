import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  PartId,
  RuntimeModelDescriptor,
  SessionId,
  ThreadId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import { SqliteEventStore, type ApprovalRow, type EventQuery, type EventStore, type SessionRow } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import type { AgentRunner, AppendUserMessageInput, CreateSessionInput, RunTurnInput, RunTurnResult } from "./runner.js";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";
import { RuntimeBusyError, RuntimeService } from "./runtime-service.js";
import { SingleAgentRuntime } from "./single-agent-runtime.js";

test("RuntimeService accepts an AgentRunner implementation", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_fake" as SessionId;
  const threadId = "thread_fake" as ThreadId;
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
    threadId,
    cwd: "/workspace",
  });
  const result = await service.submitPrompt({
    sessionId: handle.sessionId,
    threadId: handle.threadId,
    text: "hello",
    cwd: "/workspace/subdir",
  });

  expect(result.status).toBe("completed");
  if (result.status === "completed") {
    expect(result.finishReason).toBe("stop");
  }
  expect(runner.createInputs[0]).toEqual({
    threadId,
    cwd: "/workspace",
  });
  expect(runner.userMessages[0]).toMatchObject({
    sessionId,
    threadId,
    text: "hello",
  });
  expect(runner.userMessages[0]?.turnId).toBe(runner.turnInputs[0]?.turnId);
  expect(runner.turnInputs[0]?.cwd).toBe("/workspace/subdir");
  expect(runner.turnInputs[0]?.system).toEqual(["be brief"]);
  expect(runner.turnInputs[0]?.signal?.aborted).toBe(false);
  expect(statuses(store)).toEqual(["idle", "running", "running", "idle"]);
});

test("RuntimeService rejects prompt images for text-only models before appending user messages", async () => {
  const store = new MemoryEventStore();
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
    threadId: "thread_text_only_image" as ThreadId,
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
    threadId: "thread_text_only_image_path" as ThreadId,
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
  expect(statuses(store)).toEqual(["running", "running", "idle"]);
});

test("RuntimeService prefers direct image input over external image tools for image-capable turns", async () => {
  const store = new MemoryEventStore();
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
    threadId: "thread_direct_image" as ThreadId,
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
    threadId: "thread_direct_image_tool" as ThreadId,
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
    threadId: "thread_text_only_tool_image" as ThreadId,
    text: "hi",
    modelSelection: { provider: model.provider, model: model.model },
  });

  expect(result.status).toBe("completed");
  expect(runner.userMessages).toHaveLength(1);
  expect(runner.turnInputs).toHaveLength(1);
});

test("RuntimeService passes promptFragments by prompt layer", async () => {
  const store = new MemoryEventStore();
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
    threadId: "thread_prompt_layers" as ThreadId,
    text: "hello",
  });

  expect(result.status).toBe("completed");
  expect(runner.turnInputs[0]?.system).toEqual(["base system"]);
  expect(runner.turnInputs[0]?.developer).toEqual(["skills catalog"]);
  expect(runner.turnInputs[0]?.contextualUser).toEqual(["memory context"]);
  expect(runner.turnInputs[0]?.promptDebug?.fragments.map((fragment) => [fragment.id, fragment.source, fragment.layer])).toEqual([
    ["base", "core", "base"],
    ["skills", "skills", "developer"],
    ["memory", "memory", "contextual_user"],
  ]);
});

test("RuntimeService passes current turn text and skill mentions to prompt fragments", async () => {
  const store = new MemoryEventStore();
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
    threadId: "thread_skill_turn" as ThreadId,
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
  const threadId = "thread_prompt_after_append" as ThreadId;
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
    threadId,
    text: "what changed?",
  });

  expect(result.status).toBe("completed");
  expect(observedUserMessages[0]?.[0]).toMatchObject({
    sessionId,
    threadId,
    text: "what changed?",
  });
  expect(runner.turnInputs[0]?.contextualUser).toEqual(["latest user: what changed?"]);
});

test("RuntimeService inspectPrompt includes conversation context as a prompt fragment", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_prompt_conversation" as SessionId;
  const threadId = "thread_prompt_conversation" as ThreadId;
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
    threadId,
    cwd: "/repo",
    text: "current turn",
    includeContent: true,
  });

  const conversation = inspected.fragments.find((fragment) => fragment.layer === "conversation");
  expect(inspected.debug.fragments.map((fragment) => fragment.layer)).toEqual(["base", "conversation"]);
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
    threadId: "thread_prompt_debug" as ThreadId,
    cwd: "/repo/app",
  });

  expect(debug.fragments.map((fragment) => [fragment.id, fragment.layer, fragment.source])).toEqual([
    ["debug.base", "base", "core"],
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
  expect(debug.totalChars).toBe("base instructions".length + "skills catalog".length + "project instructions".length);
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
    threadId: "thread_prompt_debug_no_content" as ThreadId,
    cwd: "/repo",
    includeContent: false,
  });
  const withContent = await service.inspectPrompt({
    sessionId: "session_prompt_debug_content" as SessionId,
    threadId: "thread_prompt_debug_content" as ThreadId,
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

  await expect(
    service.submitPrompt({
      sessionId,
      threadId: "thread_status_failure" as ThreadId,
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
  const threadId = "thread_busy" as ThreadId;

  const first = service.submitPrompt({
    sessionId,
    threadId,
    text: "first",
  });

  expect(service.isRunning(sessionId)).toBe(true);
  await expect(
    service.submitPrompt({
      sessionId,
      threadId,
      text: "second",
    }),
  ).rejects.toThrow(RuntimeBusyError);
  expect(() =>
    service.submitPromptAsync({
      sessionId,
      threadId,
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
    threadId: "thread_tool_calls" as ThreadId,
    text: "use a tool",
    maxTurns: 3,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("stop");
  expect(runner.turnInputs).toHaveLength(2);
  expect(statuses(store)).toEqual(["running", "running", "running", "idle"]);
});

test("RuntimeService adds a no-tool final turn after the tool continuation limit", async () => {
  const store = new MemoryEventStore();
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
    threadId: "thread_final_after_tools" as ThreadId,
    text: "inspect deeply",
    maxTurns: 2,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("stop");
  expect(runner.turnInputs).toHaveLength(3);
  expect(runner.turnInputs[2]?.toolMode).toBe("disabled");
  expect(runner.turnInputs[2]?.system?.at(-1)).toContain("Do not call tools");
  expect(statuses(store)).toEqual(["running", "running", "running", "running", "idle"]);
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
    threadId: "thread_previous" as ThreadId,
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
  });
  await firstService.setReasoning({
    sessionId: "session_previous" as SessionId,
    threadId: "thread_previous" as ThreadId,
    reasoningLevel: "high",
  });
  await firstService.setServiceTier({
    sessionId: "session_previous" as SessionId,
    threadId: "thread_previous" as ThreadId,
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
    threadId: "thread_next" as ThreadId,
  });
  const config = await nextService.getModelConfig("session_next" as SessionId);
  expect(config.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  expect(config.reasoningLevel).toBe("high");
  expect(config.serviceTier).toBe("fast");

  const result = await nextService.submitPrompt({
    sessionId: "session_next" as SessionId,
    threadId: "thread_next" as ThreadId,
    text: "hello",
  });

  expect(result.status).toBe("completed");
  expect(nextRunner.turnInputs[0]?.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  expect(nextRunner.turnInputs[0]?.reasoningLevel).toBe("high");
  expect(nextRunner.turnInputs[0]?.serviceTier).toBe("fast");
});

test("RuntimeService still stops on Anthropic-style end_turn finish reason", async () => {
  const store = new MemoryEventStore();
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
    threadId: "thread_end_turn" as ThreadId,
    text: "answer directly",
    maxTurns: 3,
  });

  expect(result.status).toBe("completed");
  expect(result.finishReason).toBe("end_turn");
  expect(runner.turnInputs).toHaveLength(1);
  expect(statuses(store)).toEqual(["running", "running", "idle"]);
});

test("RuntimeService stops before another tool-use turn when interrupted", async () => {
  const store = new MemoryEventStore();
  const runner = new FakeAgentRunner();
  const sessionId = "session_interrupt_loop" as SessionId;
  const threadId = "thread_interrupt_loop" as ThreadId;
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
    threadId,
    text: "finish by tool",
    maxTurns: 3,
  });

  expect(result.status).toBe("cancelled");
  expect(runner.turnInputs).toHaveLength(1);
  expect(statuses(store)).toEqual(["running", "cancelling", "running", "cancelled"]);
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
    threadId: "thread_abort" as ThreadId,
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
  const threadId = "thread_cancelled_prompt_context" as ThreadId;

  try {
    const cancelled = service.submitPrompt({
      sessionId,
      threadId,
      text: "理解一下这个幕落",
    });
    await firstCallStarted.promise;
    await service.interrupt(sessionId, "user_interrupt");

    const cancelledResult = await cancelled;
    expect(cancelledResult.status).toBe("cancelled");

    const completedResult = await service.submitPrompt({
      sessionId,
      threadId,
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
        if (query.threadId && event.threadId !== query.threadId) return false;
        if (query.type && event.type !== query.type) return false;
        return true;
      })
      .slice(0, limit);
  }

  async sessions(): Promise<SessionRow[]> {
    return [];
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
