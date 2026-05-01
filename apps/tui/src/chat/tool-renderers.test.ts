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
  };
}
