import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultToolRendererRegistry, renderToolActivity, type ToolRenderInput } from "./tool-renderers.js";

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

test("bash compact labels expose explicit cwd and bound long commands", () => {
  const command = `printf start-${"x".repeat(260)}-tail-marker`;
  const rendered = renderToolActivity({
    ...toolInput({
      toolName: "bash",
      inputSummary: { title: "bash", command, detail: command, scope: "/repo/packages/core" },
      input: { command, cwd: "/repo/packages/core" },
    }),
    cwd: "/repo",
  });

  expect(rendered.label).toStartWith("Ran printf start-");
  expect(rendered.label).toContain("…");
  expect(rendered.label).toContain("-tail-marker");
  expect(rendered.label).toEndWith("· in packages/core");
  expect(rendered.label.length).toBeLessThanOrEqual(190);
});

test("exact no-match results remain visible in compact exploration rows", () => {
  for (const toolName of ["grep", "glob"]) {
    const rendered = renderToolActivity(toolInput({
      toolName,
      inputSummary: { title: toolName, pattern: "missing", scope: "apps/tui" },
      output: "(no matches)",
    }));

    expect(rendered.outputHint).toBe("No matches");
    expect(rendered.bodyLines).toEqual([]);
    expect(rendered.details).toEqual([]);
  }
});

test("details mode preserves the head and tail of truncated preview lines", () => {
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
    bodyLines: ["line_01", "line_02", "… +3 lines (Ctrl+T for transcript)", "line_06", "line_07"],
    bodyTruncated: true,
  });
  expect(rendered.outputHint).toBeUndefined();
  expect(rendered.details.find((detail) => detail.label === "output")).toMatchObject({
    truncated: true,
    lines: ["line_01", "line_02", "… +3 lines (Ctrl+T for transcript)", "line_06", "line_07"],
  });
});

test("details mode shows only controlled execution context fields", () => {
  const executionContext = {
    executionMode: "unsandboxed",
    sandbox: "none",
    exitCode: 0,
    timedOut: false,
    aborted: false,
    signal: null,
    internalMetadata: "must not leak",
  } satisfies NonNullable<ToolRenderInput["executionContext"]> & { internalMetadata: string };
  const rendered = renderToolActivity(toolInput({
    toolName: "bash",
    inputSummary: { title: "bash", command: "echo ok", detail: "echo ok" },
    executionContext,
    showToolDetails: true,
  }));

  expect(rendered.details).toContainEqual({
    label: "execution",
    tone: "muted",
    lines: [
      "mode: unsandboxed",
      "sandbox: none",
      "exit code: 0",
      "timed out: false",
      "aborted: false",
      "signal: null",
    ],
    truncated: false,
  });
  expect(JSON.stringify(rendered)).not.toContain("internalMetadata");
  expect(JSON.stringify(rendered)).not.toContain("must not leak");
});

test("compact errors preserve head and tail with a Ctrl+T transcript hint", () => {
  const error = Array.from({ length: 7 }, (_, index) => `error_${index + 1}`).join("\n");
  const rendered = renderToolActivity(toolInput({
    toolName: "bash",
    status: "failed",
    displayStatus: "failed",
    inputSummary: { title: "bash", command: "bun test", detail: "bun test" },
    error,
  }));

  expect(rendered.compactErrorLines).toEqual([
    "error_1",
    "error_2",
    "… +4 lines (Ctrl+T for transcript)",
    "error_7",
  ]);
});

test("single-line truncation also points to the full transcript", () => {
  const rendered = renderToolActivity(toolInput({
    toolName: "bash",
    status: "failed",
    displayStatus: "failed",
    inputSummary: { title: "bash", command: "bun test", detail: "bun test" },
    error: "x".repeat(220),
  }));

  expect(rendered.compactErrorLines?.[0]?.endsWith("~")).toBe(true);
  expect(rendered.compactErrorLines?.at(-1)).toBe("… output truncated (Ctrl+T for transcript)");
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
    bodyLines: ["… +2 lines (Ctrl+T for transcript)", "line_03", "line_04", "warn_05", "line_06"],
    bodyTruncated: true,
  });
  expect(running.details[0]).toMatchObject({
    label: "live output",
    lineTones: ["muted", "muted", "muted", "muted", "muted"],
  });
  expect(completed).toMatchObject({ mode: "inline", bodyKind: "none", bodyLines: [] });
  expect(completed.details).toEqual([]);
});

test("source-truncated live output points to the full transcript", () => {
  const rendered = renderToolActivity(toolInput({
    toolName: "bash",
    status: "running",
    displayStatus: "running",
    inputSummary: { title: "bash", command: "npm install", detail: "npm install" },
    liveOutput: [
      { stream: "stdout", delta: "old 1\nold 2\nlatest 3\nlatest 4\nlatest 5\nlatest 6\n", time: 1, truncated: true },
    ],
  }));

  expect(rendered.bodyLines).toEqual([
    "… output truncated (Ctrl+T for transcript)",
    "latest 3",
    "latest 4",
    "latest 5",
    "latest 6",
  ]);
  expect(rendered.bodyTruncated).toBe(true);
});

test("exploration tools keep running live output out of compact semantic summaries", () => {
  for (const toolName of ["read", "grep", "glob"]) {
    const base = toolInput({
      toolName,
      status: "running",
      displayStatus: "running",
      inputSummary: { title: toolName, path: "/repo/app/example.php", scope: "/repo/app/example.php" },
      liveOutput: [
        { stream: "stderr", delta: "RAW_EXPLORATION_PROGRESS\n", time: 1 },
      ],
    });

    const compact = renderToolActivity(base);
    const details = renderToolActivity({ ...base, showToolDetails: true });

    expect(compact.details).toEqual([]);
    expect(compact.bodyLines).toEqual([]);
    expect(details.details.find((detail) => detail.label === "live output")?.lines).toEqual(["RAW_EXPLORATION_PROGRESS"]);
  }
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

test("failed command execution context uses a semantic compact error", () => {
  const failed = renderToolActivity(toolInput({
    toolName: "bash",
    status: "completed",
    displayStatus: "failed",
    inputSummary: { title: "bash", command: "bun test", detail: "bun test" },
    output: "very long raw command output\nthat stays out of the semantic summary",
    executionContext: { exitCode: 2, timedOut: false },
  }));

  expect(failed.compactErrorLines).toEqual(["Command exited with code 2"]);
  expect(failed.compactErrorLines).not.toContain("very long raw command output");
});

test("exploration failures use semantic compact copy while details keep raw diagnostics", () => {
  for (const toolName of ["read", "grep", "glob"]) {
    const error = "ENOENT: no such file or directory, lstat '/repo/app/example.php'";
    const base = {
      ...toolInput({
        toolName,
        status: "failed",
        displayStatus: "failed",
        inputSummary: {
          title: toolName,
          path: "/repo/app/example.php",
          scope: "/repo/app/example.php",
        },
        error,
      }),
      cwd: "/repo",
    } as ToolRenderInput;

    const compact = renderToolActivity(base);
    const details = renderToolActivity({ ...base, showToolDetails: true });

    expect(compact.compactErrorLines).toEqual(["File not found: app/example.php"]);
    expect(compact.compactErrorLines?.join("\n")).not.toContain("ENOENT");
    expect(details.compactErrorLines).toBeUndefined();
    expect(details.details.find((detail) => detail.label === "error")?.lines.join("\n")).toContain(error);
  }
});

test("semantic exploration failures shorten home and long paths without losing filenames", () => {
  const homeTarget = join(homedir(), "Code", "outside-workspace.php");
  const homeFailure = renderToolActivity({
    ...toolInput({
      toolName: "read",
      status: "failed",
      displayStatus: "failed",
      inputSummary: { title: "read", path: homeTarget },
      error: `EACCES: permission denied, open '${homeTarget}'`,
    }),
    cwd: "/repo",
  } as ToolRenderInput);
  const longTarget = `/repo/${Array.from({ length: 18 }, (_, index) => `segment-${index}`).join("/")}/final-target.php`;
  const longFailure = renderToolActivity({
    ...toolInput({
      toolName: "read",
      status: "failed",
      displayStatus: "failed",
      inputSummary: { title: "read", path: longTarget },
      error: `ENOENT: no such file or directory, lstat '${longTarget}'`,
    }),
    cwd: "/repo",
  } as ToolRenderInput);

  expect(homeFailure.compactErrorLines).toEqual(["Permission denied: ~/Code/outside-workspace.php"]);
  expect(longFailure.compactErrorLines?.[0]).toContain("…");
  expect(longFailure.compactErrorLines?.[0]).toEndWith("/final-target.php");
  expect(longFailure.compactErrorLines?.[0]?.length).toBeLessThanOrEqual(112);
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

test.each([
  { toolName: "agent_spawn", input: { name: "reviewer", prompt: "inspect API" }, label: "Started agent reviewer" },
  { toolName: "agent_list", input: {}, label: "Listed agents" },
  { toolName: "agent_send", input: { agentId: "session_reader", text: "inspect API" }, label: "Sent input to agent session_reader" },
  { toolName: "agent_wait", input: { agentId: "session_reader", inputId: "input_review" }, label: "Waited for input input_review · agent session_reader" },
  { toolName: "agent_stop", input: { agentId: "session_reader" }, label: "Stopped agent session_reader" },
  { toolName: "agent_resume", input: { agentId: "session_reader" }, label: "Resumed agent session_reader" },
])("unified $toolName renderer exposes its lifecycle action", ({ toolName, input, label }) => {
  expect(renderToolActivity(toolInput({
    toolName,
    inputSummary: { title: toolName },
    input,
  }))).toMatchObject({ label, mode: "inline" });
});

test("agent submission summaries retain stable agent and input receipts", () => {
  for (const toolName of ["agent_spawn", "agent_send", "agent_resume"]) {
    const rendered = renderToolActivity(toolInput({
      toolName,
      input: { name: "reviewer", agentId: "session_reader" },
      output: JSON.stringify({ agentId: "session_reader", inputId: "input_review" }),
    }));
    expect(rendered.summary).toBe(toolName === "agent_spawn"
      ? "agent session_reader · input input_review"
      : "input input_review");
  }
});

test("agent compact summaries omit prompts and bound receipt identifiers", () => {
  const running = renderToolActivity(toolInput({
    toolName: "agent_spawn",
    status: "running",
    displayStatus: "running",
    input: { name: "reviewer", prompt: "PRIVATE_PROMPT" },
    inputSummary: { title: "agent_spawn", detail: "PRIVATE_PROMPT" },
  }));
  expect(running.label).toBe("Starting agent reviewer");
  expect(running.summary).toBe("");
  const completed = renderToolActivity(toolInput({
    toolName: "agent_spawn",
    input: { name: "reviewer" },
    output: JSON.stringify({ agentId: `session_${"a".repeat(300)}`, inputId: `input_${"b".repeat(300)}` }),
  }));
  expect(completed.summary?.length).toBeLessThanOrEqual(160);
  expect(completed.summary).toContain("…");
});

test.each(["completed", "failed", "cancelled", "interrupted"])("agent wait reports the specific input outcome: %s", (outcome) => {
  const waited = renderToolActivity(toolInput({
    toolName: "agent_wait",
    input: { agentId: "session_reader", inputId: "input_review" },
    output: JSON.stringify({
      input: { inputId: "input_review", state: "settled", outcome },
      result: { parts: [{ text: "PRIVATE_RESULT_BODY" }] },
      timedOut: false,
    }),
  }));
  expect(waited).toMatchObject({
    label: "Waited for input input_review · agent session_reader",
    summary: outcome,
    mode: "inline",
    bodyKind: "none",
    bodyLines: [],
  });
  expect(JSON.stringify(waited)).not.toContain("PRIVATE_RESULT_BODY");
});

test("agent wait timeout describes the input without implying the agent stopped", () => {
  const waited = renderToolActivity(toolInput({
    toolName: "agent_wait",
    input: { agentId: "session_reader", inputId: "input_review" },
    output: JSON.stringify({ input: { inputId: "input_review", state: "claimed" }, timedOut: true }),
  }));
  expect(waited.summary).toBe("claimed · wait timed out");
  expect(waited.status).toBe("succeeded");
  const running = renderToolActivity(toolInput({
    toolName: "agent_wait",
    status: "running",
    displayStatus: "running",
    input: { agentId: "session_reader", inputId: "input_review" },
  }));
  expect(running.label).toBe("Waiting for input input_review · agent session_reader");
});

test("agent list summarizes current agent states", () => {
  const list = (agents: unknown[]) => renderToolActivity(toolInput({
    toolName: "agent_list",
    input: {},
    output: JSON.stringify({ agents }),
  }));
  expect(list([
    { agentId: "session_1", state: "running" },
    { agentId: "session_2", state: "paused" },
    { agentId: "session_3", state: "idle" },
  ])).toMatchObject({ label: "Listed agents", summary: "3 agents · 1 running · 1 paused · 1 idle", mode: "inline" });
  expect(list([]).summary).toBe("0 agents");
});

test("agent details and failures remain inspectable", () => {
  const detailed = renderToolActivity(toolInput({
    toolName: "agent_wait",
    input: { agentId: "session_reader", inputId: "input_review" },
    output: JSON.stringify({ input: { inputId: "input_review", state: "settled", outcome: "completed" }, timedOut: false }),
    showToolDetails: true,
  }));
  expect(detailed.mode).toBe("block");
  expect(detailed.details.find((detail) => detail.label === "input")?.lines.join(" ")).toContain("input_review");
  const failed = renderToolActivity(toolInput({
    toolName: "agent_send",
    input: { agentId: "session_reader", text: "inspect API" },
    status: "failed",
    displayStatus: "failed",
    error: "Agent is not visible to this caller",
  }));
  expect(failed).toMatchObject({ mode: "block", compactErrorLines: ["Agent is not visible to this caller"] });
});

test("removed Team and task tools use the generic historical renderer", () => {
  for (const name of ["team_create", "team_run_loop", "task", "task_batch", "task_wait_batch", "complete_task", "agent_message_send", "agent_message_list", "agent_unknown"]) {
    expect(defaultToolRendererRegistry.rendererFor(name).name).toBe("fallback");
  }
  expect(defaultToolRendererRegistry.rendererFor("tool.agent_wait").name).toBe("agent");
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
    ...(overrides.executionContext === undefined ? {} : { executionContext: overrides.executionContext }),
    ...(overrides.liveOutput === undefined ? {} : { liveOutput: overrides.liveOutput }),
  };
}
