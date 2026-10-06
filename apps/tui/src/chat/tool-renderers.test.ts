import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
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

test("team renderers label batched tasks and summarize run loop output", () => {
  const created = renderToolActivity(toolInput({
    toolName: "team_task_create_batch",
    inputSummary: { title: "team_task_create_batch" },
    input: { team_id: "team_core" },
  }));
  const dispatched = renderToolActivity(toolInput({
    toolName: "team_task_dispatch_batch",
    inputSummary: { title: "team_task_dispatch_batch" },
    input: { team_id: "team_core" },
  }));
  const runLoop = renderToolActivity(toolInput({
    toolName: "team_run_loop",
    inputSummary: { title: "team_run_loop" },
    input: { team_id: "team_core" },
    output: JSON.stringify({
      stop_reason: "once",
      max_concurrent_dispatches: 4,
      max_concurrent_verifications: 2,
      dispatched: [{ task_id: "task_a" }, { task_id: "task_b" }],
      completed: [],
      accepted: [{ task_id: "task_done" }],
      merged: [],
      still_running: [{ task_id: "task_a" }],
      blocked: [{ task_id: "task_blocked" }],
      errors: [],
    }),
  }));

  expect(created).toMatchObject({
    label: "Created persistent team tasks team_core",
    mode: "inline",
  });
  expect(dispatched).toMatchObject({
    label: "Dispatched persistent team tasks team_core",
    mode: "inline",
  });
  expect(runLoop).toMatchObject({
    label: "Ran persistent team loop team_core",
    mode: "inline",
    summary: "stop=once, bottleneck=blocked, fanout=4, verify=2, dispatched=2, completed=1, running=1, blocked=1",
  });
});

test.each([
  { toolName: "agent_spawn", input: { description: "inspect API", prompt: "inspect" }, label: "Started ad-hoc agent inspect API" },
  { toolName: "agent_list", input: { status: "running" }, label: "Listed ad-hoc agents running" },
  { toolName: "agent_list", input: { view: "messages", status: "queued" }, label: "Listed agent messages queued" },
  { toolName: "agent_send", input: { to: "/root/reader", content: "inspect API" }, label: "Sent agent message to /root/reader" },
  { toolName: "agent_wait", input: { taskId: "task_a" }, label: "Waited for ad-hoc agent task_a" },
  { toolName: "agent_stop", input: { taskId: "task_a" }, label: "Stopped ad-hoc agent task_a" },
  { toolName: "agent_resume", input: { taskId: "task_a", prompt: "continue" }, label: "Resumed ad-hoc agent task_a" },
])("unified $toolName renderer exposes its lifecycle action", ({ toolName, input, label }) => {
  expect(renderToolActivity(toolInput({
    toolName,
    inputSummary: { title: toolName },
    input,
  })).label).toBe(label);
});

test("unified agent spawn and wait retain batch summaries", () => {
  const tasks = [
    { taskId: "task_a", status: "completed" },
    { taskId: "task_b", status: "running" },
  ];
  const spawned = renderToolActivity(toolInput({
    toolName: "agent_spawn",
    inputSummary: { title: "agent_spawn" },
    input: { tasks: [{ description: "API" }, { description: "TUI" }], maxConcurrency: 2 },
    output: JSON.stringify({ count: 2, maxConcurrency: 2, tasks }),
  }));
  const waited = renderToolActivity(toolInput({
    toolName: "agent_wait",
    inputSummary: { title: "agent_wait" },
    input: { taskIds: ["task_a", "task_b"], waitFor: "any" },
    output: JSON.stringify({ count: 2, waitFor: "any", timedOut: false, tasks }),
  }));
  expect(spawned).toMatchObject({
    label: "Started 2 ad-hoc agents",
    mode: "inline",
    summary: "agents=2, fanout=2, running=1, completed=1",
  });
  expect(waited).toMatchObject({
    label: "Waited for 2 ad-hoc agents (any)",
    mode: "inline",
    summary: "wait=any, agents=2, timed_out=false, running=1, completed=1",
  });
});

test("agent and team renderers distinguish ad-hoc work from persistent teams", () => {
  const batch = renderToolActivity(toolInput({
    toolName: "task_batch",
    inputSummary: { title: "task_batch" },
    input: {
      max_concurrency: 2,
      tasks: [
        { description: "inspect API" },
        { description: "inspect TUI" },
        { description: "run tests" },
      ],
    },
    output: JSON.stringify({
      count: 3,
      max_concurrency: 2,
      tasks: [
        { task_id: "task_a", status: "running" },
        { task_id: "task_b", status: "completed" },
        { task_id: "task_c", status: "failed" },
      ],
    }),
  }));
  const createdTeam = renderToolActivity(toolInput({
    toolName: "team_create",
    inputSummary: { title: "team_create" },
    input: { name: "research" },
  }));
  const addedMember = renderToolActivity(toolInput({
    toolName: "team_member_add",
    inputSummary: { title: "team_member_add" },
    input: { team_id: "team_research", name: "reader", path: "/root/reader" },
  }));

  expect(batch).toMatchObject({
    label: "Started 3 ad-hoc agents",
    mode: "inline",
    summary: "agents=3, fanout=2, running=1, completed=1, failed=1",
  });
  expect(createdTeam.label).toBe("Created persistent team research");
  expect(addedMember.label).toBe("Added persistent team member reader");
});

test("batch wait and agent message renderers expose lifecycle semantics", () => {
  const joined = renderToolActivity(toolInput({
    toolName: "task_batch",
    inputSummary: { title: "task_batch" },
    input: { tasks: [{ description: "a" }, { description: "b" }] },
    output: JSON.stringify({
      count: 2,
      completion_policy: "join",
      max_concurrency: 4,
      joined: true,
      tasks: [
        { task_id: "task_a", status: "completed", summary: "done" },
        { task_id: "task_b", status: "incomplete", summary: "turn limit" },
      ],
    }),
  }));
  const waited = renderToolActivity(toolInput({
    toolName: "task_wait_batch",
    inputSummary: { title: "task_wait_batch" },
    input: { task_ids: ["task_a", "task_b", "task_c"], wait_for: "any" },
    output: JSON.stringify({
      wait_for: "any",
      count: 3,
      timed_out: true,
      tasks: [
        { task_id: "task_a", status: "completed" },
        { task_id: "task_b", status: "running" },
        { task_id: "task_c", status: "failed" },
      ],
    }),
  }));
  const sent = renderToolActivity(toolInput({
    toolName: "agent_message_send",
    inputSummary: { title: "agent_message_send" },
    input: { to: "/root/reader", content: "focus on projection" },
  }));
  const listed = renderToolActivity(toolInput({
    toolName: "agent_message_list",
    inputSummary: { title: "agent_message_list" },
    input: { status: "queued" },
  }));

  expect(joined).toMatchObject({
    label: "Started 2 ad-hoc agents",
    summary: "agents=2, policy=join, fanout=4, joined=true, completed=1, incomplete=1",
  });
  expect(waited).toMatchObject({
    label: "Waited for 3 ad-hoc agents (any)",
    mode: "inline",
    summary: "wait=any, agents=3, timed_out=true, running=1, completed=1, failed=1",
  });
  expect(sent.label).toBe("Sent agent message to /root/reader");
  expect(listed.label).toBe("Listed agent messages queued");
});

test("task batch renderer reports an all-failed camel-case spawn result", () => {
  const batch = renderToolActivity(toolInput({
    toolName: "task_batch",
    inputSummary: { title: "task_batch" },
    input: {
      tasks: [
        { description: "inspect API" },
        { description: "inspect TUI" },
        { description: "run tests" },
      ],
    },
    output: JSON.stringify({
      expectedBatchSize: 3,
      spawnedCount: 0,
      spawnFailureCount: 3,
      spawnFailures: [
        { batchIndex: 0, description: "inspect API", error: "spawn failed: inspect API" },
        { batchIndex: 1, description: "inspect TUI", error: "spawn failed: inspect TUI" },
        { batchIndex: 2, description: "run tests", error: "spawn failed: run tests" },
      ],
      completionPolicy: "join",
      maxConcurrency: 3,
      joined: true,
      timedOut: false,
      tasks: [],
    }),
  }));

  expect(batch).toMatchObject({
    label: "Failed to spawn 3 ad-hoc agents",
    mode: "inline",
    summary: "agents=0, planned=3, spawn_failed=3, policy=join, fanout=3, joined=true, timed_out=false",
  });
});

test("task batch renderer reports a partial snake-case spawn result", () => {
  const batch = renderToolActivity(toolInput({
    toolName: "task_batch",
    inputSummary: { title: "task_batch" },
    input: {
      tasks: [
        { description: "inspect API" },
        { description: "inspect TUI" },
        { description: "run tests" },
      ],
    },
    output: JSON.stringify({
      expected_batch_size: 3,
      spawned_count: 2,
      spawn_failure_count: 1,
      spawn_failures: [
        { batch_index: 1, description: "inspect TUI", error: "spawn failed: inspect TUI" },
      ],
      completion_policy: "join",
      max_concurrency: 3,
      joined: true,
      timed_out: false,
      tasks: [
        { task_id: "task_api", status: "completed" },
        { task_id: "task_tests", status: "running" },
      ],
    }),
  }));

  expect(batch).toMatchObject({
    label: "Started 2 of 3 ad-hoc agents (1 failed to spawn)",
    mode: "inline",
    summary: "agents=2, planned=3, spawn_failed=1, policy=join, fanout=3, joined=true, timed_out=false, running=1, completed=1",
  });
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
