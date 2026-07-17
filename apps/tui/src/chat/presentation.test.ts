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

test("exploration groups expose one semantic failure with an exact failed count", () => {
  const display = buildChatDisplayItems([
    chatTool("read_running" as ToolCallId, "read", "running", "running", { title: "read", path: "package.json", detail: "package.json" }),
    chatTool("grep_failed" as ToolCallId, "grep", "failed", "failed", { title: "grep", pattern: "TODO", scope: "apps/tui", detail: "TODO in apps/tui" }, {
      error: "grep failed",
      output: "SECRET_GREP_OUTPUT",
    }),
    chatTool("glob_done" as ToolCallId, "glob", "completed", "succeeded", { title: "glob", pattern: "*.tsx", path: "apps/tui/src", detail: "*.tsx under apps/tui/src" }, {
      output: "SECRET_GLOB_OUTPUT",
    }),
  ]);

  const item = display[0];
  expect(item?.kind).toBe("tool_group");
  if (item?.kind !== "tool_group") throw new Error("expected a tool group");

  expect(item).toMatchObject({
    label: "Exploring 1 file, searched 1 pattern, listed 1 path · 1 failed",
    tone: "error",
    metadata: {
      activeHint: "Reading package.json",
      hasErrors: true,
      collapsedCount: 3,
      readCount: 1,
      searchCount: 1,
      listCount: 1,
      activeCount: 1,
      errorCount: 1,
      failedCount: 1,
      compactFailureLines: ["Search failed: apps/tui (Ctrl+O for details)"],
    },
  });
  expect(item.activities.every((activity) => activity.mode === "inline")).toBe(true);
  expect(item.activities.every((activity) => activity.bodyLines.length === 0)).toBe(true);
  expect(item.activities.find((activity) => activity.toolName === "grep")?.compactErrorLines).toEqual(["Search failed: apps/tui"]);
});

function chatTool(
  id: ToolCallId,
  toolName: string,
  status: Extract<ChatTranscriptItem, { kind: "tool" }>["status"],
  displayStatus: Extract<ChatTranscriptItem, { kind: "tool" }>["displayStatus"],
  inputSummary: Extract<ChatTranscriptItem, { kind: "tool" }>["inputSummary"],
  extra: Partial<Pick<Extract<ChatTranscriptItem, { kind: "tool" }>, "output" | "error" | "input">> = {},
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
