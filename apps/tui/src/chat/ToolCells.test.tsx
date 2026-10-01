import { expect, test } from "bun:test";
import { CodeRenderable, DiffRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { ChatDisplayItem, ToolActivityDisplay } from "./presentation.js";
import { resolveTuiTheme } from "../theme/index.js";
import { ToolCell, toolCellLines, toolGroupCellLines, toolRichBodyRenderableId } from "./ToolCells.js";
import { renderToolActivity, type ToolRenderInput } from "./tool-renderers.js";

const theme = resolveTuiTheme("chili-dark", {});

test("inline tool cell renders compact label without raw output", () => {
  const lines = lineText(toolCellLines(toolActivity({
    id: "tool_inline",
    label: "Ran bun test",
    output: "RAW_OUTPUT_SHOULD_NOT_RENDER",
    outputHint: "output hidden (12 lines, details available)",
  }), 96, theme));

  expect(lines).toContain("• Ran bun test");
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

  expect(lines).toContain("• Ran bun test");
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

  expect(lines).toContain("• Ran custom_probe mystery target");
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
      failedCount: 0,
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

  const models = toolGroupCellLines(group, 96, theme);
  const lines = lineText(models);

  expect(lines).toContain("• Exploring 1 file, searched 1 pattern");
  expect(lines).toContain("  Reading package.json");
  expect(lines).toContain("  output:");
  expect(lines).toContain("    FILE_LINE_1");
});

test("tool group cell renders only the first compact failure and a remainder hint", () => {
  const group = {
    kind: "tool_group",
    id: "group_failed_explore",
    label: "Explored 1 file, searched 1 pattern, listed 1 path · 3 failed",
    tone: "error",
    metadata: {
      hasErrors: true,
      collapsedCount: 3,
      readCount: 1,
      searchCount: 1,
      listCount: 1,
      activeCount: 0,
      errorCount: 3,
      failedCount: 3,
      compactFailureLines: [
        "File not found: app/first.php",
        "+2 more failures (Ctrl+O for details)",
      ],
    },
    activities: [
      toolActivity({
        id: "read_failed",
        toolName: "read",
        label: "Failed app/first.php",
        displayStatus: "failed",
        tone: "error",
        compactErrorLines: ["File not found: app/first.php"],
      }),
      toolActivity({
        id: "grep_failed",
        toolName: "grep",
        label: "Failed app/second.php",
        displayStatus: "failed",
        tone: "error",
        compactErrorLines: ["File not found: app/second.php"],
      }),
      toolActivity({
        id: "glob_failed",
        toolName: "glob",
        label: "Failed app/third.php",
        displayStatus: "failed",
        tone: "error",
        compactErrorLines: ["File not found: app/third.php"],
      }),
    ],
  } as Extract<ChatDisplayItem, { kind: "tool_group" }>;

  const models = toolGroupCellLines(group, 96, theme);
  const lines = lineText(models);

  expect(lines).toContain("  └ File not found: app/first.php");
  expect(lines).toContain("    +2 more failures (Ctrl+O for details)");
  expect(lines).not.toContain("    File not found: app/second.php");
  expect(lines).not.toContain("    File not found: app/third.php");
  expect(lines).not.toContain("  error:");
  expect(models.find((line) => line.text.includes("File not found"))?.fg).toBe(theme.colors.text.muted);
  expect(models.find((line) => line.text.includes("+2 more failures"))?.fg).toBe(theme.colors.text.muted);
});

test("live partial input row stays a compact running label", () => {
  const lines = lineText(toolCellLines(toolActivity({
    id: "tool_live",
    label: "Running bun test",
    status: "running",
    displayStatus: "running",
    tone: "pending",
  }), 96, theme));

  expect(lines).toEqual(["• Running bun test"]);
});

test("top-level tool status markers use a colored accent while labels stay muted", () => {
  const cases = [
    ["failed", theme.colors.status.error],
    ["rejected", theme.colors.status.warning],
    ["waiting_permission", theme.colors.status.warning],
    ["queued", theme.colors.status.pending],
    ["checking", theme.colors.status.pending],
    ["running", theme.colors.status.pending],
    ["succeeded", theme.colors.text.disabled],
    ["cancelled", theme.colors.text.disabled],
  ] as const;

  for (const [displayStatus, accentFg] of cases) {
    const [label, ...continuations] = toolCellLines(toolActivity({
      id: `tool_${displayStatus}`,
      label: `Tool ${displayStatus}`,
      displayStatus,
    }), 96, theme);

    expect(label?.text).toBe(`• Tool ${displayStatus}`);
    expect(label?.fg).toBe(theme.colors.text.muted);
    expect(leadingAccent(label)).toEqual({ length: 1, fg: accentFg });
    expect(continuations.every((line) => leadingAccent(line) === undefined)).toBe(true);
  }
});

test("exploration group renders one marker with status priority and no child markers", () => {
  const cases = [
    [["succeeded", "running", "rejected", "failed"], theme.colors.status.error],
    [["succeeded", "running", "rejected"], theme.colors.status.warning],
    [["succeeded", "running", "waiting_permission"], theme.colors.status.warning],
    [["succeeded", "cancelled", "running"], theme.colors.status.pending],
    [["succeeded", "cancelled"], theme.colors.text.disabled],
    [["succeeded", "succeeded"], theme.colors.text.disabled],
  ] as const;

  for (const [statuses, accentFg] of cases) {
    const activities = statuses.map((displayStatus, index) => toolActivity({
      id: `group_${statuses.join("_")}_${index}`,
      toolName: index % 2 === 0 ? "read" : "grep",
      label: `Child ${index + 1}`,
      displayStatus,
      mode: "block",
      bodyKind: "text",
      bodyLines: [`child body ${index + 1}`],
      details: [
        { label: "output", lines: [`child body ${index + 1}`], tone: "muted", truncated: false },
      ],
    }));
    const group = explorationGroup(`Priority ${statuses.join("/")}`, activities);
    const lines = toolGroupCellLines(group, 96, theme);
    const [label, ...childLines] = lines;

    expect(label?.text).toBe(`• ${group.label}`);
    expect(label?.fg).toBe(theme.colors.text.muted);
    expect(leadingAccent(label)).toEqual({ length: 1, fg: accentFg });
    expect(lines.filter((line) => line.text.includes("•"))).toHaveLength(1);
    expect(childLines.every((line) => leadingAccent(line) === undefined)).toBe(true);
  }
});

test("narrow tool labels accent only the first row and align continuation rows", () => {
  const lines = toolCellLines(toolActivity({
    id: "tool_wrapped_label",
    label: "Ran a deliberately long command name",
    displayStatus: "failed",
  }), 18, theme);

  expect(lines.length).toBeGreaterThan(1);
  expect(lines.every((line) => Bun.stringWidth(line.text) <= 18)).toBe(true);
  expect(lines[0]?.text.startsWith("• ")).toBe(true);
  expect(leadingAccent(lines[0])).toEqual({ length: 1, fg: theme.colors.status.error });
  for (const line of lines.slice(1)) {
    expect(line.text.startsWith("  ")).toBe(true);
    expect(line.text.includes("•")).toBe(false);
    expect(leadingAccent(line)).toBeUndefined();
  }
  expect(lines.map((line, index) => index === 0 ? line.text : line.text.slice(2)).join(""))
    .toBe("• Ran a deliberately long command name");
});

test("rendered failed tool colors only the marker red", async () => {
  const app = await renderToolCell(toolActivity({
    id: "tool_rendered_marker",
    label: "Failed command",
    displayStatus: "failed",
  }), 40);

  try {
    expect(app.frame()).toContain("• Failed command");
    expect(app.foregroundMatches(0, 0, theme.colors.status.error)).toBe(true);
    expect(app.foregroundMatches(2, 0, theme.colors.text.muted)).toBe(true);
    expect(app.foregroundMatches(2, 0, theme.colors.status.error)).toBe(false);
  } finally {
    app.destroy();
  }
});

test("live output detail lines render stdout and stderr as neutral context", () => {
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
  expect(lines.find((line) => line.text.includes("stderr line"))?.fg).toBe(theme.colors.text.muted);
});

test("failed tool keeps compact error summary neutral while the marker owns the red accent", () => {
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

  expect(lines[0]).toEqual(expect.objectContaining({
    text: "• Failed npm install",
    fg: theme.colors.text.muted,
  }));
  expect(leadingAccent(lines[0])).toEqual({ length: 1, fg: theme.colors.status.error });
  expect(lines).toContainEqual(expect.objectContaining({ text: "  └ command failed", fg: theme.colors.text.muted }));
  expect(lines).toContainEqual(expect.objectContaining({ text: "  live output:", fg: theme.colors.text.muted }));
  expect(lines).not.toContainEqual(expect.objectContaining({ text: "  error:", fg: expect.any(String) }));
});

test("ordinary error bodies and detail rows remain neutral", () => {
  const lines = toolCellLines(toolActivity({
    id: "tool_neutral_error_body",
    label: "Failed narrow command",
    status: "failed",
    displayStatus: "failed",
    tone: "error",
    mode: "block",
    bodyKind: "error",
    bodyLines: ["HTTP 429 from endpoint"],
    details: [
      { label: "error", lines: ["HTTP 429 from endpoint"], tone: "error", lineTones: ["error"], truncated: false },
      { label: "diagnostic", lines: ["request id abc"], tone: "error", lineTones: ["error"], truncated: false },
    ],
  }), 96, theme);

  for (const line of lines.filter((line) => line.text.includes("error") || line.text.includes("HTTP 429") || line.text.includes("diagnostic") || line.text.includes("request id"))) {
    expect(line.fg).toBe(theme.colors.text.muted);
  }
});

test("tool detail previews budget wrapped visual rows while preserving head and tail", () => {
  const longError = `HEAD_${"x".repeat(180)}_TAIL`;
  const lines = lineText(toolCellLines(toolActivity({
    id: "tool_wrapped_error",
    label: "Failed narrow command",
    status: "failed",
    displayStatus: "failed",
    tone: "error",
    mode: "block",
    bodyKind: "error",
    bodyLines: [longError],
    details: [
      { label: "error", lines: [longError], tone: "error", truncated: false },
    ],
  }), 24, theme));
  const detailLabelIndex = lines.findIndex((line) => line.includes("error"));
  const detailRows = lines.slice(detailLabelIndex + 1);

  expect(lines[detailLabelIndex]).toContain("(truncated)");
  expect(detailRows.length).toBeLessThanOrEqual(5);
  expect(detailRows.join("")).toContain("HEAD_");
  expect(detailRows.join("").replace(/\s+/g, "")).toContain("_TAIL");
  expect(detailRows.some((line) => line.includes("… +"))).toBe(true);
});

test("renderer-backed ordinary details keep five visual rows and preserve head and tail", () => {
  const input: ToolRenderInput = {
    id: "tool_renderer_budget",
    callId: "call_renderer_budget",
    toolName: "custom_probe",
    status: "completed",
    displayStatus: "succeeded",
    inputSummary: { title: "custom_probe", detail: "budget" },
    input: {
      first: "one",
      second: "two",
      third: "three",
      fourth: "four",
      fifth: "five",
      sixth: "six",
      last: "seven",
    },
    output: Array.from({ length: 7 }, (_, index) => `line_${index + 1}`).join("\n"),
    showToolDetails: true,
    source: "row",
  };
  const rendered = renderToolActivity(input);
  const activity: ToolActivityDisplay = {
    ...rendered,
    id: input.id,
    callId: input.callId,
    toolName: input.toolName,
    status: input.status,
    displayStatus: input.displayStatus,
    tone: "muted",
    source: input.source,
    inputSummary: input.inputSummary,
    input: input.input,
    output: input.output!,
  };
  const lines = lineText(toolCellLines(activity, 24, theme));
  const outputLabelIndex = lines.findIndex((line) => line.includes("output"));
  const inputLabelIndex = lines.findIndex((line) => line.includes("input"));
  const outputRows = lines.slice(outputLabelIndex + 1, inputLabelIndex);
  const inputRows = lines.slice(inputLabelIndex + 1);

  expect(outputRows.length).toBeLessThanOrEqual(5);
  expect(outputRows.join("\n")).toContain("line_1");
  expect(outputRows.join("\n")).toContain("line_7");
  expect(outputRows).toContain("    … +3 (Ctrl+T)");
  expect(inputRows.length).toBeLessThanOrEqual(5);
  expect(inputRows.join("\n")).toContain("first");
  expect(inputRows.join("\n")).toContain("last");
  expect(inputRows.join("\n")).toContain("}");
  expect(inputRows.some((line) => line.includes("… +"))).toBe(true);
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

function explorationGroup(label: string, activities: ToolActivityDisplay[]): Extract<ChatDisplayItem, { kind: "tool_group" }> {
  const errorCount = activities.filter((activity) => activity.displayStatus === "failed" || activity.displayStatus === "rejected" || activity.displayStatus === "cancelled").length;
  const activeCount = activities.filter((activity) => activity.displayStatus === "queued" || activity.displayStatus === "checking" || activity.displayStatus === "waiting_permission" || activity.displayStatus === "running").length;
  return {
    kind: "tool_group",
    id: `group_${label}`,
    label,
    tone: errorCount > 0 ? "error" : activeCount > 0 ? "pending" : "muted",
    metadata: {
      hasErrors: errorCount > 0,
      collapsedCount: activities.length,
      readCount: activities.filter((activity) => activity.toolName === "read").length,
      searchCount: activities.filter((activity) => activity.toolName === "grep").length,
      listCount: 0,
      activeCount,
      errorCount,
      failedCount: activities.filter((activity) => activity.displayStatus === "failed").length,
    },
    activities,
  };
}

function leadingAccent(line: { text: string } | undefined): { length: number; fg: string } | undefined {
  return (line as ({ leadingAccent?: { length: number; fg: string } } | undefined))?.leadingAccent;
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
  foregroundMatches: (x: number, y: number, color: string) => boolean;
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
    foregroundMatches: (x, y, color) => renderBufferColorMatches(
      app.renderer.currentRenderBuffer.buffers.fg,
      app.renderer.currentRenderBuffer.width,
      x,
      y,
      color,
    ),
    destroy: () => app.renderer.destroy(),
  };
}

function renderBufferColorMatches(buffer: Float32Array, width: number, x: number, y: number, color: string): boolean {
  const offset = (y * width + x) * 4;
  const value = color.replace(/^#/, "");
  const expected = [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
    1,
  ];
  return expected.every((channel, index) => Math.abs((buffer[offset + index] ?? 0) - channel) < 0.001);
}
