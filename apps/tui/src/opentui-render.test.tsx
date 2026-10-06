import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createRuntimeView, type ChatTranscriptItem } from "@chili/sdk";
import type { ApprovalId, MessageId, PartId, ToolCallId, TurnId } from "@chili/protocol";
import { ChatShellSurface } from "./ChatShellApp.js";
import type { ChatRuntimeState } from "./useChatRuntime.js";
import { chiliDarkTheme } from "./theme/index.js";
import { runtimeFixture, type RuntimeFixture } from "./test-fixtures.js";

test("renders the chat shell", async () => {
  const frame = await renderShellFrame(runtimeFixture(), { width: 120, height: 40 });

  expect(frame).toContain("Ask anything");
  expect(frame).toContain("Chili");
  expect(frame).toContain("████");
  expect(frame).not.toContain("coding agent");
});

test("chat prompt exposes a native renderer cursor", async () => {
  const app = await renderShell(runtimeFixture(), { width: 120, height: 40 });

  try {
    const cursor = app.captureSpans().cursor;
    expect(cursor[0]).toBeGreaterThan(0);
    expect(cursor[1]).toBeGreaterThan(0);
  } finally {
    app.renderer.destroy();
  }
});

test("renders a restrained one-line chat footer", async () => {
  const frame = await renderShellFrame(runtimeFixture("streaming"), { width: 120, height: 24 });
  const footerLine = frame.split("\n").find((line) => line.includes("test-model")) ?? "";

  expect(footerLine).toContain("chili");
  expect(footerLine).toContain("Build");
  expect(frame).not.toContain("test-provider/");
  expect(frame).not.toContain("idle");
  expect(frame).not.toContain("ctx --");
  expect(frame).not.toContain("Details off");
  expect(frame).not.toContain("Ctrl+T Transcript");
});

test("chat footer follows the persisted session workspace", async () => {
  const frame = await renderShellFrame(runtimeFixture("streaming"), {
    width: 120,
    height: 24,
    runtime: fakeChatRuntime({
      chatView: {
        cwd: "/server/persisted-workspace",
        status: "idle",
        items: [],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "now",
      },
    }),
  });

  const footerLine = frame.split("\n").find((line) => line.includes("test-model")) ?? "";
  expect(footerLine).toContain("persisted-workspace");
  expect(footerLine).not.toContain("chili");
});

test("renders remaining context without cumulative token usage", async () => {
  const frame = await renderShellFrame(runtimeFixture("streaming"), {
    width: 120,
    height: 24,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: chatMessages(1),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
        latestModelMetadata: {
          turnId: "turn_usage" as TurnId,
          provider: "minimax",
          model: "MiniMax-M2.7",
          contextWindowTokens: 204800,
          usage: { inputTokens: 20000, outputTokens: 3000, totalTokens: 23000 },
        },
        usageSummary: { inputTokens: 70000, outputTokens: 5000, totalTokens: 75000 },
      },
    }),
  });

  expect(frame).toContain("90% ctx left");
  expect(frame).toContain("MiniMax-M2.7");
  expect(frame).not.toContain("used 75.0k");
  expect(frame).not.toContain("minimax/");
});

test("renders compact context tokens when the model limit is unavailable", async () => {
  const frame = await renderShellFrame(runtimeFixture("streaming"), {
    width: 120,
    height: 24,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: chatMessages(1),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
        latestModelMetadata: {
          turnId: "turn_usage_without_limit" as TurnId,
          provider: "custom",
          model: "custom-model",
          usage: { inputTokens: 20000, outputTokens: 3000, totalTokens: 23000 },
        },
        usageSummary: { inputTokens: 70000, outputTokens: 5000, totalTokens: 75000 },
      },
    }),
  });

  expect(frame).toContain("20.0k ctx");
  expect(frame).not.toContain("used 75.0k");
  expect(frame).not.toContain("custom/");
});

test("keeps the input visible in a short narrow chat frame", async () => {
  const frame = await renderShellFrame(runtimeFixture("streaming"), {
    width: 64,
    height: 12,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: chatMessages(8),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  expect(frame).toContain("Ask anything");
  expect(frame).toContain("test-model");
  expect(frame).not.toContain("ctx --");
  expect(lineCount(frame)).toBe(12);
});

test("renders chat shell action feedback", async () => {
  const pending = await renderShellFrame(runtimeFixture(), {
    width: 120,
    height: 40,
    runtime: fakeChatRuntime({
      chatFeedback: { status: "pending", message: "submitting prompt" },
    }),
  });
  const success = await renderShellFrame(runtimeFixture(), {
    width: 120,
    height: 40,
    runtime: fakeChatRuntime({
      chatFeedback: { status: "success", message: "prompt accepted" },
    }),
  });
  const error = await renderShellFrame(runtimeFixture(), {
    width: 120,
    height: 40,
    runtime: fakeChatRuntime({
      chatFeedback: { status: "error", message: "prompt failed" },
    }),
  });

  expect(pending).toContain("pending: submitting prompt");
  expect(success).toContain("success: prompt accepted");
  expect(error).toContain("prompt failed");
});

test("accepted feedback is bound to the next per-session status event", async () => {
  const staleFailure = await renderShellFrame(runtimeFixture(), {
    width: 120,
    height: 40,
    runtime: fakeChatRuntime({
      chatFeedback: {
        status: "accepted",
        message: "prompt queued",
        acceptedAgainstStatusEventId: "event_old_failed",
      },
      chatView: {
        status: "failed",
        statusEventId: "event_old_failed",
        statusReason: "old failure must not replace the new acknowledgement",
        items: [],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "now",
      },
    }),
  });
  const running = await renderShellFrame(runtimeFixture(), {
    width: 120,
    height: 40,
    runtime: fakeChatRuntime({
      chatFeedback: {
        status: "accepted",
        message: "prompt queued",
        acceptedAgainstStatusEventId: "event_old_failed",
      },
      chatView: {
        status: "running",
        statusEventId: "event_new_running",
        items: [],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "now",
      },
    }),
  });
  const newFailure = await renderShellFrame(runtimeFixture(), {
    width: 120,
    height: 40,
    runtime: fakeChatRuntime({
      chatFeedback: {
        status: "accepted",
        message: "prompt queued",
        acceptedAgainstStatusEventId: "event_old_failed",
      },
      chatView: {
        status: "failed",
        statusEventId: "event_new_failed",
        statusReason: "Model request failed with HTTP 502 Bad Gateway",
        items: [],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "now",
      },
    }),
  });

  expect(staleFailure).toContain("accepted: prompt queued");
  expect(staleFailure).not.toContain("old failure must not replace");
  expect(running).toContain("pending: session running");
  expect(running).not.toContain("prompt queued");
  expect(newFailure).toContain("Model request failed with HTTP 502 Bad Gateway");
  expect(newFailure).not.toContain("prompt queued");
});

test("retry feedback exposes timing without rendering the unsafe provider reason", async () => {
  const frame = await renderShellFrame(runtimeFixture(), {
    width: 120,
    height: 40,
    runtime: fakeChatRuntime({
      chatView: {
        status: "running",
        statusEventId: "event_retry_running",
        items: [],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "now",
        retry: {
          turnId: "turn_retry" as TurnId,
          attempt: 2,
          delayMs: 1_500,
          reason: "<!DOCTYPE html><html>private provider page</html>",
          scheduledAt: 1,
        },
      },
    }),
  });

  expect(frame).toContain("retrying request · attempt 2 · 2s");
  expect(frame).not.toContain("private provider page");
});

test("renders chat transcript as a scrollable window", async () => {
  const app = await renderShell(runtimeFixture("streaming"), {
    width: 120,
    height: 24,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: chatMessages(30),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  try {
    expect(app.captureCharFrame()).toContain("message 30");
    expect(app.captureCharFrame()).not.toContain("message 01");

    act(() => {
      for (let index = 0; index < 4; index += 1) app.mockInput.pressKey("y", { ctrl: true });
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("message 01");
    expect(app.captureCharFrame()).not.toContain("message 30");
  } finally {
    app.renderer.destroy();
  }
});

test("scrolls a long single assistant message by rendered lines", async () => {
  const app = await renderShell(runtimeFixture(), {
    width: 120,
    height: 24,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: [longAssistantMessage(30)],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  try {
    expect(app.captureCharFrame()).toContain("long line 30");
    expect(app.captureCharFrame()).not.toContain("long line 01");

    act(() => {
      app.mockInput.pressKey("y", { ctrl: true });
      app.mockInput.pressKey("y", { ctrl: true });
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("long line 01");
    expect(app.captureCharFrame()).not.toContain("long line 30");
  } finally {
    app.renderer.destroy();
  }
});

test("renders reasoning separately from assistant text", async () => {
  const frame = await renderShellFrame(runtimeFixture(), {
    width: 120,
    height: 24,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: [
          {
            id: "msg_reasoning" as MessageId,
            kind: "message",
            role: "assistant",
            createdAt: 1,
            parts: [
              { type: "reasoning", id: "part_reasoning" as PartId, text: "checking the plan" },
              { type: "text", id: "part_answer" as PartId, text: "final answer" },
            ],
          },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  expect(frame).toContain("Thinking");
  expect(frame).toContain("Thinking: checking the plan");
  expect(frame).toContain("final answer");
  expect(frame).not.toContain("🌶️: checking the plan final answer");
});

test("renders tool rows as compact activity without raw output blocks", async () => {
  const frame = await renderShellFrame(runtimeFixture(), {
    width: 120,
    height: 30,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: [
          chatTool("tool_wait", "bash", "waiting_for_approval", "waiting_permission", { title: "bash", command: "bun test", detail: "bun test" }),
          chatTool("tool_run", "grep", "running", "running", { title: "grep", pattern: "TODO", scope: "apps/tui", detail: "TODO in apps/tui" }),
          { ...chatTool("tool_done", "read", "completed", "succeeded", { title: "read", path: "README.md", detail: "README.md" }), output: "ok" },
          { ...chatTool("tool_reject", "edit", "cancelled", "rejected", { title: "edit", path: "src/a.ts", detail: "src/a.ts" }), approvalDecision: "deny" },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  expect(frame).toContain("Waiting approval for bun test");
  expect(frame).toContain("Searching TODO in apps/tui");
  expect(frame).toContain("Read README.md");
  expect(frame).not.toContain("result tool_done: ok");
  expect(frame).toContain("Rejected a.ts");
});

test("ctrl+o toggles tool details and footer status", async () => {
  const output = Array.from({ length: 12 }, (_, index) => `line_${String(index + 1).padStart(2, "0")}`).join("\n");
  const app = await renderShell(runtimeFixture(), {
    width: 120,
    height: 36,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: [
          {
            ...chatTool("tool_toggle_details", "bash", "completed", "succeeded", { title: "bash", command: "bun test", detail: "bun test" }),
            input: { command: "bun test" },
            output,
          },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  try {
    expect(app.captureCharFrame()).not.toContain("Details on");
    expect(app.captureCharFrame()).toContain("output hidden (12 lines, details available)");
    expect(app.captureCharFrame()).not.toContain("line_01");

    act(() => {
      app.mockInput.pressKey("o", { ctrl: true });
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("Details on");
    expect(app.captureCharFrame()).not.toContain("output hidden");
    expect(app.captureCharFrame()).toContain("output (truncated):");
    expect(app.captureCharFrame()).toContain("line_01");
    expect(app.captureCharFrame()).toContain("… +8 lines");
    expect(app.captureCharFrame()).toContain("line_12");
    expect(app.captureCharFrame()).not.toContain("line_06");
  } finally {
    app.renderer.destroy();
  }
});

test("ctrl+t opens transcript view with raw tool and approval details, and escape returns to chat", async () => {
  const items = rawTranscriptItems();
  const app = await renderShell(runtimeFixture("streaming"), {
    width: 120,
    height: 54,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items,
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  try {
    expect(app.captureCharFrame()).toContain("Failed bun test");
    expect(app.captureCharFrame()).not.toContain("RAW_TOOL_OUTPUT_LINE_1");
    expect(app.captureCharFrame()).not.toContain("RAW_MESSAGE_RESULT_LINE_1");

    act(() => {
      app.mockInput.pressKey("t", { ctrl: true });
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("Transcript");
    expect(app.captureCharFrame()).toContain("Transcript on");
    expect(app.captureCharFrame()).toContain("tool bash failed tool_raw");
    expect(app.captureCharFrame()).toContain("\"command\": \"bun test\"");
    expect(app.captureCharFrame()).toContain("RAW_TOOL_OUTPUT_LINE_1");
    expect(app.captureCharFrame()).toContain("RAW_TOOL_ERROR_LINE_1");
    expect(app.captureCharFrame()).toContain("approval approval_transcript pending");
    expect(app.captureCharFrame()).toContain("permission: tool.bash");

    act(() => {
      app.mockInput.pressKey("y", { ctrl: true });
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("part tool_call");
    expect(app.captureCharFrame()).toContain("part tool_result");
    expect(app.captureCharFrame()).toContain("RAW_MESSAGE_RESULT_LINE_1");

    act(() => {
      app.mockInput.pressEscape();
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).not.toContain("Transcript on");
    expect(app.captureCharFrame()).toContain("Failed bun test");
    expect(app.captureCharFrame()).not.toContain("RAW_TOOL_OUTPUT_LINE_1");
  } finally {
    app.renderer.destroy();
  }
});

test("transcript scroll offset is independent from chat scroll offset", async () => {
  const app = await renderShell(runtimeFixture(), {
    width: 120,
    height: 24,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: chatMessages(30),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  try {
    expect(app.captureCharFrame()).toContain("message 30");
    expect(app.captureCharFrame()).not.toContain("message 01");

    act(() => {
      app.mockInput.pressKey("t", { ctrl: true });
    });
    await Bun.sleep(60);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Transcript");
    expect(app.captureCharFrame()).toContain("message 30");

    act(() => {
      for (let index = 0; index < 12; index += 1) app.mockInput.pressKey("y", { ctrl: true });
    });
    await Bun.sleep(60);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("message 01");

    act(() => {
      app.mockInput.pressEscape();
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).not.toContain("Transcript on");
    expect(app.captureCharFrame()).toContain("message 30");
    expect(app.captureCharFrame()).not.toContain("message 01");
  } finally {
    app.renderer.destroy();
  }
});

test("transcript view scrolls through long raw tool output", async () => {
  const output = Array.from({ length: 40 }, (_, index) => `raw_line_${String(index + 1).padStart(2, "0")}`).join("\n");
  const app = await renderShell(runtimeFixture(), {
    width: 120,
    height: 24,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: [
          {
            ...chatTool("tool_long_raw", "bash", "completed", "succeeded", { title: "bash", command: "bun test", detail: "bun test" }),
            input: { command: "bun test" },
            output,
          },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  try {
    act(() => {
      app.mockInput.pressKey("t", { ctrl: true });
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("Transcript");
    expect(app.captureCharFrame()).toContain("raw_line_40");
    expect(app.captureCharFrame()).not.toContain("raw_line_01");

    act(() => {
      for (let index = 0; index < 3; index += 1) app.mockInput.pressKey("y", { ctrl: true });
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("raw_line_01");
  } finally {
    app.renderer.destroy();
  }
});

test("does not render approval dock when no approval is pending", async () => {
  const frame = await renderShellFrame(runtimeFixture(), {
    width: 120,
    height: 24,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: chatMessages(1),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  expect(frame).not.toContain("Approval required");
  expect(frame).not.toContain("a once | s session");
});

test("renders approval permission patterns and risk metadata", async () => {
  const frame = await renderShellFrame(runtimeFixture(), {
    width: 110,
    height: 28,
    runtime: fakeChatRuntime({
      canSubmit: false,
      chatView: {
        status: "waiting_for_approval",
        items: chatMessages(1),
        pendingApprovals: [
          {
            id: "approval_metadata" as ApprovalId,
            kind: "approval",
            permission: "tool.bash",
            patterns: ["rm -rf build", "bun test"],
            status: "pending",
            createdAt: 1,
            toolName: "bash",
            toolDisplayStatus: "waiting_permission",
            inputSummary: { title: "bash", command: "rm -rf build && bun test", detail: "rm -rf build && bun test" },
            metadata: {
              patternDecisions: [{ pattern: "rm -rf build", action: "ask", reason: "Auto policy paused for destructive shell command", source: "workspace settings", matchedRule: "bash rm rule" }],
              risks: [{ pattern: "rm -rf build", action: "ask", reason: "removes files before tests" }],
            },
          },
        ] as never,
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  expect(frame).toContain("Approval required");
  expect(frame).toContain("> rm -rf build && bun test");
  expect(frame).toContain("risk: removes files");
  expect(frame).toContain("a once | s session | A always | x deny");
});

test("renders unsandboxed approvals as one-time only", async () => {
  const command = "echo visible first\necho visible second\nremindctl status --include-completed";
  const frame = await renderShellFrame(runtimeFixture(), {
    width: 110,
    height: 34,
    runtime: fakeChatRuntime({
      canSubmit: false,
      chatView: {
        status: "waiting_for_approval",
        items: chatMessages(1),
        pendingApprovals: [
          {
            id: "approval_unsandboxed" as ApprovalId,
            kind: "approval",
            permission: "bash.unsandboxed",
            patterns: [command],
            maxApprovalScope: "once",
            status: "pending",
            createdAt: 1,
            toolName: "bash",
            toolDisplayStatus: "waiting_permission",
            inputSummary: { title: "bash", command, detail: command, scope: "tools/reminders" },
            metadata: { justification: "inspect Reminders authorization through desktop IPC" },
          },
        ] as never,
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  expect(frame).toContain("outside Chili's host sandbox");
  expect(frame).toContain("approval is one-time");
  expect(frame).toContain("remindctl status --include-completed");
  expect(frame).not.toContain("...");
  expect(frame).toContain("cwd: tools/reminders");
  expect(frame).toContain("purpose: inspect Reminders authorization through desktop IPC");
  expect(frame).toContain("a once | x deny");
  expect(frame).not.toContain("s session");
  expect(frame).not.toContain("A always");
});

test("folds long approval details without hiding the prompt", async () => {
  const longCommand = Array.from({ length: 80 }, (_, index) => `echo segment_${index}`).join(" && ");
  const frame = await renderShellFrame(runtimeFixture(), {
    width: 80,
    height: 24,
    runtime: fakeChatRuntime({
      canSubmit: false,
      chatView: {
        status: "waiting_for_approval",
        items: chatMessages(2),
        pendingApprovals: [
          {
            id: "approval_long_command" as ApprovalId,
            kind: "approval",
            permission: "tool.bash",
            patterns: [longCommand],
            status: "pending",
            createdAt: 1,
            toolName: "bash",
            toolDisplayStatus: "waiting_permission",
            inputSummary: { title: "bash", command: longCommand, detail: longCommand },
          },
        ],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
  });

  expect(frame).toContain("Approval required");
  expect(frame).toContain("...");
  expect(frame).toContain("Resolve approval to continue");
  expect(frame).toContain("test-model · chili");
  expect(frame).toContain("Build · approval");
});

test("mouse wheel scrolls the chat transcript", async () => {
  const app = await renderShell(runtimeFixture(), {
    width: 120,
    height: 24,
    runtime: fakeChatRuntime({
      chatView: {
        status: "idle",
        items: chatMessages(30),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    }),
    useMouse: true,
  });

  try {
    expect(app.captureCharFrame()).toContain("message 30");
    expect(app.captureCharFrame()).not.toContain("message 01");

    await act(async () => {
      for (let index = 0; index < 48; index += 1) {
        await app.mockMouse.scroll(10, 3, "up");
      }
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("message 01");
    expect(app.captureCharFrame()).not.toContain("message 30");

    await act(async () => {
      for (let index = 0; index < 48; index += 1) {
        await app.mockMouse.scroll(10, 3, "down");
      }
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("message 30");
  } finally {
    app.renderer.destroy();
  }
});

async function renderShellFrame(
  model: RuntimeFixture,
  options: {
    width: number;
    height: number;
    runtime?: ChatRuntimeState;
  },
): Promise<string> {
  const app = await renderShell(model, options);

  try {
    return app.captureCharFrame();
  } finally {
    app.renderer.destroy();
  }
}

async function renderShell(
  model: RuntimeFixture,
  options: {
    width: number;
    height: number;
    runtime?: ChatRuntimeState;
    useMouse?: boolean;
  },
) {
  const app = await testRender(
    <ChatShellSurface
      runtime={options.runtime ?? fakeChatRuntime()}
      onExit={() => undefined}
      options={{ cwd: "/repo/chili", modeName: "Build", modelName: "test-model", providerName: "test-provider" }}
    />,
    {
      width: options.width,
      height: options.height,
      exitOnCtrlC: false,
      ...(options.useMouse === undefined ? {} : { useMouse: options.useMouse }),
    },
  );

  await act(async () => {
    await app.renderOnce();
  });
  return app;
}

function lineCount(frame: string): number {
  return frame.replace(/\n$/, "").split("\n").length;
}

function fakeChatRuntime(input: Partial<ChatRuntimeState> = {}): ChatRuntimeState {
  return {
    runtimeView: createRuntimeView(),
    revision: 0,
    connection: { status: "streaming", lastEventId: "event_live" },
    message: "test stream",
    reconnect: () => undefined,
    hydrateEvents: () => undefined,
    chatView: { status: "idle", items: [], pendingApprovals: [], activeTools: [], generatedAt: "1970-01-01T00:00:00.000Z" },
    canSubmit: true,
    submitPrompt: async () => true,
    submitCommand: async () => true,
    setGoal: async () => undefined,
    pauseGoal: async () => undefined,
    resumeGoal: async () => undefined,
    clearGoal: async () => false,
    startNewSession: async () => undefined,
    listSessions: async () => [],
    resumeSession: async () => true,
    renameSession: async () => undefined,
    interruptActiveSession: async () => undefined,
    stopAgent: async () => undefined,
    resumeAgent: async () => undefined,
    approveApproval: async () => undefined,
    rejectApproval: async () => undefined,
    ...input,
  };
}

function chatMessages(count: number): ChatTranscriptItem[] {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      id: `msg_${number}` as MessageId,
      kind: "message",
      role: index % 2 === 0 ? "user" : "assistant",
      createdAt: index + 1,
      parts: [
        {
          type: "text",
          id: `part_${number}` as PartId,
          text: `message ${number}`,
        },
      ],
    };
  });
}

function chatTool(
  id: string,
  toolName: string,
  status: Extract<ChatTranscriptItem, { kind: "tool" }>["status"],
  displayStatus: Extract<ChatTranscriptItem, { kind: "tool" }>["displayStatus"],
  inputSummary: Extract<ChatTranscriptItem, { kind: "tool" }>["inputSummary"],
  extra: Partial<Pick<Extract<ChatTranscriptItem, { kind: "tool" }>, "input" | "output" | "error">> = {},
): Extract<ChatTranscriptItem, { kind: "tool" }> {
  return {
    id: id as ToolCallId,
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

function rawTranscriptItems(): ChatTranscriptItem[] {
  const callId = "tool_raw" as ToolCallId;
  return [
    {
      id: "msg_transcript" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [
        { type: "text", id: "part_transcript_text" as PartId, text: "I ran the command." },
        {
          type: "tool_call",
          id: "part_transcript_call" as PartId,
          callId,
          toolName: "bash",
          status: "completed",
          displayStatus: "failed",
          input: { command: "bun test" },
        },
        {
          type: "tool_result",
          id: "part_transcript_result" as PartId,
          callId,
          output: "RAW_MESSAGE_RESULT_LINE_1",
          error: "RAW_MESSAGE_ERROR_LINE_1",
        },
      ],
    },
    chatTool(callId, "bash", "failed", "failed", { title: "bash", command: "bun test", detail: "bun test" }, {
      input: { command: "bun test" },
      output: "RAW_TOOL_OUTPUT_LINE_1\nRAW_TOOL_OUTPUT_LINE_2",
      error: "RAW_TOOL_ERROR_LINE_1\nRAW_TOOL_ERROR_LINE_2",
    }),
    {
      id: "approval_transcript" as ApprovalId,
      kind: "approval",
      permission: "tool.bash",
      patterns: ["bun test"],
      status: "pending",
      createdAt: 2,
      callId,
      toolName: "bash",
      toolInput: { command: "bun test" },
      toolStatus: "waiting_for_approval",
      toolDisplayStatus: "waiting_permission",
      inputSummary: { title: "bash", command: "bun test", detail: "bun test" },
    },
  ];
}

function longAssistantMessage(lineCount: number): ChatTranscriptItem {
  const lines = Array.from({ length: lineCount }, (_, index) => `long line ${String(index + 1).padStart(2, "0")}`);
  return {
    id: "msg_long" as MessageId,
    kind: "message",
    role: "assistant",
    createdAt: 1,
    parts: [
      {
        type: "text",
        id: "part_long" as PartId,
        text: lines.join("\n"),
      },
    ],
  };
}

function requireFirst<T>(items: readonly T[]): T {
  const first = items[0];
  if (!first) throw new Error("fixture requires at least one item");
  return first;
}
