import { expect, test } from "bun:test";
import type { ToolCallId } from "@chili/protocol";
import type { ChatTranscriptItem } from "@chili/sdk";
import { buildChatDisplayItems } from "./presentation.js";

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

test("exploration groups expose compact metadata without changing labels", () => {
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
    label: "Exploring 1 file, searched 1 pattern, listed 1 path with errors",
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
    },
  });
  expect(item.activities.every((activity) => activity.mode === "inline")).toBe(true);
  expect(item.activities.every((activity) => activity.bodyLines.length === 0)).toBe(true);
  expect(item.activities.find((activity) => activity.toolName === "grep")?.compactErrorLines).toEqual(["grep failed"]);
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
