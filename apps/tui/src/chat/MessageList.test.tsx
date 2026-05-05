import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ScrollBoxRenderable } from "@opentui/core";
import { act, createRef } from "react";
import type { ChatSessionView, ChatTranscriptItem } from "@chili/sdk";
import type { MessageId, PartId, ToolCallId } from "@chili/protocol";
import { resolveTuiTheme } from "../theme/index.js";
import { charDisplayWidth, markdownToTerminalLines, type MarkdownRenderOptions, type MarkdownTerminalLine } from "./markdown.js";
import { MessageList } from "./MessageList.js";
import { buildChatDisplayItems } from "./presentation.js";
import { HistoryRenderModel } from "./render-model.js";
import { splitStreamingMarkdown } from "./streaming.js";
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
  expect(text).toContain("| A   | B   |");
});

test("assistant markdown renders aligned terminal tables", () => {
  const markdown = [
    "| Name | Count | State |",
    "| :--- | ---: | :---: |",
    "| alpha | 7 | ok |",
    "| longer name | 1234 | hold |",
  ].join("\n");

  const lines = markdownToTerminalLines(markdown, {
    key: "markdown-table",
    width: 80,
    prefix: "AI: ",
    hangingIndent: "    ",
  });
  const text = lines.map((line) => line.text);

  expect(text).toEqual([
    "AI: | Name        | Count | State |",
    "    | :---------- | ----: | :---: |",
    "    | alpha       |     7 |  ok   |",
    "    | longer name |  1234 | hold  |",
  ]);
  expect(lines[1]?.tone).toBe("muted");
  expect(text.every((line) => displayWidth(line) <= 80)).toBe(true);
});

test("assistant markdown table falls back to readable rows when narrow", () => {
  const markdown = [
    "| Name | Count | State |",
    "| :--- | ---: | :---: |",
    "| alpha | 7 | ok |",
  ].join("\n");

  const text = markdownToTerminalLines(markdown, {
    key: "markdown-table-narrow",
    width: 22,
    prefix: "AI: ",
    hangingIndent: "    ",
  }).map((line) => line.text);

  expect(text).toEqual([
    "AI: - Name: alpha",
    "      Count: 7",
    "      State: ok",
  ]);
});

test("streaming assistant plain text keeps the active tail line separate", async () => {
  const initial = splitStreamingMarkdown("Stable line\npartial");
  const updated = splitStreamingMarkdown("Stable line\npartial answer");
  expect(initial).toEqual({ stableText: "Stable line\n", activeTail: "partial" });
  expect(updated.stableText).toBe(initial.stableText);
  expect(updated.activeTail).toBe("partial answer");
  expect(splitStreamingMarkdown("Stable line\ncomplete line\n")).toEqual({
    stableText: "Stable line\ncomplete line\n",
    activeTail: "",
  });

  const frame = await renderMessageList([
    {
      id: "msg_streaming" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [
        { type: "text", id: "part_streaming" as PartId, text: "Stable line\npartial answer" },
      ],
    },
  ], { status: "running" });

  expect(occurrences(frame, "Stable line")).toBe(1);
  expect(occurrences(frame, "partial answer")).toBe(1);
});

test("streaming assistant text does not prematurely close unfinished code fences", async () => {
  const split = splitStreamingMarkdown("Intro\n\n```ts\nconst ok");
  expect(split).toEqual({ stableText: "Intro\n\n", activeTail: "```ts\nconst ok" });
  expect(splitStreamingMarkdown("Intro\n\n~~~\nconst ok")).toEqual({
    stableText: "Intro\n\n",
    activeTail: "~~~\nconst ok",
  });
  expect(splitStreamingMarkdown("```ts\nconst ok = true;\n```\nnext")).toEqual({
    stableText: "```ts\nconst ok = true;\n```\n",
    activeTail: "next",
  });

  const frame = await renderMessageList([
    {
      id: "msg_streaming_fence" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [
        { type: "text", id: "part_streaming_fence" as PartId, text: "Intro\n\n```ts\nconst ok" },
      ],
    },
  ], { status: "running" });

  expect(frame).toContain("Intro");
  expect(frame).toContain("const ok");
  expect(frame).not.toContain("🌶️:");
  expect(occurrences(frame, "```")).toBe(1);
});

test("hidden thinking masks reasoning text", async () => {
  const frame = await renderMessageList([
    {
      id: "msg_reasoning_hidden" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [
        { type: "reasoning", id: "part_reasoning_hidden" as PartId, text: "checking a sensitive plan" },
        { type: "text", id: "part_answer_hidden" as PartId, text: "final answer" },
      ],
    },
  ], { hideThinking: true });

  expect(frame).toContain("🫧");
  expect(frame).not.toContain("checking a sensitive plan");
  expect(frame).toContain("final answer");
});

test("hidden thinking masks intermediate assistant text before tool calls", async () => {
  const callId = "toolcall_hidden_thinking_text" as ToolCallId;
  const frame = await renderMessageList([
    {
      id: "msg_tool_thinking_hidden" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [
        { type: "reasoning", id: "part_hidden_reasoning" as PartId, text: "deciding which file to inspect" },
        { type: "text", id: "part_hidden_text" as PartId, text: "Let me inspect the prompt handling." },
        {
          type: "tool_call",
          id: "part_hidden_call" as PartId,
          callId,
          toolName: "read",
          status: "completed",
          input: { file: "apps/tui/src/ChatShellApp.tsx" },
          displayStatus: "succeeded",
        },
      ],
    },
    chatTool(callId, "read", "completed", "succeeded", { title: "read", path: "apps/tui/src/ChatShellApp.tsx", detail: "apps/tui/src/ChatShellApp.tsx" }),
  ], { hideThinking: true });

  expect(frame).toContain("🫧");
  expect(occurrences(frame, "🫧")).toBe(1);
  expect(frame).toContain("Read ChatShellApp.tsx");
  expect(frame).not.toContain("deciding which file");
  expect(frame).not.toContain("🌶️: Let me inspect");
});

test("hidden thinking masks live assistant text before a tool call arrives", async () => {
  const frame = await renderMessageList([
    {
      id: "msg_live_trace_hidden" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [
        { type: "text", id: "part_live_trace_hidden" as PartId, text: "Let me inspect the prompt handling." },
      ],
    },
  ], { hideThinking: true, status: "running" });

  expect(frame).toContain("🫧 thinking...");
  expect(frame).not.toContain("🌶️: Let me inspect");
});

test("hidden thinking shows completed assistant text without tool calls", async () => {
  const frame = await renderMessageList([
    {
      id: "msg_final_answer_visible" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [
        { type: "text", id: "part_final_answer_visible" as PartId, text: "Final answer is visible." },
      ],
    },
  ], { hideThinking: true, status: "idle" });

  expect(frame).toContain("Final answer is visible.");
  expect(frame).not.toContain("🫧 thinking...");
});

test("streaming markdown keeps the last growing block active", () => {
  expect(splitStreamingMarkdown("# Plan\n\n- first\n- sec")).toEqual({
    stableText: "# Plan\n\n",
    activeTail: "- first\n- sec",
  });
  expect(splitStreamingMarkdown("# Plan\n\nNext paragraph")).toEqual({
    stableText: "# Plan\n\n",
    activeTail: "Next paragraph",
  });
  expect(splitStreamingMarkdown("Intro\n\n## Section")).toEqual({
    stableText: "Intro\n\n",
    activeTail: "## Section",
  });
  expect(splitStreamingMarkdown("Intro\n\nUse `code` and **bold**")).toEqual({
    stableText: "Intro\n\n",
    activeTail: "Use `code` and **bold**",
  });
});

test("streaming markdown can stabilize text at complete block boundaries", () => {
  expect(splitStreamingMarkdown("# Plan\n")).toEqual({
    stableText: "# Plan\n",
    activeTail: "",
  });
  expect(splitStreamingMarkdown("# Plan\n\n- first\n\n")).toEqual({
    stableText: "# Plan\n\n- first\n\n",
    activeTail: "",
  });
  expect(splitStreamingMarkdown("# Plan\n\nNext paragraph\n\n")).toEqual({
    stableText: "# Plan\n\nNext paragraph\n\n",
    activeTail: "",
  });
  expect(splitStreamingMarkdown("# Plan\n\n```ts\nconst ok = true;\n```\n")).toEqual({
    stableText: "# Plan\n\n```ts\nconst ok = true;\n```\n",
    activeTail: "",
  });
});

test("completed assistant markdown keeps block rendering", async () => {
  const frame = await renderMessageList([
    {
      id: "msg_completed_markdown" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      completedAt: 2,
      parts: [
        { type: "text", id: "part_completed_markdown" as PartId, text: "# Done\n\n- ship it\n\n```ts\nconst ok = true;\n```" },
      ],
    },
  ]);

  expect(frame).toContain("# Done");
  expect(frame).toContain("- ship it");
  expect(frame).toContain("const ok = true;");
  expect(frame).not.toContain("🌶️:");
  expect(frame).not.toContain("```ts");
});

test("assistant markdown table uses native table rendering in the message list", async () => {
  const frame = await renderMessageList([
    {
      id: "msg_native_table" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      completedAt: 2,
      parts: [
        {
          type: "text",
          id: "part_native_table" as PartId,
          text: "| Name | Count |\n| --- | ---: |\n| alpha | 7 |\n| beta | 12 |",
        },
      ],
    },
  ]);

  expect(frame).toContain("Name");
  expect(frame).toContain("alpha");
  expect(frame).toContain("┌");
  expect(frame).toContain("┬");
  expect(frame).toContain("│Name");
  expect(frame).toContain("│alpha");
  expect(frame).not.toContain("│ Name");
  expect(frame).not.toContain("🌶️:");
  expect(frame).not.toContain("| ---");
});

test("long assistant markdown scrolls inside the native scrollbox", async () => {
  const text = Array.from({ length: 12 }, (_, index) => `long line ${String(index + 1).padStart(2, "0")}`).join("\n");
  const items: ChatTranscriptItem[] = [
    {
      id: "msg_long_markdown_scroll" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      completedAt: 2,
      parts: [
        { type: "text", id: "part_long_markdown_scroll" as PartId, text },
      ],
    },
  ];

  const app = await renderMessageListApp(items, { height: 6, width: 100 });

  try {
    expect(app.frame()).toContain("long line 12");
    expect(app.frame()).not.toContain("long line 01");

    await app.scrollBy(-7);

    expect(app.frame()).toContain("long line 01");
    expect(app.frame()).not.toContain("long line 12");
  } finally {
    app.destroy();
  }
});

test("history render model caches completed assistant markdown lines by part identity and content", () => {
  const calls: string[] = [];
  const model = new HistoryRenderModel({
    maxMarkdownEntries: 8,
    markdownRenderer: countingMarkdownRenderer(calls),
  });
  const options = {
    key: "display:assistant_text:msg_1:part_1:0",
    text: "# Done\n\n- ship it",
    width: 48,
    prefix: "🌶️: ",
    hangingIndent: "    ",
  };

  const first = model.assistantTextLines(options).map((line) => line.text);
  const second = model.assistantTextLines(options).map((line) => line.text);
  expect(second).toEqual(first);
  expect(calls).toHaveLength(1);
  expect(model.cacheStats()).toMatchObject({
    markdownCacheHits: 1,
    markdownCacheMisses: 1,
    markdownCacheSize: 1,
  });

  model.assistantTextLines({ ...options, key: "display:assistant_text:msg_2:part_1:0" });
  model.assistantTextLines({ ...options, text: "# Done\n\n- ship it now" });
  model.assistantTextLines({ ...options, prefix: "AI: " });
  model.assistantTextLines({ ...options, hangingIndent: "  " });
  expect(calls).toHaveLength(5);
});

test("history render model rewraps assistant markdown when width changes", () => {
  const calls: string[] = [];
  const model = new HistoryRenderModel({ markdownRenderer: countingMarkdownRenderer(calls) });
  const options = {
    key: "display:assistant_text:msg_width:part_width:0",
    text: "abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz",
    prefix: "🌶️: ",
    hangingIndent: "    ",
  };

  const narrow = model.assistantTextLines({ ...options, width: 16 }).map((line) => line.text);
  const wide = model.assistantTextLines({ ...options, width: 96 }).map((line) => line.text);
  model.assistantTextLines({ ...options, width: 96 });

  expect(calls).toHaveLength(2);
  expect(narrow.length).toBeGreaterThan(wide.length);
  expect(model.cacheStats()).toMatchObject({
    markdownCacheHits: 1,
    markdownCacheMisses: 2,
  });
});

test("history render model caches streaming stable markdown and wraps only the active tail", () => {
  const calls: string[] = [];
  const model = new HistoryRenderModel({ markdownRenderer: countingMarkdownRenderer(calls) });
  const options = {
    key: "display:assistant_text:msg_stream_cache:part_stream_cache:0",
    streaming: true,
    width: 40,
    prefix: "🌶️: ",
    hangingIndent: "    ",
  };

  const first = model.assistantTextLines({ ...options, text: "# Plan\n\npartial" }).map((line) => line.text).join("\n");
  const second = model.assistantTextLines({ ...options, text: "# Plan\n\npartial answer" }).map((line) => line.text).join("\n");

  expect(calls).toEqual(["# Plan\n\n"]);
  expect(first).toContain("# Plan");
  expect(first).toContain("partial");
  expect(second).toContain("partial answer");
  expect(calls.some((source) => source.includes("partial"))).toBe(false);
  expect(model.cacheStats()).toMatchObject({
    markdownCacheHits: 1,
    markdownCacheMisses: 1,
  });
});

test("history render model bounds assistant markdown line cache", () => {
  const calls: string[] = [];
  const model = new HistoryRenderModel({
    maxMarkdownEntries: 2,
    markdownRenderer: countingMarkdownRenderer(calls),
  });
  const base = {
    width: 40,
    prefix: "🌶️: ",
    hangingIndent: "    ",
  };

  model.assistantTextLines({ ...base, key: "assistant:one", text: "one" });
  model.assistantTextLines({ ...base, key: "assistant:two", text: "two" });
  model.assistantTextLines({ ...base, key: "assistant:three", text: "three" });
  model.assistantTextLines({ ...base, key: "assistant:one", text: "one" });

  expect(calls).toHaveLength(4);
  expect(model.cacheStats()).toMatchObject({
    markdownCacheEvictions: 2,
    markdownCacheSize: 2,
  });
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

  expect(frame).toContain("Done with");
  expect(frame).toContain("tests");
  expect(frame).not.toContain("🌶️:");
  expect(frame).toContain("Ran bun test");
  expect(occurrences(frame, "Ran bun test")).toBe(1);
  expect(frame).not.toContain("tool_call");
  expect(frame).not.toContain("tool_result");
  expect(frame).not.toContain("RAW_TOOL_OUTPUT_SHOULD_NOT_RENDER");
});

test("same running tool call updates in place by id", () => {
  const id = "tool_same_call" as ToolCallId;
  const running = buildChatDisplayItems([
    chatTool(id, "bash", "running", "running", { title: "bash", command: "bun test", detail: "bun test" }),
  ]);
  const succeeded = buildChatDisplayItems([
    chatTool(id, "bash", "completed", "succeeded", { title: "bash", command: "bun test", detail: "bun test" }),
  ]);

  expect(running).toHaveLength(1);
  expect(succeeded).toHaveLength(1);
  expect(running[0]).toMatchObject({ kind: "tool_activity", activity: { id, label: "Running bun test" } });
  expect(succeeded[0]).toMatchObject({ kind: "tool_activity", activity: { id, label: "Ran bun test" } });
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

test("exploration group labels pending and failed runs naturally", () => {
  const running = buildChatDisplayItems([
    chatTool("read_running" as ToolCallId, "read", "running", "running", { title: "read", path: "package.json", detail: "package.json" }),
    chatTool("grep_done" as ToolCallId, "grep", "completed", "succeeded", { title: "grep", pattern: "TODO", scope: "apps/tui", detail: "TODO in apps/tui" }),
  ]);
  const failed = buildChatDisplayItems([
    chatTool("read_failed" as ToolCallId, "read", "failed", "failed", { title: "read", path: "package.json", detail: "package.json" }, { error: "read failed" }),
    chatTool("grep_after_failed" as ToolCallId, "grep", "completed", "succeeded", { title: "grep", pattern: "TODO", scope: "apps/tui", detail: "TODO in apps/tui" }),
  ]);

  expect(running[0]).toMatchObject({
    kind: "tool_group",
    label: "Exploring 1 file, searched 1 pattern",
    tone: "pending",
  });
  expect(failed[0]).toMatchObject({
    kind: "tool_group",
    label: "Explored 1 file, searched 1 pattern with errors",
    tone: "error",
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
  expect(occurrences(details, "output:")).toBe(3);
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

test("running command rows show live output tail without exposing completed live output", async () => {
  const running = chatTool("tool_live_output" as ToolCallId, "bash", "running", "running", { title: "bash", command: "npm install", detail: "npm install" }, {
    liveOutput: [
      { stream: "stdout", delta: "live_01\nlive_02\nlive_03\nlive_04\n", time: 1 },
      { stream: "stderr", delta: "warn_05\n", time: 2 },
      { stream: "stdout", delta: "live_06\n", time: 3 },
    ],
  });
  const completed = chatTool("tool_completed_live_output" as ToolCallId, "bash", "completed", "succeeded", { title: "bash", command: "npm install", detail: "npm install" }, {
    output: "FINAL_OUTPUT_SHOULD_STAY_COMPACT",
    liveOutput: [
      { stream: "stdout", delta: "LIVE_OUTPUT_SHOULD_NOT_RENDER_AFTER_SUCCESS\n", time: 1 },
    ],
  });

  const runningFrame = await renderMessageList([running], { height: 16 });
  const completedFrame = await renderMessageList([completed], { height: 8 });

  expect(runningFrame).toContain("Running npm install");
  expect(runningFrame).toContain("live output (truncated):");
  expect(runningFrame).not.toContain("error (truncated):");
  expect(runningFrame).not.toContain("live_01");
  expect(runningFrame).toContain("live_02");
  expect(runningFrame).toContain("warn_05");
  expect(runningFrame).toContain("live_06");
  expect(completedFrame).toContain("Ran npm install");
  expect(completedFrame).not.toContain("LIVE_OUTPUT_SHOULD_NOT_RENDER_AFTER_SUCCESS");
  expect(completedFrame).not.toContain("FINAL_OUTPUT_SHOULD_STAY_COMPACT");
});

test("tool details show a longer live output tail", async () => {
  const item = chatTool("tool_live_output_details" as ToolCallId, "bash", "running", "running", { title: "bash", command: "npm install", detail: "npm install" }, {
    input: { command: "npm install" },
    liveOutput: [
      { stream: "stdout", delta: Array.from({ length: 8 }, (_, index) => `detail_live_${index + 1}`).join("\n"), time: 1 },
    ],
  });

  const frame = await renderMessageList([item], { showToolDetails: true, height: 24 });

  expect(frame).toContain("Running npm install");
  expect(frame).toContain("live output:");
  expect(frame).toContain("detail_live_1");
  expect(frame).toContain("detail_live_8");
  expect(frame).not.toContain("output hidden");
});

test("tool details scroll as a full component in the native scrollbox", async () => {
  const output = Array.from({ length: 20 }, (_, index) => `slice_line_${String(index + 1).padStart(2, "0")}`).join("\n");
  const item = chatTool("tool_slice_output" as ToolCallId, "bash", "completed", "succeeded", { title: "bash", command: "bun test", detail: "bun test" }, {
    output,
  });

  const app = await renderMessageListApp([item], { showToolDetails: true, height: 5, width: 120 });

  try {
    expect(app.frame()).toContain("slice_line_05");
    expect(app.frame()).not.toContain("Ran bun test");

    await app.scrollBy(-3);

    expect(app.frame()).toContain("Ran bun test");
    expect(app.frame()).toContain("output (truncated):");
    expect(app.frame()).toContain("slice_line_01");
  } finally {
    app.destroy();
  }
});

test("block tool details render the cell body without duplicating the primary detail", async () => {
  const diff = "diff --git a/src/example.ts b/src/example.ts\n+const ok = true;";
  const item = chatTool("tool_diff_body" as ToolCallId, "git_diff", "completed", "succeeded", { title: "git_diff", detail: "src/example.ts" }, {
    output: diff,
  });

  const compact = await renderMessageList([item], { height: 18 });
  const details = await renderMessageList([item], { showToolDetails: true, height: 28 });

  expect(compact).toContain("Read git diff src/example.ts");
  expect(compact).toContain("output hidden (2 lines, details available)");
  expect(compact).not.toContain("+const ok = true;");
  expect(details).toContain("diff:");
  expect(details).toContain("diff --git a/src/example.ts b/src/example.ts");
  expect(details).toContain("+const ok = true;");
  expect(details).not.toContain("output:");
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
  options: { showToolDetails?: boolean; hideThinking?: boolean; width?: number; height?: number; status?: ChatSessionView["status"]; activeTools?: ChatSessionView["activeTools"] } = {},
): Promise<string> {
  const app = await renderMessageListApp(items, options);
  try {
    return app.frame();
  } finally {
    app.destroy();
  }
}

async function renderMessageListApp(
  items: readonly ChatTranscriptItem[],
  options: { showToolDetails?: boolean; hideThinking?: boolean; width?: number; height?: number; status?: ChatSessionView["status"]; activeTools?: ChatSessionView["activeTools"] } = {},
): Promise<{
  frame: () => string;
  scrollBy: (delta: number) => Promise<void>;
  destroy: () => void;
}> {
  const scrollRef = createRef<ScrollBoxRenderable>();
  const app = await testRender(
    <MessageList
      chatView={chatView(items, options)}
      localItems={[]}
      width={options.width ?? 110}
      scrollRef={scrollRef}
      showToolDetails={options.showToolDetails === true}
      hideThinking={options.hideThinking === true}
      theme={resolveTuiTheme("chili-dark", {})}
    />,
    { width: options.width ?? 120, height: options.height ?? 24, exitOnCtrlC: false },
  );

  try {
    await act(async () => {
      await app.renderOnce();
    });
    return {
      frame: () => app.captureCharFrame(),
      scrollBy: async (delta: number) => {
        await act(async () => {
          scrollRef.current?.scrollBy(delta);
          await app.renderOnce();
        });
      },
      destroy: () => app.renderer.destroy(),
    };
  } catch (error) {
    app.renderer.destroy();
    throw error;
  }
}

function chatView(items: readonly ChatTranscriptItem[], options: { status?: ChatSessionView["status"]; activeTools?: ChatSessionView["activeTools"] } = {}): ChatSessionView {
  return {
    status: options.status ?? "idle",
    items: [...items],
    pendingApprovals: [],
    activeTools: options.activeTools ?? [],
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function displayWidth(value: string): number {
  return [...value].reduce((sum, char) => sum + charDisplayWidth(char), 0);
}

function countingMarkdownRenderer(calls: string[]): (text: string, options: MarkdownRenderOptions) => MarkdownTerminalLine[] {
  return (text, options) => {
    calls.push(text);
    return markdownToTerminalLines(text, options);
  };
}

function chatTool(
  id: ToolCallId,
  toolName: string,
  status: Extract<ChatTranscriptItem, { kind: "tool" }>["status"],
  displayStatus: Extract<ChatTranscriptItem, { kind: "tool" }>["displayStatus"],
  inputSummary: Extract<ChatTranscriptItem, { kind: "tool" }>["inputSummary"],
  extra: Partial<Pick<Extract<ChatTranscriptItem, { kind: "tool" }>, "output" | "error" | "input" | "liveOutput">> = {},
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
