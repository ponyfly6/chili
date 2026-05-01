import { expect, test } from "bun:test";
import { renderToolActivity, type ToolRenderInput } from "./tool-renderers.js";

test("tool renderers expose inline and block cell modes without compact raw output", () => {
  const read = renderToolActivity(toolInput({
    toolName: "read",
    inputSummary: { title: "read", path: "src/index.ts", detail: "src/index.ts" },
    output: "SECRET_FILE_CONTENT",
  }));
  const bashSmall = renderToolActivity(toolInput({
    toolName: "bash",
    inputSummary: { title: "bash", command: "echo ok", detail: "echo ok" },
    output: "SECRET_SMALL_OUTPUT",
  }));
  const bashLarge = renderToolActivity(toolInput({
    toolName: "bash",
    inputSummary: { title: "bash", command: "bun test", detail: "bun test" },
    output: "SECRET_LINE_1\nSECRET_LINE_2",
  }));
  const failed = renderToolActivity(toolInput({
    toolName: "bash",
    status: "failed",
    displayStatus: "failed",
    inputSummary: { title: "bash", command: "bun test", detail: "bun test" },
    error: "first failure\nsecond failure",
  }));
  const unknown = renderToolActivity(toolInput({
    toolName: "custom_probe",
    inputSummary: { title: "custom_probe", detail: "mystery target" },
    output: "SECRET_LINE_1\nSECRET_LINE_2",
  }));

  expect(read).toMatchObject({
    label: "Read index.ts",
    mode: "inline",
    title: "Read index.ts",
    status: "succeeded",
    bodyKind: "none",
    bodyLines: [],
    bodyTruncated: false,
  });
  expect(bashSmall).toMatchObject({ mode: "inline", bodyKind: "none", bodyLines: [] });
  expect(bashSmall.outputHint).toBeUndefined();
  expect(bashLarge).toMatchObject({ mode: "block", bodyKind: "none", bodyLines: [] });
  expect(bashLarge.outputHint).toBe("output hidden (2 lines, details available)");
  expect(failed).toMatchObject({
    mode: "block",
    bodyKind: "none",
    bodyLines: [],
    compactErrorLines: ["first failure", "second failure"],
  });
  expect(unknown).toMatchObject({
    label: "Ran custom_probe mystery target",
    mode: "inline",
    bodyKind: "none",
    bodyLines: [],
  });
  expect(unknown.outputHint).toBe("output hidden (2 lines, details available)");
});

test("details mode promotes truncated preview lines into the cell body", () => {
  const output = Array.from({ length: 7 }, (_, index) => `line_${String(index + 1).padStart(2, "0")}`).join("\n");
  const rendered = renderToolActivity(toolInput({
    toolName: "bash",
    inputSummary: { title: "bash", command: "bun test", detail: "bun test" },
    input: { command: "bun test" },
    output,
    showToolDetails: true,
  }));

  expect(rendered).toMatchObject({
    mode: "block",
    bodyKind: "text",
    bodyLines: ["line_01", "line_02", "line_03", "line_04", "line_05"],
    bodyTruncated: true,
  });
  expect(rendered.outputHint).toBeUndefined();
  expect(rendered.details.find((detail) => detail.label === "output")).toMatchObject({
    truncated: true,
    lines: ["line_01", "line_02", "line_03", "line_04", "line_05"],
  });
});

test("running command tools expose live output tail without mixing it into final compact output", () => {
  const running = renderToolActivity(toolInput({
    toolName: "bash",
    status: "running",
    displayStatus: "running",
    inputSummary: { title: "bash", command: "npm install", detail: "npm install" },
    liveOutput: [
      { stream: "stdout", delta: "line_01\nline_02\nline_03\nline_04\n", time: 1 },
      { stream: "stderr", delta: "warn_05\n", time: 2 },
      { stream: "stdout", delta: "line_06\n", time: 3 },
    ],
  }));
  const completed = renderToolActivity(toolInput({
    toolName: "bash",
    inputSummary: { title: "bash", command: "npm install", detail: "npm install" },
    output: "FINAL_OUTPUT",
    liveOutput: [
      { stream: "stdout", delta: "LIVE_OUTPUT_SHOULD_NOT_COMPACT_AFTER_SUCCESS\n", time: 1 },
    ],
  }));

  expect(running).toMatchObject({
    mode: "block",
    bodyKind: "text",
    bodyLines: ["line_02", "line_03", "line_04", "warn_05", "line_06"],
    bodyTruncated: true,
  });
  expect(running.details[0]).toMatchObject({
    label: "live output",
    lineTones: ["muted", "muted", "muted", "muted", "muted"],
  });
  expect(completed).toMatchObject({ mode: "inline", bodyKind: "none", bodyLines: [] });
  expect(completed.details).toEqual([]);
});

test("running stderr-only live output stays a live output text body", () => {
  const rendered = renderToolActivity(toolInput({
    toolName: "bash",
    status: "running",
    displayStatus: "running",
    inputSummary: { title: "bash", command: "bun test --watch", detail: "bun test --watch" },
    liveOutput: [
      { stream: "stderr", delta: "pass 1\nwatching for changes\n", time: 1 },
    ],
  }));

  expect(rendered.bodyKind).toBe("text");
  expect(rendered.bodyLines).toEqual(["pass 1", "watching for changes"]);
  expect(rendered.details[0]).toMatchObject({
    label: "live output",
    tone: "muted",
    lineTones: ["muted", "muted"],
  });
});

test("live output preview reassembles logical lines across delta boundaries", () => {
  const rendered = renderToolActivity(toolInput({
    toolName: "bash",
    status: "running",
    displayStatus: "running",
    inputSummary: { title: "bash", command: "npm install", detail: "npm install" },
    liveOutput: [
      { stream: "stdout", delta: "hel", time: 1 },
      { stream: "stdout", delta: "lo\nnext\n", time: 2 },
    ],
  }));

  expect(rendered.bodyLines).toEqual(["hello", "next"]);
  expect(rendered.bodyLines).not.toEqual(["hel", "lo", "next"]);
  expect(rendered.details[0]?.lineTones).toEqual(["muted", "muted"]);
});

test("live output preview reassembles stdout and stderr with separate tones", () => {
  const rendered = renderToolActivity(toolInput({
    toolName: "bash",
    status: "running",
    displayStatus: "running",
    inputSummary: { title: "bash", command: "npm install", detail: "npm install" },
    liveOutput: [
      { stream: "stdout", delta: "out", time: 1 },
      { stream: "stderr", delta: "err", time: 2 },
      { stream: "stdout", delta: "put\n", time: 3 },
      { stream: "stderr", delta: "or\n", time: 4 },
    ],
  }));

  expect(rendered.bodyLines).toEqual(["output", "error"]);
  expect(rendered.details[0]?.lineTones).toEqual(["muted", "muted"]);
});

test("failed command tools keep compact error summary when live output exists", () => {
  const failed = renderToolActivity(toolInput({
    toolName: "bash",
    status: "failed",
    displayStatus: "failed",
    inputSummary: { title: "bash", command: "npm install", detail: "npm install" },
    error: "command failed",
    liveOutput: [
      { stream: "stderr", delta: "installing\n", time: 1 },
    ],
  }));

  expect(failed.bodyKind).toBe("text");
  expect(failed.details.find((detail) => detail.label === "live output")?.lines).toEqual(["installing"]);
  expect(failed.details.find((detail) => detail.label === "live output")?.lineTones).toEqual(["error"]);
  expect(failed.compactErrorLines).toEqual(["command failed"]);
});

test("live output always renders as text even for diff-oriented tools", () => {
  const rendered = renderToolActivity(toolInput({
    toolName: "git_diff",
    status: "running",
    displayStatus: "running",
    inputSummary: { title: "git_diff", detail: "src/example.ts" },
    liveOutput: [
      { stream: "stdout", delta: "reading diff\n", time: 1 },
    ],
  }));

  expect(rendered.bodyKind).toBe("text");
  expect(rendered.bodyLines).toEqual(["reading diff"]);
  expect(rendered.details[0]?.label).toBe("live output");
});

test("details mode keeps a longer live output tail for running command tools", () => {
  const rendered = renderToolActivity(toolInput({
    toolName: "bash",
    status: "running",
    displayStatus: "running",
    inputSummary: { title: "bash", command: "npm install", detail: "npm install" },
    showToolDetails: true,
    liveOutput: [
      { stream: "stdout", delta: Array.from({ length: 8 }, (_, index) => `live_${index + 1}`).join("\n"), time: 1 },
    ],
  }));

  expect(rendered.details.find((detail) => detail.label === "live output")?.lines).toEqual([
    "live_1",
    "live_2",
    "live_3",
    "live_4",
    "live_5",
    "live_6",
    "live_7",
    "live_8",
  ]);
});

test("file-changing and diff tools are block-ready while fallback stays inline", () => {
  for (const toolName of ["edit", "write", "apply_patch", "git_diff"]) {
    const rendered = renderToolActivity(toolInput({
      toolName,
      inputSummary: { title: toolName, detail: "src/example.ts", path: "src/example.ts" },
    }));
    expect(rendered.mode).toBe("block");
    expect(rendered.bodyKind).toBe("none");
    expect(rendered.bodyLines).toEqual([]);
  }

  const diff = renderToolActivity(toolInput({
    toolName: "git_diff",
    inputSummary: { title: "git_diff", detail: "src/example.ts" },
    output: "diff --git a/src/example.ts b/src/example.ts\n+const ok = true;",
    showToolDetails: true,
  }));
  const gitStatus = renderToolActivity(toolInput({
    toolName: "git_status",
    inputSummary: { title: "git_status", detail: "working tree" },
  }));
  const unknown = renderToolActivity(toolInput({
    toolName: "custom_probe",
    inputSummary: { title: "custom_probe", detail: "mystery target" },
  }));

  expect(diff).toMatchObject({
    mode: "block",
    bodyKind: "diff",
    bodyLines: ["diff --git a/src/example.ts b/src/example.ts", "+const ok = true;"],
    bodyTruncated: false,
  });
  expect(gitStatus.mode).toBe("inline");
  expect(unknown.mode).toBe("inline");
});

function toolInput(overrides: Partial<ToolRenderInput> & { toolName: string }): ToolRenderInput {
  return {
    id: overrides.id ?? `tool_${overrides.toolName}`,
    callId: overrides.callId ?? `call_${overrides.toolName}`,
    toolName: overrides.toolName,
    status: overrides.status ?? "completed",
    displayStatus: overrides.displayStatus ?? "succeeded",
    inputSummary: overrides.inputSummary ?? { title: overrides.toolName },
    showToolDetails: overrides.showToolDetails ?? false,
    source: overrides.source ?? "row",
    ...(overrides.input === undefined ? {} : { input: overrides.input }),
    ...(overrides.output === undefined ? {} : { output: overrides.output }),
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
    ...(overrides.liveOutput === undefined ? {} : { liveOutput: overrides.liveOutput }),
  };
}
