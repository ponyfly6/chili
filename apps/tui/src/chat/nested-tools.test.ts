import { expect, test } from "bun:test";
import type { ApprovalId, ToolCallId } from "@chili/protocol";
import type { ChatToolCallRow } from "@chili/sdk";
import { buildChatDisplayItems } from "./presentation.js";
import { toolGroupCellLines } from "./ToolCells.js";
import { resolveTuiTheme } from "../theme/index.js";

function tool(id: string, toolName: string, extra: Partial<ChatToolCallRow> = {}): ChatToolCallRow {
  return {
    id: id as ToolCallId, kind: "tool", toolName, status: "completed", displayStatus: "succeeded",
    waitingForApproval: false, updatedAt: 1, inputSummary: { title: toolName }, ...extra,
  };
}

test("groups a script and its nested tools while retaining errors and separate approvals", () => {
  const parentCallId = "call_script" as ToolCallId;
  const display = buildChatDisplayItems([
    tool(parentCallId, "code_mode", { updatedAt: 10, output: "selected result" }),
    tool("call_read", "read", { parentCallId, updatedAt: 3, output: "child result" }),
    tool("call_write", "write", { parentCallId, updatedAt: 4, status: "failed", displayStatus: "rejected", error: "Permission denied" }),
    {
      id: "approval_write" as ApprovalId, kind: "approval", permission: "write", patterns: ["README.md"],
      inputSummary: { title: "write", path: "README.md" },
      status: "resolved", decision: "deny", createdAt: 2, resolvedAt: 4,
    },
  ], { showToolDetails: true });

  expect(display.map((item) => item.kind)).toEqual(["tool_group", "approval"]);
  const group = display[0];
  if (group?.kind !== "tool_group") throw new Error("expected nested tool group");
  expect(group.id).toBe(`tool-group:${parentCallId}`);
  expect(group.label).toContain("2 tool calls");
  expect(group.label).toContain("1 unsuccessful");
  expect(group.tone).toBe("error");
  expect(group.metadata.hasErrors).toBe(true);
  expect(group.activities.map((activity) => activity.callId)).toEqual([parentCallId, "call_read", "call_write"]);
  expect(group.activities[1]).toMatchObject({ parentCallId, label: expect.stringMatching(/^↳ /), output: "child result" });
  expect(group.activities[2]).toMatchObject({ parentCallId, displayStatus: "rejected", error: "Permission denied" });
});

test("a running nested tool keeps its group active and detailed output remains available", () => {
  const parentCallId = "call_script" as ToolCallId;
  const display = buildChatDisplayItems([
    tool(parentCallId, "code_mode", { status: "running", displayStatus: "running" }),
    tool("call_read", "read", { parentCallId, status: "waiting_for_approval", displayStatus: "waiting_permission", waitingForApproval: true }),
  ]);
  expect(display).toHaveLength(1);
  expect(display[0]).toMatchObject({
    kind: "tool_group", tone: "pending", metadata: { activeCount: 2 },
    activities: [{ callId: parentCallId }, { parentCallId, displayStatus: "waiting_permission" }],
  });
});

test("nested groups render compactly and reveal indented child output with tool details", () => {
  const parentCallId = "call_script" as ToolCallId;
  const rows = [
    tool(parentCallId, "code_mode", { output: "Selected result" }),
    tool("call_read", "read", { parentCallId, output: "Complete child output" }),
  ];
  const theme = resolveTuiTheme("chili-dark", {});
  const render = (showToolDetails: boolean) => {
    const group = buildChatDisplayItems(rows, { showToolDetails })[0];
    if (group?.kind !== "tool_group") throw new Error("expected nested tool group");
    return toolGroupCellLines(group, 96, theme).map((line) => line.text).join("\n");
  };
  expect(render(false)).toContain("1 tool call");
  expect(render(false)).not.toContain("Complete child output");
  expect(render(true)).toContain("↳");
  expect(render(true)).toContain("Complete child output");
});

test("orphaned nested rows retain their relationship and do not merge into unrelated exploration", () => {
  const parentCallId = "call_outside_window" as ToolCallId;
  const display = buildChatDisplayItems([
    tool("call_nested_read", "read", { parentCallId }),
    tool("call_direct_read", "read"),
  ]);
  expect(display.map((item) => item.kind)).toEqual(["tool_activity", "tool_activity"]);
  expect(display[0]).toMatchObject({ activity: { parentCallId, label: expect.stringMatching(/^↳ /) } });
});

test("malformed parent cycles do not hide or duplicate tool rows", () => {
  const display = buildChatDisplayItems([
    tool("call_a", "read", { parentCallId: "call_b" as ToolCallId }),
    tool("call_b", "read", { parentCallId: "call_a" as ToolCallId }),
  ]);
  expect(display.map((item) => item.id)).toEqual(["tool:call_a", "tool:call_b"]);
});
