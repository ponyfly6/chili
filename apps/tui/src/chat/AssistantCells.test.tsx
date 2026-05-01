import { beforeEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { resolveTuiTheme } from "../theme/index.js";
import {
  AssistantMarkdownCell,
  AssistantTextCell,
  assistantMarkdownBlockCacheStats,
  assistantMarkdownBlocks,
  assistantTextCellLines,
  clearAssistantMarkdownBlockCache,
} from "./AssistantCells.js";
import { componentBackedCell, TranscriptCellSliceView, windowTranscriptCells } from "./cells.js";
import type { TranscriptLineModel } from "./lines.js";

const theme = resolveTuiTheme("chili-dark", {});

beforeEach(() => {
  clearAssistantMarkdownBlockCache();
});

test("assistant text cell lines keep completed markdown output", async () => {
  const lines = assistantTextCellLines({
    key: "assistant:completed",
    text: "# Done\n\n- ship it\n\n```ts\nconst ok = true;\n```",
    streaming: false,
    width: 96,
    theme,
  });
  const text = lineText(lines).join("\n");
  const frame = await renderAssistantCell(lines);

  expect(text).toContain("# Done");
  expect(text).toContain("- ship it");
  expect(text).toContain("```ts");
  expect(text).toContain("const ok = true;");
  expect(frame).toContain("# Done");
  expect(frame).toContain("- ship it");
  expect(frame).toContain("const ok = true;");
});

test("assistant markdown cell renders rich heading list code diff and quote blocks", async () => {
  const text = [
    "# Plan",
    "",
    "- inspect `MessageList`",
    "- ship it",
    "",
    "```ts",
    "const ok = true;",
    "```",
    "",
    "```diff",
    "-old",
    "+new",
    " context",
    "```",
    "",
    "> compact by default",
  ].join("\n");
  const fallbackLines = assistantTextCellLines({
    key: "assistant:rich",
    text,
    streaming: false,
    width: 96,
    theme,
  });
  const blocks = assistantMarkdownBlocks({
    cellKey: "assistant:rich",
    text,
    streaming: false,
    width: 96,
    theme,
  });
  const frame = await renderAssistantMarkdownCell({
    cellKey: "assistant:rich",
    text,
    streaming: false,
    width: 96,
    fallbackLines,
  });

  expect(blocks.map((block) => block.kind)).toEqual(["heading", "list", "code", "diff", "blockquote"]);
  expect(frame).toContain("# Plan");
  expect(frame).toContain("- inspect `MessageList`");
  expect(frame).toContain("```ts");
  expect(frame).toContain("const ok = true;");
  expect(frame).toContain("```diff");
  expect(frame).toContain("-old");
  expect(frame).toContain("+new");
  expect(frame).toContain("> compact by default");

  const diffBlock = blocks.find((block) => block.kind === "diff");
  expect(diffBlock?.lines.find((line) => line.text.includes("+new"))?.fg).toBe(theme.colors.status.success);
  expect(diffBlock?.lines.find((line) => line.text.includes("-old"))?.fg).toBe(theme.colors.status.error);
});

test("assistant rich markdown cache hits for repeated completed content", () => {
  const input = {
    cellKey: "assistant:cache-hit",
    text: "# Cached\n\n- one",
    streaming: false,
    width: 96,
    theme,
  };

  const first = assistantMarkdownBlocks(input);
  const second = assistantMarkdownBlocks(input);

  expect(second).toBe(first);
  expect(assistantMarkdownBlockCacheStats()).toMatchObject({
    hits: 1,
    misses: 1,
    evictions: 0,
    size: 1,
  });
});

test("assistant rich markdown cache misses when width changes", () => {
  const base = {
    cellKey: "assistant:cache-width",
    text: "abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz",
    streaming: false,
    theme,
  };

  const narrow = assistantMarkdownBlocks({ ...base, width: 20 });
  const wide = assistantMarkdownBlocks({ ...base, width: 96 });

  expect(wide).not.toBe(narrow);
  expect(assistantMarkdownBlockCacheStats()).toMatchObject({
    hits: 0,
    misses: 2,
    size: 2,
  });
});

test("assistant rich markdown cache misses when text changes", () => {
  const base = {
    cellKey: "assistant:cache-text",
    streaming: false,
    width: 96,
    theme,
  };

  const first = assistantMarkdownBlocks({ ...base, text: "# One" });
  const second = assistantMarkdownBlocks({ ...base, text: "# Two" });

  expect(second).not.toBe(first);
  expect(assistantMarkdownBlockCacheStats()).toMatchObject({
    hits: 0,
    misses: 2,
    size: 2,
  });
});

test("assistant rich markdown cache guards against text hash collisions", () => {
  const base = {
    cellKey: "assistant:cache-collision",
    streaming: false,
    width: 96,
    theme,
  };

  const first = assistantMarkdownBlocks({ ...base, text: "zgDib656" });
  const second = assistantMarkdownBlocks({ ...base, text: "kHML6ZQx" });

  expect(second).not.toBe(first);
  expect(lineText(second.flatMap((block) => block.lines)).join("\n")).toContain("kHML6ZQx");
  expect(lineText(second.flatMap((block) => block.lines)).join("\n")).not.toContain("zgDib656");
  expect(assistantMarkdownBlockCacheStats()).toMatchObject({
    hits: 0,
    misses: 2,
    size: 1,
  });
});

test("assistant text cell lines keep streaming stable and tail rendering", () => {
  const initial = assistantTextCellLines({
    key: "assistant:streaming",
    text: "# Plan\n\npartial",
    streaming: true,
    width: 80,
    theme,
  });
  const updated = assistantTextCellLines({
    key: "assistant:streaming",
    text: "# Plan\n\npartial answer",
    streaming: true,
    width: 80,
    theme,
  });

  expect(lineText(initial).join("\n")).toContain("# Plan");
  expect(lineText(initial).join("\n")).toContain("partial");
  expect(lineText(updated).join("\n")).toContain("# Plan");
  expect(lineText(updated).join("\n")).toContain("partial answer");
});

test("assistant text cell lines keep unfinished streaming code fences open", async () => {
  const lines = assistantTextCellLines({
    key: "assistant:streaming-fence",
    text: "Intro\n\n```ts\nconst ok",
    streaming: true,
    width: 80,
    theme,
  });
  const text = lineText(lines).join("\n");

  expect(text).toContain("🌶️: Intro");
  expect(text).toContain("```ts");
  expect(text).toContain("const ok");
  expect(occurrences(text, "```")).toBe(1);

  const frame = await renderAssistantMarkdownCell({
    cellKey: "assistant:streaming-fence",
    text: "Intro\n\n```ts\nconst ok",
    streaming: true,
    width: 80,
    fallbackLines: lines,
  });

  expect(frame).toContain("Intro");
  expect(frame).toContain("```ts");
  expect(frame).toContain("const ok");
  expect(occurrences(frame, "```")).toBe(1);
  expect(assistantMarkdownBlockCacheStats()).toMatchObject({
    hits: 0,
    misses: 0,
    size: 0,
  });
});

test("assistant text cell lines rewrap when width changes", () => {
  const text = "abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz";
  const narrow = assistantTextCellLines({
    key: "assistant:width",
    text,
    streaming: false,
    width: 16,
    theme,
  });
  const wide = assistantTextCellLines({
    key: "assistant:width",
    text,
    streaming: false,
    width: 96,
    theme,
  });
  const repeatedWide = assistantTextCellLines({
    key: "assistant:width",
    text,
    streaming: false,
    width: 96,
    theme,
  });

  expect(narrow.length).toBeGreaterThan(wide.length);
  expect(repeatedWide).toEqual(wide);
});

test("assistant markdown component cells use fallback line count for partial slices", async () => {
  const text = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n");
  const fallbackLines = assistantTextCellLines({
    key: "assistant:slice",
    text,
    streaming: false,
    width: 96,
    theme,
  });
  const cell = componentBackedCell({
    key: "assistant:slice",
    render: () => (
      <AssistantMarkdownCell
        cellKey="assistant:slice"
        text={text}
        streaming={false}
        width={96}
        theme={theme}
        fallbackLines={fallbackLines}
      />
    ),
    fallbackLines,
  });
  const window = windowTranscriptCells([cell], { visibleLimit: 3 });
  const frame = await renderCellSlice(window.slices[0]!);

  expect(cell.lineCount).toBe(fallbackLines.length);
  expect(window.slices[0]).toMatchObject({
    startLine: fallbackLines.length - 2,
    endLine: fallbackLines.length,
  });
  expect(frame).toContain("line 7");
  expect(frame).toContain("line 8");
  expect(frame).not.toContain("line 1");
});

test("assistant markdown component full render stays rich while partial slices use fallback lines", async () => {
  const text = "# Rich visible\n\n- rendered component";
  const fallbackLines = [
    line("fallback:1", "FALLBACK one"),
    line("fallback:2", "FALLBACK two"),
    line("fallback:3", "FALLBACK three"),
  ];
  const cell = componentBackedCell({
    key: "assistant:full-vs-partial",
    render: () => (
      <AssistantMarkdownCell
        cellKey="assistant:full-vs-partial"
        text={text}
        streaming={false}
        width={96}
        theme={theme}
        fallbackLines={fallbackLines}
      />
    ),
    fallbackLines,
  });

  const fullWindow = windowTranscriptCells([cell], { visibleLimit: 5 });
  const partialWindow = windowTranscriptCells([cell], { visibleLimit: 2 });
  const fullFrame = await renderCellSlice(fullWindow.slices[0]!);
  const partialFrame = await renderCellSlice(partialWindow.slices[0]!);

  expect(cell.lineCount).toBe(3);
  expect(fullFrame).toContain("# Rich visible");
  expect(fullFrame).toContain("- rendered component");
  expect(fullFrame).not.toContain("FALLBACK");
  expect(partialFrame).toContain("FALLBACK three");
  expect(partialFrame).not.toContain("# Rich visible");
});

async function renderAssistantCell(lines: readonly TranscriptLineModel[]): Promise<string> {
  const app = await testRender(
    <AssistantTextCell lines={lines} />,
    { width: 100, height: 12, exitOnCtrlC: false },
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

async function renderAssistantMarkdownCell(input: {
  cellKey: string;
  text: string;
  streaming: boolean;
  width: number;
  fallbackLines: readonly TranscriptLineModel[];
}): Promise<string> {
  const app = await testRender(
    <AssistantMarkdownCell
      cellKey={input.cellKey}
      text={input.text}
      streaming={input.streaming}
      width={input.width}
      theme={theme}
      fallbackLines={input.fallbackLines}
    />,
    { width: Math.max(100, input.width + 4), height: 24, exitOnCtrlC: false },
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

async function renderCellSlice(slice: Parameters<typeof TranscriptCellSliceView>[0]["slice"]): Promise<string> {
  const app = await testRender(
    <box flexDirection="column">
      <TranscriptCellSliceView slice={slice} />
    </box>,
    { width: 100, height: 10, exitOnCtrlC: false },
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

function lineText(lines: readonly TranscriptLineModel[]): string[] {
  return lines.map((line) => line.text);
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function line(key: string, text: string): TranscriptLineModel {
  return { key, text, fg: theme.colors.text.secondary };
}
