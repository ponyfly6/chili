import { expect, test } from "bun:test";
import { CodeRenderable, DiffRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { ChatDisplayItem, ToolActivityDisplay } from "./presentation.js";
import { resolveTuiTheme } from "../theme/index.js";
import { ToolCell, toolCellLines, toolGroupCellLines, toolRichBodyRenderableId } from "./ToolCells.js";

const theme = resolveTuiTheme("chili-dark", {});

test("inline tool cell renders compact label without raw output", () => {
  const lines = lineText(toolCellLines(toolActivity({
    id: "tool_inline",
    label: "Ran bun test",
    output: "RAW_OUTPUT_SHOULD_NOT_RENDER",
    outputHint: "output hidden (12 lines, details available)",
  }), 96, theme));

  expect(lines).toContain("Ran bun test");
  expect(lines).toContain("  output hidden (12 lines, details available)");
  expect(lines).not.toContain("RAW_OUTPUT_SHOULD_NOT_RENDER");
});

test("block tool cell renders body once and keeps secondary details", () => {
  const lines = lineText(toolCellLines(toolActivity({
    id: "tool_block",
    label: "Ran bun test",
    mode: "block",
    bodyKind: "text",
    bodyLines: ["line_01", "line_02"],
    details: [
      { label: "output", lines: ["line_01", "line_02"], tone: "muted", truncated: false },
      { label: "input", lines: ['{"command":"bun test"}'], tone: "muted", truncated: false },
    ],
  }), 96, theme));

  expect(lines).toContain("Ran bun test");
  expect(lines).toContain("  output:");
  expect(lines).toContain("    line_01");
  expect(lines).toContain("  input:");
  expect(occurrences(lines.join("\n"), "output:")).toBe(1);
});

test("inline-mode tool with details expands as a block cell", () => {
  const lines = lineText(toolCellLines(toolActivity({
    id: "tool_inline_details",
    label: "Ran custom_probe mystery target",
    mode: "inline",
    bodyKind: "text",
    bodyLines: ["detail line"],
    details: [
      { label: "output", lines: ["detail line"], tone: "muted", truncated: false },
    ],
  }), 96, theme));

  expect(lines).toContain("Ran custom_probe mystery target");
  expect(lines).toContain("  output:");
  expect(lines).toContain("    detail line");
});

test("diff body kind uses the diff body branch", () => {
  const lines = lineText(toolCellLines(toolActivity({
    id: "tool_diff",
    label: "Read git diff src/example.ts",
    mode: "block",
    bodyKind: "diff",
    bodyLines: ["diff --git a/src/example.ts b/src/example.ts", "+const ok = true;"],
    details: [
      { label: "output", lines: ["diff --git a/src/example.ts b/src/example.ts", "+const ok = true;"], tone: "muted", truncated: false },
    ],
  }), 96, theme));

  expect(lines).toContain("  diff:");
  expect(lines).toContain("    diff --git a/src/example.ts b/src/example.ts");
  expect(lines).toContain("    +const ok = true;");
});

test("diff body renders through the native diff renderable while fallback stays textual", async () => {
  const activity = toolActivity({
    id: "tool_diff_rich",
    label: "Read git diff src/example.ts",
    mode: "block",
    bodyKind: "diff",
    bodyLines: [
      "diff --git a/src/example.ts b/src/example.ts",
      "@@ -1 +1 @@",
      "-const ok = false;",
      "+const ok = true;",
    ],
    details: [
      {
        label: "output",
        lines: [
          "diff --git a/src/example.ts b/src/example.ts",
          "@@ -1 +1 @@",
          "-const ok = false;",
          "+const ok = true;",
        ],
        tone: "muted",
        truncated: false,
      },
    ],
  });
  const app = await renderToolCell(activity, 96);

  try {
    const id = toolRichBodyRenderableId("display:tool:tool_diff_rich", "diff");
    expect(app.frame()).toContain("Read git diff src/example.ts");
    expect(app.frame()).toContain("const ok = true;");
    expect(app.renderable(id)).toBeInstanceOf(DiffRenderable);
    expect(lineText(toolCellLines(activity, 96, theme))).toContain("    +const ok = true;");
  } finally {
    app.destroy();
  }
});

test("code body renders through the native code renderable while fallback stays textual", async () => {
  const activity = toolActivity({
    id: "tool_code_rich",
    label: "Read example.ts",
    mode: "block",
    bodyKind: "code",
    bodyLines: ["const ok = true;", "console.log(ok);"],
    inputSummary: { title: "read", path: "src/example.ts", detail: "src/example.ts" },
    details: [
      { label: "output", lines: ["const ok = true;", "console.log(ok);"], tone: "muted", truncated: false },
    ],
  });
  const app = await renderToolCell(activity, 96);

  try {
    const id = toolRichBodyRenderableId("display:tool:tool_code_rich", "code");
    expect(app.frame()).toContain("Read example.ts");
    expect(app.frame()).toContain("const ok = true;");
    expect(app.renderable(id)).toBeInstanceOf(CodeRenderable);
    expect(lineText(toolCellLines(activity, 96, theme))).toContain("    const ok = true;");
  } finally {
    app.destroy();
  }
});

test("short diff snippets use native code fallback instead of rendering blank diff output", async () => {
  const activity = toolActivity({
    id: "tool_diff_snippet_rich",
    label: "Read git diff src/example.ts",
    mode: "block",
    bodyKind: "diff",
    bodyLines: ["diff --git a/src/example.ts b/src/example.ts", "+const ok = true;"],
    details: [
      { label: "output", lines: ["diff --git a/src/example.ts b/src/example.ts", "+const ok = true;"], tone: "muted", truncated: false },
    ],
  });
  const app = await renderToolCell(activity, 96);

  try {
    const id = toolRichBodyRenderableId("display:tool:tool_diff_snippet_rich", "diff");
    expect(app.frame()).toContain("diff --git a/src/example.ts b/src/example.ts");
    expect(app.frame()).toContain("+const ok = true;");
    expect(app.renderable(id)).toBeInstanceOf(CodeRenderable);
  } finally {
    app.destroy();
  }
});

test("tool group cell keeps compact metadata label and expands child details", () => {
  const group: Extract<ChatDisplayItem, { kind: "tool_group" }> = {
    kind: "tool_group",
    id: "group_explore",
    label: "Exploring 1 file, searched 1 pattern",
    tone: "pending",
    metadata: {
      activeHint: "Reading package.json",
      hasErrors: false,
      collapsedCount: 2,
      readCount: 1,
      searchCount: 1,
      listCount: 0,
      activeCount: 1,
      errorCount: 0,
    },
    activities: [
      toolActivity({
        id: "read_package",
        toolName: "read",
        label: "Reading package.json",
        mode: "block",
        bodyKind: "text",
        bodyLines: ["FILE_LINE_1"],
        details: [
          { label: "output", lines: ["FILE_LINE_1"], tone: "muted", truncated: false },
        ],
      }),
    ],
  };

  const lines = lineText(toolGroupCellLines(group, 96, theme));

  expect(lines).toContain("Exploring 1 file, searched 1 pattern");
  expect(lines).toContain("  Reading package.json");
  expect(lines).toContain("  output:");
  expect(lines).toContain("    FILE_LINE_1");
});

test("live partial input row stays a compact running label", () => {
  const lines = lineText(toolCellLines(toolActivity({
    id: "tool_live",
    label: "Running bun test",
    status: "running",
    displayStatus: "running",
    tone: "pending",
  }), 96, theme));

  expect(lines).toEqual(["Running bun test"]);
});

test("live output detail lines preserve stdout and stderr tones", () => {
  const lines = toolCellLines(toolActivity({
    id: "tool_live_output_tones",
    label: "Running npm install",
    status: "running",
    displayStatus: "running",
    tone: "pending",
    mode: "block",
    bodyKind: "text",
    bodyLines: ["stdout line", "stderr line"],
    details: [
      {
        label: "live output",
        lines: ["stdout line", "stderr line"],
        lineTones: ["muted", "error"],
        tone: "muted",
        truncated: false,
      },
    ],
  }), 96, theme);

  expect(lines.find((line) => line.text.includes("stdout line"))?.fg).toBe(theme.colors.text.muted);
  expect(lines.find((line) => line.text.includes("stderr line"))?.fg).toBe(theme.colors.status.error);
});

test("failed tool keeps red compact error summary while live output stays labeled", () => {
  const lines = toolCellLines(toolActivity({
    id: "tool_failed_live_output",
    label: "Failed npm install",
    status: "failed",
    displayStatus: "failed",
    tone: "error",
    mode: "block",
    bodyKind: "text",
    bodyLines: ["installing"],
    details: [
      {
        label: "live output",
        lines: ["installing"],
        lineTones: ["error"],
        tone: "muted",
        truncated: false,
      },
    ],
    compactErrorLines: ["command failed"],
  }), 96, theme);

  expect(lines).toContainEqual(expect.objectContaining({ text: "  error:", fg: theme.colors.status.error }));
  expect(lines).toContainEqual(expect.objectContaining({ text: "    command failed", fg: theme.colors.status.error }));
  expect(lines).toContainEqual(expect.objectContaining({ text: "  live output:", fg: theme.colors.text.muted }));
  expect(lines).not.toContainEqual(expect.objectContaining({ text: "  error:", fg: theme.colors.text.muted }));
});

function toolActivity(overrides: Partial<ToolActivityDisplay> & { id: string; label: string }): ToolActivityDisplay {
  return {
    id: overrides.id,
    callId: overrides.callId ?? overrides.id,
    toolName: overrides.toolName ?? "bash",
    status: overrides.status ?? "completed",
    displayStatus: overrides.displayStatus ?? "succeeded",
    label: overrides.label,
    mode: overrides.mode ?? "inline",
    title: overrides.title ?? overrides.label,
    tone: overrides.tone ?? "muted",
    source: overrides.source ?? "row",
    details: overrides.details ?? [],
    bodyKind: overrides.bodyKind ?? "none",
    bodyLines: overrides.bodyLines ?? [],
    bodyTruncated: overrides.bodyTruncated ?? false,
    ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
    ...(overrides.inputSummary === undefined ? {} : { inputSummary: overrides.inputSummary }),
    ...(overrides.input === undefined ? {} : { input: overrides.input }),
    ...(overrides.output === undefined ? {} : { output: overrides.output }),
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
    ...(overrides.liveOutput === undefined ? {} : { liveOutput: overrides.liveOutput }),
    ...(overrides.outputHint === undefined ? {} : { outputHint: overrides.outputHint }),
    ...(overrides.compactErrorLines === undefined ? {} : { compactErrorLines: overrides.compactErrorLines }),
  };
}

function lineText(lines: readonly { text: string }[]): string[] {
  return lines.map((line) => line.text);
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function renderToolCell(activity: ToolActivityDisplay, width: number): Promise<{
  frame: () => string;
  renderable: (id: string) => unknown;
  destroy: () => void;
}> {
  const app = await testRender(
    <box flexDirection="column" width={width} height={12}>
      <ToolCell activity={activity} width={width} theme={theme} />
    </box>,
    { width, height: 12, exitOnCtrlC: false },
  );

  await act(async () => {
    await app.renderOnce();
  });

  return {
    frame: () => app.captureCharFrame(),
    renderable: (id: string) => app.renderer.root.findDescendantById(id),
    destroy: () => app.renderer.destroy(),
  };
}
