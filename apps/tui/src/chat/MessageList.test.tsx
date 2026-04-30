import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { ChatSessionView, ChatTranscriptItem } from "@chili/sdk";
import type { MessageId, PartId, ToolCallId } from "@chili/protocol";
import { resolveTuiTheme } from "../theme/index.js";
import { markdownToTerminalLines } from "./markdown.js";
import { MessageList } from "./MessageList.js";
import { buildChatDisplayItems } from "./presentation.js";
import { renderToolActivity } from "./tool-renderers.js";

test("assistant markdown renders readable terminal lines", () => {
  const markdown = [
    "# Plan",
    "",
    "- inspect `MessageList`",
    "- hide tool output",
    "",
    "```ts",
    "const ok = true;",
    "```",
    "",
    "> compact by default",
    "",
    "[docs](https://example.test)",
    "",
    "| A | B |",
    "| - | - |",
    "| 1 | 2 |",
  ].join("\n");

  const text = markdownToTerminalLines(markdown, { key: "markdown-test", width: 96 }).map((line) => line.text).join("\n");

  expect(text).toContain("# Plan");
  expect(text).toContain("- inspect `MessageList`");
  expect(text).toContain("```ts");
  expect(text).toContain("const ok = true;");
  expect(text).toContain("> compact by default");
  expect(text).toContain("docs (https://example.test)");
  expect(text).toContain("| A | B |");
});

test("assistant tool parts stay out of default chat text while tool rows render compact activity", async () => {
  const callId = "toolcall_hidden_raw" as ToolCallId;
  const frame = await renderMessageList([
    {
      id: "msg_tool_parts" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [
        { type: "text", id: "part_text" as PartId, text: "Done with **tests**." },
        {
          type: "tool_call",
          id: "part_call" as PartId,
          callId,
          toolName: "bash",
          status: "completed",
          input: { command: "bun test" },
          displayStatus: "succeeded",
        },
        {
          type: "tool_result",
          id: "part_result" as PartId,
          callId,
          output: "RAW_TOOL_OUTPUT_SHOULD_NOT_RENDER",
        },
      ],
    },
    chatTool(callId, "bash", "completed", "succeeded", { title: "bash", command: "bun test", detail: "bun test" }, {
      output: "RAW_TOOL_OUTPUT_SHOULD_NOT_RENDER",
    }),
  ]);

  expect(frame).toContain("🌶️: Done with tests.");
  expect(frame).toContain("Ran bun test");
  expect(frame).not.toContain("tool_call");
  expect(frame).not.toContain("tool_result");
  expect(frame).not.toContain("RAW_TOOL_OUTPUT_SHOULD_NOT_RENDER");
});

test("consecutive exploration tools merge into a compact group", () => {
  const display = buildChatDisplayItems([
    chatTool("read_1" as ToolCallId, "read", "completed", "succeeded", { title: "read", path: "package.json", detail: "package.json" }),
    chatTool("grep_1" as ToolCallId, "grep", "completed", "succeeded", { title: "grep", pattern: "TODO", scope: "apps/tui", detail: "TODO in apps/tui" }),
    chatTool("glob_1" as ToolCallId, "glob", "completed", "succeeded", { title: "glob", pattern: "*.tsx", path: "apps/tui/src", detail: "*.tsx under apps/tui/src" }),
  ]);

  expect(display).toHaveLength(1);
  expect(display[0]).toMatchObject({
    kind: "tool_group",
    label: "Explored 1 file, searched 1 pattern, listed 1 path",
  });
});

test("exploration tool groups hide raw output when compact and expand in details mode", async () => {
  const items: ChatTranscriptItem[] = [
    chatTool("read_group_1" as ToolCallId, "read", "completed", "succeeded", { title: "read", path: "package.json", detail: "package.json" }, {
      input: { path: "package.json" },
      output: "FILE_RAW_LINE_1\nFILE_RAW_LINE_2",
    }),
    chatTool("grep_group_1" as ToolCallId, "grep", "completed", "succeeded", { title: "grep", pattern: "TODO", scope: "apps/tui", detail: "TODO in apps/tui" }, {
      input: { pattern: "TODO", path: "apps/tui" },
      output: "GREP_RAW_MATCH_1\nGREP_RAW_MATCH_2",
    }),
    chatTool("glob_group_1" as ToolCallId, "glob", "completed", "succeeded", { title: "glob", pattern: "*.tsx", path: "apps/tui/src", detail: "*.tsx under apps/tui/src" }, {
      input: { pattern: "*.tsx", path: "apps/tui/src" },
      output: "GLOB_RAW_PATH_1\nGLOB_RAW_PATH_2",
    }),
  ];

  const compact = await renderMessageList(items, { height: 16 });
  const details = await renderMessageList(items, { showToolDetails: true, height: 48 });

  expect(compact).toContain("Explored 1 file, searched 1 pattern, listed 1 path");
  expect(compact).not.toContain("FILE_RAW_LINE_1");
  expect(compact).not.toContain("GREP_RAW_MATCH_1");
  expect(compact).not.toContain("GLOB_RAW_PATH_1");
  expect(details).toContain("Explored 1 file, searched 1 pattern, listed 1 path");
  expect(details).toContain("Read package.json");
  expect(details).toContain("Searched TODO in apps/tui");
  expect(details).toContain("Listed *.tsx under apps/tui/src");
  expect(details).toContain("FILE_RAW_LINE_1");
  expect(details).toContain("GREP_RAW_MATCH_1");
  expect(details).toContain("GLOB_RAW_PATH_1");
  expect(details).not.toContain("output hidden");
});

test("large tool output is hidden by default and truncated in details mode", async () => {
  const output = Array.from({ length: 20 }, (_, index) => `line_${String(index + 1).padStart(2, "0")}`).join("\n");
  const item = chatTool("tool_big_output" as ToolCallId, "bash", "completed", "succeeded", { title: "bash", command: "bun test", detail: "bun test" }, {
    output,
  });

  const compact = await renderMessageList([item], { height: 18 });
  const details = await renderMessageList([item], { showToolDetails: true, height: 32 });

  expect(compact).toContain("Ran bun test");
  expect(compact).toContain("output hidden (20 lines, details available)");
  expect(compact).not.toContain("line_01");
  expect(details).toContain("output (truncated):");
  expect(details).not.toContain("output hidden");
  expect(details).toContain("line_01");
  expect(details).toContain("line_05");
  expect(details).not.toContain("line_06");
});

test("failed tools show a compact error summary", async () => {
  const error = ["first failure", "second failure", "third failure", "fourth failure", "fifth failure"].join("\n");
  const item = chatTool("tool_failed" as ToolCallId, "bash", "failed", "failed", { title: "bash", command: "bun test", detail: "bun test" }, { error });
  const frame = await renderMessageList([item]);
  const details = await renderMessageList([item], { showToolDetails: true, height: 24 });

  expect(frame).toContain("Failed bun test");
  expect(frame).toContain("error:");
  expect(frame).toContain("first failure");
  expect(frame).toContain("fourth failure");
  expect(frame).not.toContain("fifth failure");
  expect(details.match(/error:/g)).toHaveLength(1);
  expect(details).toContain("fifth failure");
});

test("unknown tools use the fallback renderer label", () => {
  const rendered = renderToolActivity({
    id: "tool_unknown",
    callId: "tool_unknown",
    toolName: "custom_probe",
    status: "completed",
    displayStatus: "succeeded",
    inputSummary: { title: "custom_probe", detail: "mystery target" },
    showToolDetails: false,
    source: "row",
  });

  expect(rendered.label).toBe("Ran custom_probe mystery target");
});

async function renderMessageList(
  items: readonly ChatTranscriptItem[],
  options: { showToolDetails?: boolean; width?: number; height?: number } = {},
): Promise<string> {
  const app = await testRender(
    <MessageList
      chatView={chatView(items)}
      localItems={[]}
      width={options.width ?? 110}
      visibleLimit={options.height ?? 24}
      showToolDetails={options.showToolDetails === true}
      theme={resolveTuiTheme("chili-dark", {})}
    />,
    { width: options.width ?? 120, height: options.height ?? 24, exitOnCtrlC: false },
  );

  try {
    await act(async () => {
      await app.renderOnce();
    });
    return app.captureCharFrame();
  } finally {
    app.renderer.destroy();
  }
}

function chatView(items: readonly ChatTranscriptItem[]): ChatSessionView {
  return {
    status: "idle",
    items: [...items],
    pendingApprovals: [],
    activeTools: [],
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
}

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
