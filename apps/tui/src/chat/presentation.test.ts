import { expect, test } from "bun:test";
import type { MessageId, PartId, ToolCallId } from "@chili/protocol";
import type { ChatTranscriptItem } from "@chili/sdk";
import { buildChatDisplayItems } from "./presentation.js";

test("user message presentation keeps text and images in one card", () => {
  const display = buildChatDisplayItems([{
    id: "msg_user_card" as MessageId,
    kind: "message",
    role: "user",
    createdAt: 1,
    parts: [
      { type: "text", id: "part_user_text" as PartId, text: "inspect this" },
      { type: "image", id: "part_user_image" as PartId, mimeType: "image/png", displayText: "[Image #1]" },
    ],
  }]);

  expect(display).toEqual([{
    kind: "user_message",
    id: "msg_user_card",
    text: "inspect this",
    imageLabels: ["[Image #1]"],
    time: 1,
  }]);
});

test("synthetic provider errors are sanitized before chat presentation", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LXBheWxvYWQ.c2lnbmF0dXJl";
  const display = buildChatDisplayItems([{
    id: "msg_legacy_provider_error" as MessageId,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    parts: [{
      type: "text",
      id: "part_legacy_provider_error" as PartId,
      synthetic: true,
      text: `Model request failed: token=private ${jwt} 103.151.173.205`,
    }],
  }]);

  expect(display[0]).toMatchObject({
    kind: "assistant_text",
    text: "Model request failed: token=[redacted-credential] [redacted-jwt] [redacted-ip]",
  });
  expect(JSON.stringify(display)).not.toContain("103.151.173.205");
  expect(JSON.stringify(display)).not.toContain(jwt);
});

test("synthetic failure checkpoints retain their multiline body in chat presentation", () => {
  const checkpoint = [
    "Incomplete partial result saved before the model request failed. This is not a complete answer.",
    "",
    "Previously saved assistant progress:",
    `- ${"retained progress ".repeat(50)}`,
    "",
    "Tool activity completed before the failure:",
    "- read: completed (/repo/src/runtime.ts)",
    "",
    "The task remains incomplete. Continue after the model service recovers.",
  ].join("\n");
  const display = buildChatDisplayItems([{
    id: "msg_failure_checkpoint" as MessageId,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    parts: [{
      type: "text",
      id: "part_failure_checkpoint" as PartId,
      synthetic: true,
      text: checkpoint,
    }],
  }]);

  expect(display[0]).toMatchObject({ kind: "assistant_text", text: checkpoint });
});

test("tool activity presentation carries renderer cell fields", () => {
  const display = buildChatDisplayItems([
    chatTool("git_diff_1" as ToolCallId, "git_diff", "completed", "succeeded", { title: "git_diff", detail: "src/example.ts" }, {
      output: "diff --git a/src/example.ts b/src/example.ts\n+const ok = true;",
    }),
  ], { showToolDetails: true });

  const item = display[0];
  expect(item?.kind).toBe("tool_activity");
  if (item?.kind !== "tool_activity") throw new Error("expected a tool activity");

  expect(item.activity).toMatchObject({
    mode: "block",
    title: "Read git diff src/example.ts",
    summary: "src/example.ts",
    bodyKind: "diff",
    bodyLines: ["diff --git a/src/example.ts b/src/example.ts", "+const ok = true;"],
    bodyTruncated: false,
  });
});

test("tool activity details preserve execution context from rows and fallback results", () => {
  const context = {
    executionMode: "unsandboxed",
    sandbox: "none",
    exitCode: 0,
  } as const;
  const rowCallId = "tool_execution_row" as ToolCallId;
  const rowDisplay = buildChatDisplayItems([
    chatTool(rowCallId, "bash", "completed", "succeeded", { title: "bash", command: "echo row" }, {
      executionContext: context,
    }),
  ], { showToolDetails: true });
  const fallbackCallId = "tool_execution_fallback" as ToolCallId;
  const fallbackDisplay = buildChatDisplayItems([{
    id: "msg_execution_fallback" as MessageId,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    parts: [
      {
        type: "tool_call",
        id: "part_execution_fallback_call" as PartId,
        callId: fallbackCallId,
        toolName: "bash",
        status: "completed",
        input: { command: "echo fallback" },
      },
      {
        type: "tool_result",
        id: "part_execution_fallback_result" as PartId,
        callId: fallbackCallId,
        output: "ok",
        executionContext: context,
      },
    ],
  }], { showToolDetails: true });

  for (const item of [rowDisplay[0], fallbackDisplay[0]]) {
    expect(item?.kind).toBe("tool_activity");
    if (item?.kind !== "tool_activity") throw new Error("expected a tool activity");
    expect(item.activity.executionContext).toEqual(context);
    expect(item.activity.details).toContainEqual({
      label: "execution",
      tone: "muted",
      lines: ["mode: unsandboxed", "sandbox: none", "exit code: 0"],
      truncated: false,
    });
  }
});

test("fallback command results treat nonzero exit codes as failures", () => {
  const callId = "tool_nonzero_fallback" as ToolCallId;
  const display = buildChatDisplayItems([{
    id: "msg_nonzero_fallback" as MessageId,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    parts: [
      {
        type: "tool_call",
        id: "part_nonzero_call" as PartId,
        callId,
        toolName: "bash",
        status: "completed",
        input: { command: "exit 7" },
      },
      {
        type: "tool_result",
        id: "part_nonzero_result" as PartId,
        callId,
        output: "",
        executionContext: { exitCode: 7 },
      },
    ],
  }]);

  expect(display[0]).toMatchObject({
    kind: "tool_activity",
    activity: {
      displayStatus: "failed",
      compactErrorLines: ["Command exited with code 7"],
    },
  });
});

test("live tool rows render partial input labels without exposing assistant tool parts", () => {
  const callId = "tool_live_partial" as ToolCallId;
  const display = buildChatDisplayItems([
    {
      id: "msg_live_partial" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [
        {
          type: "tool_call",
          id: "part_live_partial" as PartId,
          callId,
          toolName: "bash",
          status: "pending",
          input: { command: "bun test" },
          displayStatus: "queued",
        },
      ],
    },
    chatTool(callId, "bash", "running", "running", { title: "bash", command: "bun test", detail: "bun test" }, {
      input: { command: "bun test" },
    }),
  ]);

  const activities = display.filter((item) => item.kind === "tool_activity");
  expect(activities).toHaveLength(1);
  expect(activities[0]).toMatchObject({
    kind: "tool_activity",
    activity: {
      id: callId,
      label: "Running bun test",
      inputSummary: { command: "bun test" },
    },
  });
  expect(display.some((item) => item.kind === "summary" && item.text.includes("tool_call"))).toBe(false);
});

test("preserves explicit assistant phases when commentary is visible", () => {
  const display = buildChatDisplayItems([{
    id: "msg_visible_phases" as MessageId,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    completedAt: 2,
    parts: [
      { type: "text", id: "part_visible_commentary" as PartId, text: "Checking.", phase: "commentary" },
      { type: "text", id: "part_visible_final" as PartId, text: "Done.", phase: "final_answer" },
    ],
  }]);

  expect(display).toEqual([
    {
      kind: "assistant_text",
      id: "msg_visible_phases:part_visible_commentary:0",
      text: "Checking.",
      phase: "commentary",
      time: 1,
    },
    {
      kind: "assistant_text",
      id: "msg_visible_phases:part_visible_final:1",
      text: "Done.",
      phase: "final_answer",
      time: 1,
    },
  ]);
});

test("marks every text part in the active assistant message as streaming", () => {
  const display = buildChatDisplayItems([{
    id: "msg_streaming_phases" as MessageId,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    parts: [
      { type: "text", id: "part_streaming_commentary" as PartId, text: "Checking.", phase: "commentary" },
      { type: "text", id: "part_streaming_final" as PartId, text: "Draft answer.", phase: "final_answer" },
    ],
  }], {
    sessionStatus: "running",
    activeToolCount: 0,
  });

  expect(display.filter((item) => item.kind === "assistant_text")).toEqual([
    expect.objectContaining({
      id: "msg_streaming_phases:part_streaming_commentary:0",
      streaming: true,
    }),
    expect.objectContaining({
      id: "msg_streaming_phases:part_streaming_final:1",
      streaming: true,
    }),
  ]);
});

test("hideThinking hides commentary but keeps the final answer beside tool calls", () => {
  const callId = "tool_phase_visibility" as ToolCallId;
  const display = buildChatDisplayItems([{
    id: "msg_phase_visibility" as MessageId,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    parts: [
      { type: "text", id: "part_phase_commentary" as PartId, text: "Checking.", phase: "commentary" },
      {
        type: "tool_call",
        id: "part_phase_tool" as PartId,
        callId,
        toolName: "read",
        status: "pending",
      },
      { type: "text", id: "part_phase_final" as PartId, text: "Done.", phase: "final_answer" },
    ],
  }], {
    hideThinking: true,
    sessionStatus: "running",
    activeToolCount: 0,
  });

  expect(display).toEqual([
    {
      kind: "reasoning",
      id: "msg_phase_visibility:hidden-thinking",
      text: "",
      collapsed: true,
      active: true,
      time: 1,
    },
    {
      kind: "assistant_text",
      id: "msg_phase_visibility:part_phase_final:2",
      text: "Done.",
      phase: "final_answer",
      streaming: true,
      time: 1,
    },
  ]);
});

test("hideThinking never classifies phase-less assistant text as thinking", () => {
  const display = buildChatDisplayItems([{
    id: "msg_unclassified_visibility" as MessageId,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    completedAt: 2,
    parts: [
      { type: "reasoning", id: "part_hidden_reasoning" as PartId, text: "Internal reasoning." },
      { type: "text", id: "part_hidden_commentary" as PartId, text: "Checking.", phase: "commentary" },
      { type: "text", id: "part_visible_unclassified" as PartId, text: "Provider text." },
      { type: "text", id: "part_visible_answer" as PartId, text: "Done.", phase: "final_answer" },
    ],
  }], { hideThinking: true });

  expect(display).toEqual([
    {
      kind: "reasoning",
      id: "msg_unclassified_visibility:hidden-thinking",
      text: "",
      collapsed: true,
      time: 1,
    },
    {
      kind: "assistant_text",
      id: "msg_unclassified_visibility:part_visible_unclassified:2",
      text: "Provider text.",
      time: 1,
    },
    {
      kind: "assistant_text",
      id: "msg_unclassified_visibility:part_visible_answer:3",
      text: "Done.",
      phase: "final_answer",
      time: 1,
    },
  ]);
});

test("empty opaque reasoning stays hidden while the final answer remains visible", () => {
  const display = buildChatDisplayItems([{
    id: "msg_opaque_reasoning" as MessageId,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    parts: [
      { type: "reasoning", id: "part_opaque_reasoning" as PartId, text: "", redacted: true },
      { type: "text", id: "part_opaque_answer" as PartId, text: "Done.", phase: "final_answer" },
    ],
  }]);

  expect(display).toHaveLength(1);
  expect(display[0]).toMatchObject({ kind: "assistant_text", text: "Done." });
});

test("exploration groups contain only consecutive successes and retain failures", () => {
  const display = buildChatDisplayItems([
    chatTool("read_done_1" as ToolCallId, "read", "completed", "succeeded", { title: "read", path: "package.json", detail: "package.json" }),
    chatTool("grep_done_1" as ToolCallId, "grep", "completed", "succeeded", { title: "grep", pattern: "TODO", scope: "apps/tui", detail: "TODO in apps/tui" }),
    chatTool("grep_failed" as ToolCallId, "grep", "failed", "failed", { title: "grep", pattern: "TODO", scope: "apps/tui", detail: "TODO in apps/tui" }, {
      error: "grep failed",
      output: "SECRET_GREP_OUTPUT",
    }),
    chatTool("glob_done_2" as ToolCallId, "glob", "completed", "succeeded", { title: "glob", pattern: "*.tsx", path: "apps/tui/src", detail: "*.tsx under apps/tui/src" }),
    chatTool("read_done_2" as ToolCallId, "read", "completed", "succeeded", { title: "read", path: "README.md", detail: "README.md" }),
  ]);

  expect(display).toHaveLength(3);
  expect(display[0]).toMatchObject({
    kind: "tool_group",
    label: "Explored 1 file, searched 1 pattern",
    activities: [
      { id: "read_done_1", displayStatus: "succeeded" },
      { id: "grep_done_1", displayStatus: "succeeded" },
    ],
  });
  expect(display[1]).toMatchObject({
    kind: "tool_activity",
    activity: {
      id: "grep_failed",
      displayStatus: "failed",
      compactErrorLines: ["Search failed: apps/tui"],
    },
  });
  expect(display[2]).toMatchObject({
    kind: "tool_group",
    label: "Explored 1 file, listed 1 path",
    activities: [
      { id: "glob_done_2", displayStatus: "succeeded" },
      { id: "read_done_2", displayStatus: "succeeded" },
    ],
  });
});

test("exploration group labels surface exact no-match results", () => {
  const display = buildChatDisplayItems([
    chatTool("grep_empty" as ToolCallId, "grep", "completed", "succeeded", { title: "grep", pattern: "missing", scope: "apps/tui" }, {
      output: "(no matches)",
    }),
    chatTool("glob_done" as ToolCallId, "glob", "completed", "succeeded", { title: "glob", pattern: "*.tsx", path: "apps/tui/src" }, {
      output: "apps/tui/src/index.tsx",
    }),
  ]);

  expect(display).toHaveLength(1);
  expect(display[0]).toMatchObject({
    kind: "tool_group",
    label: "Explored searched 1 pattern, listed 1 path · No matches",
  });
});

function chatTool(
  id: ToolCallId,
  toolName: string,
  status: Extract<ChatTranscriptItem, { kind: "tool" }>["status"],
  displayStatus: Extract<ChatTranscriptItem, { kind: "tool" }>["displayStatus"],
  inputSummary: Extract<ChatTranscriptItem, { kind: "tool" }>["inputSummary"],
  extra: Partial<Pick<Extract<ChatTranscriptItem, { kind: "tool" }>, "output" | "error" | "input" | "executionContext">> = {},
): Extract<ChatTranscriptItem, { kind: "tool" }> {
  return {
    id,
    kind: "tool",
    toolName,
    status,
    displayStatus,
    waitingForApproval: displayStatus === "waiting_permission",
    updatedAt: 1,
    inputSummary,
    ...extra,
  };
}
