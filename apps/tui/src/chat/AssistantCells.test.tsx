import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { Children, act, isValidElement, type ReactElement, type ReactNode } from "react";
import { resolveTuiTheme } from "../theme/index.js";
import {
  AssistantMarkdownCell,
  AssistantTextCell,
  assistantTextCellLines,
} from "./AssistantCells.js";
import { componentBackedCell, TranscriptCellSliceView, windowTranscriptCells } from "./cells.js";
import type { TranscriptLineModel } from "./lines.js";

const theme = resolveTuiTheme("chili-dark", {});

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

test("assistant markdown cell renders native heading list code diff and quote blocks", async () => {
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
  const frame = await renderAssistantMarkdownCell({
    cellKey: "assistant:rich",
    text,
    streaming: false,
    width: 96,
    fallbackLines,
  });

  expect(frame).toContain("# Plan");
  expect(frame).toContain("- inspect `MessageList`");
  expect(frame).toContain("const ok = true;");
  expect(frame).toContain("-old");
  expect(frame).toContain("+new");
  expect(frame).toContain("> compact by default");
  expect(frame).not.toContain("🌶️:");
  expect(frame).not.toContain("```ts");
  expect(frame).not.toContain("```diff");
});

test("assistant markdown cell keeps OpenTUI markdown as the native render path", () => {
  const text = "| Name | Count |\n| --- | ---: |\n| alpha | 7 |";
  const fallbackLines = [line("fallback:1", "FALLBACK")];
  const element = AssistantMarkdownCell({
    cellKey: "assistant:native-path",
    text,
    streaming: true,
    width: 72.8,
    theme,
    fallbackLines,
  });
  const markdown = findIntrinsicElement(element, "markdown");
  const box = findIntrinsicElement(element, "box");

  expect(box?.props).toMatchObject({
    width: 72,
    maxWidth: 72,
    flexDirection: "column",
    overflow: "hidden",
  });
  expect(markdown?.props).toMatchObject({
    content: text,
    width: "100%",
    maxWidth: "100%",
    fg: theme.colors.text.secondary,
    conceal: true,
    concealCode: false,
    streaming: true,
    internalBlockMode: "top-level",
    tableOptions: {
      style: "grid",
      widthMode: "content",
      columnFitter: "balanced",
      wrapMode: "word",
      cellPadding: 0,
      borders: true,
      outerBorder: true,
      borderStyle: "single",
      borderColor: theme.colors.border.default,
      selectable: true,
    },
  });
  expect(markdown?.props.syntaxStyle).toBeDefined();
  expect(markdown?.props.renderNode).toBeFunction();
});

test("assistant markdown cell renders compact native table while partial fallback remains plain text", async () => {
  const text = [
    "| Name | Count | State |",
    "| :--- | ---: | :---: |",
    "| alpha | 7 | ok |",
    "| longer name | 1234 | hold |",
  ].join("\n");
  const fallbackLines = assistantTextCellLines({
    key: "assistant:table",
    text,
    streaming: false,
    width: 80,
    theme,
  });
  const frame = await renderAssistantMarkdownCell({
    cellKey: "assistant:table",
    text,
    streaming: false,
    width: 80,
    fallbackLines,
  });
  const fallbackText = fallbackLines.map((line) => line.text).join("\n");

  expect(fallbackText).toContain("🌶️: | Name");
  expect(fallbackText).toContain("| alpha");
  expect(fallbackText).not.toContain("┌");
  expect(frame).toContain("Name");
  expect(frame).toContain("alpha");
  expect(frame).toContain("longer name");
  expect(frame).toContain("┌");
  expect(frame).toContain("┬");
  expect(frame).toContain("│Name");
  expect(frame).toContain("│alpha");
  expect(frame).not.toContain("│ Name");
  expect(frame).not.toContain("🌶️:");
  expect(frame).not.toContain(":---");
});

test("assistant markdown native table stays readable with narrow CJK and long cells", async () => {
  const text = [
    "| 名称 | Detail | 状态 |",
    "| --- | --- | --- |",
    "| 火锅 | very-long-cell-with-several-words for wrapping | 正常 |",
    "| 面 | compact | 等待 |",
  ].join("\n");
  const fallbackLines = assistantTextCellLines({
    key: "assistant:table-cjk",
    text,
    streaming: false,
    width: 44,
    theme,
  });
  const frame = await renderAssistantMarkdownCell({
    cellKey: "assistant:table-cjk",
    text,
    streaming: false,
    width: 44,
    fallbackLines,
  });

  expect(frame).toContain("名称");
  expect(frame).toContain("火锅");
  expect(frame).toContain("very");
  expect(frame).toContain("正常");
  expect(frame).toContain("┌");
  expect(frame).toContain("│名称");
  expect(frame).toContain("│火锅");
  expect(frame).not.toContain("🌶️:");
});

test("assistant markdown compact table conceals inline markdown markers", async () => {
  const text = [
    "| 分类 | 内容 |",
    "| --- | --- |",
    "| **CLI 命令** | `srt` |",
    "| **入口文件** | `src/cli.ts` |",
    "| **核心模块** | `src/sandbox/`（sandbox 管理器、平台适配器、schemas） |",
  ].join("\n");
  const fallbackLines = assistantTextCellLines({
    key: "assistant:table-inline",
    text,
    streaming: false,
    width: 92,
    theme,
  });
  const frame = await renderAssistantMarkdownCell({
    cellKey: "assistant:table-inline",
    text,
    streaming: false,
    width: 92,
    fallbackLines,
  });

  expect(frame).toContain("┌");
  expect(frame).toContain("┬");
  expect(frame).toContain("│分类");
  expect(frame).toContain("CLI 命令");
  expect(frame).toContain("src/sandbox/");
  expect(frame).not.toContain("**CLI 命令**");
  expect(frame).not.toContain("`srt`");
  expect(frame).not.toContain("`src/cli.ts`");
  expect(frame).not.toContain("🌶️:");
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
  expect(frame).toContain("const ok");
  expect(frame).not.toContain("🌶️:");
  expect(occurrences(frame, "```")).toBe(0);
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
  expect(fullFrame).not.toContain("🌶️:");
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

function findIntrinsicElement(node: ReactNode, type: string): ReactElement<Record<string, unknown>> | undefined {
  if (!isValidElement(node)) return undefined;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  const props = node.props as { children?: ReactNode };
  for (const child of Children.toArray(props.children)) {
    const found = findIntrinsicElement(child, type);
    if (found) return found;
  }
  return undefined;
}

function line(key: string, text: string): TranscriptLineModel {
  return { key, text, fg: theme.colors.text.secondary };
}
