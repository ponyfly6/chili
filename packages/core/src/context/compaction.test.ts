import { expect, test } from "bun:test";
import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  MessagePart,
  SessionId,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import type { ApprovalRow, EventQuery, EventStore, SessionRow } from "@chili/store";
import { InMemoryToolRegistry, ToolExecutor } from "@chili/tools";
import { ContextWindowBuilder, compactedMessageView } from "./window.js";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "../runtime.js";
import { SingleAgentRuntime } from "../single-agent-runtime.js";

test("context builder uses the latest compaction message as replacement history", () => {
  const sessionId = "session_compacted_view" as SessionId;
  const oldUser = textMessage("msg_old_user", sessionId, "user", "old request");
  const oldAssistant = textMessage("msg_old_assistant", sessionId, "assistant", "old answer");
  const summary = compactionMessage("msg_summary", sessionId, oldAssistant.id, "summary of old work");
  const newUser = textMessage("msg_new_user", sessionId, "user", "new request");

  const built = new ContextWindowBuilder({ maxInputChars: 10_000 }).build([
    oldUser,
    oldAssistant,
    summary,
    newUser,
  ]);

  expect(built.messages.map((message) => message.id)).toEqual([summary.id, newUser.id]);
  expect(built.usage.omittedMessages).toBe(2);
});

test("compacted message view reorders appended summary before retained messages", () => {
  const sessionId = "session_compacted_order" as SessionId;
  const oldUser = textMessage("msg_order_old_user", sessionId, "user", "old request");
  const oldAssistant = textMessage("msg_order_old_assistant", sessionId, "assistant", "old answer");
  const newUser = textMessage("msg_order_new_user", sessionId, "user", "new request");
  const summary = compactionMessage("msg_order_summary", sessionId, oldAssistant.id, "summary of old work");

  expect(compactedMessageView([oldUser, oldAssistant, newUser, summary]).map((message) => message.id)).toEqual([
    summary.id,
    newUser.id,
  ]);
});

test("context builder does not repeatedly compact only an existing summary", () => {
  const sessionId = "session_compacted_repeat" as SessionId;
  const summary = compactionMessage("msg_repeat_summary", sessionId, "msg_old_boundary" as MessageId, "s".repeat(500));
  const newUser = textMessage("msg_repeat_user", sessionId, "user", "new request");

  const built = new ContextWindowBuilder({
    maxInputChars: 100,
    compactionThresholdRatio: 0.5,
    preserveRecentMessages: 8,
  }).build([summary, newUser]);

  expect(built.compactionBoundary).toBeUndefined();
});

test("manual compaction boundary includes the latest visible message", () => {
  const sessionId = "session_manual_boundary" as SessionId;
  const summary = compactionMessage("msg_manual_summary", sessionId, "msg_old_boundary" as MessageId, "summary");
  const newUser = textMessage("msg_manual_user", sessionId, "user", "new request");

  const boundary = new ContextWindowBuilder({
    maxInputChars: 10_000,
    preserveRecentMessages: 8,
  }).compactionBoundary([summary, newUser], "manual");

  expect(boundary?.boundaryMessageId).toBe(newUser.id);
});

test("context builder microcompacts old tool results by total tool-output budget", () => {
  const sessionId = "session_tool_microcompact" as SessionId;
  const oldTool = toolResultMessage("msg_tool_old", sessionId, "old", `old-${"x".repeat(300)}`);
  const middleTool = toolResultMessage("msg_tool_middle", sessionId, "middle", `middle-${"y".repeat(300)}`);
  const recentTool = toolResultMessage("msg_tool_recent", sessionId, "recent", `recent-${"z".repeat(300)}`);

  const built = new ContextWindowBuilder({
    maxInputChars: 10_000,
    maxTotalToolResultChars: 200,
    compactedToolResultChars: 120,
    preserveRecentToolResults: 1,
  }).build([oldTool, middleTool, recentTool]);

  const outputs = built.messages
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<MessagePart, { type: "tool_result" }> => part.type === "tool_result")
    .map((part) => part.output);

  expect(built.usage.compactedToolResults).toBe(2);
  expect(outputs[0]).toContain("tool result compacted from context");
  expect(outputs[1]).toContain("tool result compacted from context");
  expect(outputs[2]).toContain("recent-");
  expect(outputs[2]).not.toContain("tool result compacted from context");
});

test("runtime auto-compacts before the main model request and sends the summary forward", async () => {
  const store = new ProjectingEventStore();
  const registry = new InMemoryToolRegistry();
  const modelInputs: ModelStreamInput[] = [];
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      modelInputs.push(input);
      if (input.system.some((item) => item.includes("context compression engine"))) {
        const promptText = input.messages.flatMap((message) => message.parts).map(modelVisiblePartText).join("\n");
        const isVerification = promptText.includes("<draft_summary>");
        yield {
          type: "text_delta",
          text: isVerification
            ? [
                "<context_summary>",
                "Current goal: keep the important old request after verification.",
                "Next steps: answer using the revised summary.",
                "</context_summary>",
              ].join("\n")
            : [
                "<context_summary>",
                "Current goal: draft only.",
                "Next steps: ask verifier to revise.",
                "</context_summary>",
              ].join("\n"),
        };
        yield { type: "finish", reason: "stop" };
        return;
      }

      yield { type: "text_delta", text: "done" };
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
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    contextBudget: {
      maxInputChars: 220,
      compactionThresholdRatio: 0.5,
      preserveRecentMessages: 1,
    },
  });

  const sessionId = await runtime.createSession({ threadId: "thread_auto_compact" as ThreadId, cwd: "/repo" });
  await runtime.appendUserMessage({
    sessionId,
    threadId: "thread_auto_compact" as ThreadId,
    text: `old context ${"x".repeat(500)}`,
  });
  const result = await runtime.runTurn({
    sessionId,
    threadId: "thread_auto_compact" as ThreadId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  expect(modelInputs).toHaveLength(3);
  expect(modelInputs.slice(0, 2).every((modelInput) => modelInput.system.join("\n").includes("context compression engine"))).toBe(true);
  const mainInputText = modelInputs.at(-1)?.messages.flatMap((message) => message.parts).map(modelVisiblePartText).join("\n") ?? "";
  expect(mainInputText).toContain("<context_summary");
  expect(mainInputText).toContain("Current goal: keep the important old request after verification.");
  expect(mainInputText.match(/<context_summary/g)?.length).toBe(1);
  expect(mainInputText).not.toContain("old context xxx");
  expect(store.items.some((event) => event.type === "turn.compaction_completed")).toBe(true);
  expect(store.items.some((event) => event.type === "message.part_added" && event.payload.part.type === "compaction")).toBe(true);
  const compactionMessageIds = new Set<string>();
  for (const event of store.items) {
    if (event.type === "message.part_added" && event.payload.part.type === "compaction") {
      compactionMessageIds.add(event.payload.messageId);
    }
  }
  expect(
    store.items.some(
      (event) =>
        event.type === "message.created" &&
        event.payload.role === "user" &&
        compactionMessageIds.has(event.payload.messageId),
    ),
  ).toBe(true);
});

test("runtime reactively compacts and retries context limit failures before output starts", async () => {
  const store = new ProjectingEventStore();
  const registry = new InMemoryToolRegistry();
  let mainCalls = 0;
  let compactionCalls = 0;
  const model: ModelRouter = {
    async *stream(input: ModelStreamInput): AsyncIterable<ModelStreamEvent> {
      if (input.system.some((item) => item.includes("context compression engine"))) {
        compactionCalls++;
        yield {
          type: "text_delta",
          text: [
            "<context_summary>",
            "Current goal: recover from a context limit error.",
            "Next steps: retry the original model request.",
            "</context_summary>",
          ].join("\n"),
        };
        yield { type: "finish", reason: "stop" };
        return;
      }

      mainCalls++;
      if (mainCalls === 1) {
        yield { type: "metadata", provider: "test", model: "large-context", responseId: "resp_before_recovery" };
        throw new Error("context window exceeded");
      }
      const modelText = input.messages.flatMap((message) => message.parts).map(modelVisiblePartText).join("\n");
      expect(modelText).toContain("recover from a context limit error");
      yield { type: "text_delta", text: "recovered" };
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
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
    contextBudget: {
      maxInputChars: 10_000,
      compactionThresholdRatio: 0.95,
      preserveRecentMessages: 0,
    },
  });

  const sessionId = await runtime.createSession({ threadId: "thread_reactive_compact" as ThreadId, cwd: "/repo" });
  await runtime.appendUserMessage({
    sessionId,
    threadId: "thread_reactive_compact" as ThreadId,
    text: "please continue after recovery",
  });
  const result = await runtime.runTurn({
    sessionId,
    threadId: "thread_reactive_compact" as ThreadId,
    cwd: "/repo",
  });

  expect(result.status).toBe("completed");
  expect(mainCalls).toBe(2);
  expect(compactionCalls).toBe(2);
  expect(
    store.items.some(
      (event) => event.type === "turn.compaction_requested" && event.payload.reason === "recovery",
    ),
  ).toBe(true);
});

class ProjectingEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];
  private readonly messagesById = new Map<string, Message>();
  private readonly messageOrder: string[] = [];

  async append(event: ChiliEvent): Promise<void> {
    this.items.push(event);
    this.project(event);
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const afterIndex = query.afterEventId
      ? this.items.findIndex((event) => event.id === query.afterEventId)
      : -1;
    return this.items
      .slice(afterIndex + 1)
      .filter((event) => {
        if (query.sessionId && event.sessionId !== query.sessionId) return false;
        if (query.threadId && event.threadId !== query.threadId) return false;
        if (query.type && event.type !== query.type) return false;
        return true;
      })
      .slice(0, query.limit ?? 500);
  }

  async sessions(): Promise<SessionRow[]> {
    return [];
  }

  async messages(sessionId: SessionId): Promise<Message[]> {
    return this.messageOrder
      .map((id) => this.messagesById.get(id))
      .filter((message): message is Message => message !== undefined && message.sessionId === sessionId)
      .map((message) => ({ ...message, parts: message.parts.map((part) => ({ ...part }) as MessagePart) }));
  }

  async pendingApprovals(): Promise<ApprovalRow[]> {
    return [];
  }

  private project(event: ChiliEvent): void {
    if (event.type === "message.created") {
      if (!event.sessionId) throw new Error("message.created requires sessionId");
      this.messageOrder.push(event.payload.messageId);
      this.messagesById.set(event.payload.messageId, {
        id: event.payload.messageId,
        sessionId: event.sessionId,
        role: event.payload.role,
        parts: [],
        createdAt: event.time,
      });
      return;
    }

    if (event.type === "message.part_added") {
      const message = this.messagesById.get(event.payload.messageId);
      if (message) message.parts.push(event.payload.part);
      return;
    }

    if (event.type === "message.part_delta") {
      const message = [...this.messagesById.values()].find((candidate) =>
        candidate.parts.some((part) => part.id === event.payload.partId),
      );
      const part = message?.parts.find((candidate) => candidate.id === event.payload.partId);
      if (part && event.payload.field === "text" && (part.type === "text" || part.type === "reasoning")) {
        part.text += event.payload.delta;
      }
    }
  }
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function textMessage(
  id: string,
  sessionId: SessionId,
  role: Message["role"],
  text: string,
): Message {
  return {
    id: id as MessageId,
    sessionId,
    role,
    createdAt: 1 as TimestampMs,
    parts: [
      {
        id: `part_${id}` as never,
        messageId: id as MessageId,
        sessionId,
        type: "text",
        text,
      },
    ],
  };
}

function compactionMessage(id: string, sessionId: SessionId, boundaryMessageId: MessageId, summary: string): Message {
  return {
    id: id as MessageId,
    sessionId,
    role: "user",
    createdAt: 1 as TimestampMs,
    parts: [
      {
        id: `part_${id}_text` as never,
        messageId: id as MessageId,
        sessionId,
        type: "text",
        text: `<context_summary>\n${summary}\n</context_summary>`,
        synthetic: true,
      },
      {
        id: `part_${id}_compaction` as never,
        messageId: id as MessageId,
        sessionId,
        type: "compaction",
        boundaryMessageId,
        reason: "token_budget",
        summary,
      },
    ],
  };
}

function toolResultMessage(id: string, sessionId: SessionId, callId: string, output: string): Message {
  return {
    id: id as MessageId,
    sessionId,
    role: "assistant",
    createdAt: 1 as TimestampMs,
    parts: [
      {
        id: `part_${id}_tool_result` as never,
        messageId: id as MessageId,
        sessionId,
        type: "tool_result",
        callId: callId as never,
        output,
      },
    ],
  };
}

function modelVisiblePartText(part: MessagePart): string {
  if (part.type === "text" || part.type === "reasoning") return part.text;
  if (part.type === "tool_result") return part.output;
  return "";
}
