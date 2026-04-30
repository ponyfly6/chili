import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createRuntimeView, type ChatTranscriptItem, type TeamLiveAction, type TeamLiveView } from "@chili/sdk";
import type { ApprovalId, MessageId, PartId, TaskId, ToolCallId, TurnId } from "@chili/protocol";
import { ChatShellSurface } from "./ChatShellApp.js";
import { TeamLiveSurface } from "./TeamLiveApp.js";
import type { ChatRuntimeState } from "./useChatRuntime.js";
import type { TeamLiveSurfaceRuntime } from "./components/types.js";
import {
  emptyTeamLiveFixture,
  teamLiveFixture,
  withActions,
  withConnection,
  withLongText,
  withMultipleTeams,
} from "./test-fixtures.js";

test("renders chat shell by default instead of the team cockpit", async () => {
  const frame = await renderShellFrame(teamLiveFixture(), { width: 120, height: 40 });

  expect(frame).toContain("Ask anything");
  expect(frame).toContain("Chili");
  expect(frame).toContain("████");
  expect(frame).not.toContain("coding agent");
  expect(frame).not.toContain("Chili Team Live");
});

test("chat prompt exposes a native renderer cursor", async () => {
  const app = await renderShell(teamLiveFixture(), { width: 120, height: 40 });

  try {
    const cursor = app.captureSpans().cursor;
    expect(cursor[0]).toBeGreaterThan(0);
    expect(cursor[1]).toBeGreaterThan(0);
  } finally {
    app.renderer.destroy();
  }
});

test("renders fielded chat footer with cwd status model and usage fallback", async () => {
  const frame = await renderShellFrame(teamLiveFixture(), { width: 120, height: 24 });

  expect(frame).toContain("/repo/chili");
  expect(frame).toContain("idle");
  expect(frame).toContain("ctx --");
  expect(frame).toContain("test-provider/test-model Build");
  expect(frame).toContain("Details off");
  expect(frame).toContain("Ctrl+T Transcript");
});

test("renders token usage and known context when model metadata is available", async () => {
  const frame = await renderShellFrame(teamLiveFixture(), {
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

  expect(frame).toContain("ctx 20.0k/205k 10%");
  expect(frame).toContain("used 75.0k");
  expect(frame).toContain("minimax/MiniMax-M2.7 Build");
});

test("renders latest context tokens without a percentage when the model limit is unavailable", async () => {
  const frame = await renderShellFrame(teamLiveFixture(), {
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

  expect(frame).toContain("ctx 20.0k  used 75.0k");
  expect(frame).not.toContain("ctx 20.0k/");
  expect(frame).not.toContain("10%");
});

test("keeps the input visible in a short narrow chat frame", async () => {
  const frame = await renderShellFrame(teamLiveFixture(), {
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
  expect(frame).toContain("ctx --");
  expect(lineCount(frame)).toBe(12);
});

test("renders chat shell action feedback", async () => {
  const pending = await renderShellFrame(teamLiveFixture(), {
    width: 120,
    height: 40,
    runtime: fakeChatRuntime({
      actionFeedback: { key: "run_loop:team_live", type: "run_loop", status: "pending", message: "starting team loop" },
      pendingActionKey: "run_loop:team_live",
    }),
  });
  const success = await renderShellFrame(teamLiveFixture(), {
    width: 120,
    height: 40,
    runtime: fakeChatRuntime({
      actionFeedback: { key: "merge:team_live:task_live", type: "merge", status: "success", message: "merge completed" },
    }),
  });
  const error = await renderShellFrame(teamLiveFixture(), {
    width: 120,
    height: 40,
    runtime: fakeChatRuntime({
      actionFeedback: { key: "merge:team_live:task_live", type: "merge", status: "error", message: "merge failed" },
    }),
  });

  expect(pending).toContain("pending: starting team loop");
  expect(success).toContain("success: merge completed");
  expect(error).toContain("merge failed");
});

test("renders chat transcript as a scrollable window", async () => {
  const app = await renderShell(teamLiveFixture(), {
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
    expect(app.captureCharFrame()).toContain("History");
    expect(app.captureCharFrame()).toContain("message 30");
    expect(app.captureCharFrame()).not.toContain("message 01");

    act(() => {
      app.mockInput.pressKey("y", { ctrl: true });
      app.mockInput.pressKey("y", { ctrl: true });
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("History");
    expect(app.captureCharFrame()).toContain("message 01");
    expect(app.captureCharFrame()).not.toContain("message 30");
  } finally {
    app.renderer.destroy();
  }
});

test("scrolls a long single assistant message by rendered lines", async () => {
  const app = await renderShell(teamLiveFixture(), {
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
    expect(app.captureCharFrame()).toContain("History");
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
  const frame = await renderShellFrame(teamLiveFixture(), {
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
  expect(frame).toContain("🌶️: final answer");
  expect(frame).not.toContain("🌶️: checking the plan final answer");
});

test("renders tool rows as compact activity without raw output blocks", async () => {
  const frame = await renderShellFrame(teamLiveFixture(), {
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
  expect(frame).toContain("Exploring 1 file, searched 1 pattern");
  expect(frame).not.toContain("result tool_done: ok");
  expect(frame).toContain("Rejected a.ts");
});

test("ctrl+o toggles tool details and footer status", async () => {
  const output = Array.from({ length: 12 }, (_, index) => `line_${String(index + 1).padStart(2, "0")}`).join("\n");
  const app = await renderShell(teamLiveFixture(), {
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
    expect(app.captureCharFrame()).toContain("Details off");
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
    expect(app.captureCharFrame()).toContain("line_05");
    expect(app.captureCharFrame()).not.toContain("line_06");
  } finally {
    app.renderer.destroy();
  }
});

test("ctrl+t opens transcript view with raw tool and approval details, and escape returns to chat", async () => {
  const items = rawTranscriptItems();
  const app = await renderShell(teamLiveFixture(), {
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
    expect(app.captureCharFrame()).toContain("Ctrl+T Transcript on");
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
  const app = await renderShell(teamLiveFixture(), {
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
  const app = await renderShell(teamLiveFixture(), {
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
  const frame = await renderShellFrame(teamLiveFixture(), {
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
  expect(frame).not.toContain("a approve once | x reject");
});

test("folds long approval details without hiding the prompt", async () => {
  const longCommand = Array.from({ length: 80 }, (_, index) => `echo segment_${index}`).join(" && ");
  const frame = await renderShellFrame(teamLiveFixture(), {
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
  expect(frame).toContain("lines folded");
  expect(frame).toContain("Resolve approval to continue");
  expect(frame).toContain("commands");
});

test("mouse wheel scrolls the chat transcript", async () => {
  const app = await renderShell(teamLiveFixture(), {
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
      for (let index = 0; index < 8; index += 1) {
        await app.mockMouse.scroll(10, 3, "up");
      }
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("History");
    expect(app.captureCharFrame()).toContain("message 01");
    expect(app.captureCharFrame()).not.toContain("message 30");

    await act(async () => {
      for (let index = 0; index < 8; index += 1) {
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

test("renders empty Team Live frame", async () => {
  const frame = await renderFrame(emptyTeamLiveFixture(), { width: 80, height: 24 });

  expect(frame).toContain("Chili Team Live");
  expect(frame).toContain("No teams projected yet");
  expect(frame).toContain("size:80x24");
});

test("renders connecting and error states", async () => {
  const connecting = await renderFrame(emptyTeamLiveFixture("connecting"), { width: 80, height: 24 });
  const error = await renderFrame(withConnection(teamLiveFixture(), { status: "error", error: "runtime unavailable" }), {
    width: 120,
    height: 40,
    runtime: fakeRuntime({ message: "runtime unavailable" }),
  });

  expect(connecting).toContain("connection:connecting");
  expect(error).toContain("connection:error");
  expect(error).toContain("runtime unavailable");
});

test("renders multiple teams", async () => {
  const frame = await renderFrame(withMultipleTeams(teamLiveFixture()), { width: 120, height: 40 });

  expect(frame).toContain("live");
  expect(frame).toContain("second");
});

test("renders active run and active tool", async () => {
  const frame = await renderFrame(teamLiveFixture(), { width: 120, height: 40 });

  expect(frame).toContain("dispatch");
  expect(frame).toContain("read_file");
});

test("renders pending approval", async () => {
  const frame = await renderFrame(teamLiveFixture(), { width: 120, height: 40 });

  expect(frame).toContain("Approvals");
  expect(frame).toContain("tool.edit");
});

test("renders pending merge", async () => {
  const frame = await renderFrame(teamLiveFixture(), { width: 120, height: 40 });

  expect(frame).toContain("merge:pending");
  expect(frame).toContain("merge");
});

test("renders disabled action", async () => {
  const view = teamLiveFixture();
  const frame = await renderFrame(withActions(view, view.selected?.availableActions ?? []), { width: 120, height: 40 });

  expect(frame).toContain("disabled:r");
});

test("renders overflow ranges for windowed lists", async () => {
  const frame = await renderFrame(withOverflowRows(teamLiveFixture()), { width: 120, height: 40 });

  expect(frame).toContain("Task Board 1-12/16");
  expect(frame).toContain("Approvals 1-5/10");
  expect(frame).toContain("Actions 1-8/10");
});

test("renders long text without pushing outside the frame", async () => {
  const frame = await renderFrame(withLongText(teamLiveFixture()), { width: 120, height: 40 });

  expect(frame).toContain("Task Board");
  expect(lineCount(frame)).toBe(40);
});

test("supports 80x24 narrow layout", async () => {
  const frame = await renderFrame(teamLiveFixture(), { width: 80, height: 24 });

  expect(frame).toContain("size:80x24");
  expect(lineCount(frame)).toBe(24);
});

test("supports 120x40 wide layout with detail pane", async () => {
  const frame = await renderFrame(teamLiveFixture(), { width: 120, height: 40 });

  expect(frame).toContain("size:120x40");
  expect(frame).toContain("Detail");
  expect(lineCount(frame)).toBe(40);
});

async function renderFrame(
  model: TeamLiveView,
  options: {
    width: number;
    height: number;
    runtime?: TeamLiveSurfaceRuntime;
  },
): Promise<string> {
  const app = await testRender(
    <TeamLiveSurface
      model={model}
      runtime={options.runtime ?? fakeRuntime()}
      selectedTeamId={model.selectedTeamId}
      selectedTeamLocked={false}
      onSelectTeam={() => undefined}
      onExit={() => undefined}
    />,
    { width: options.width, height: options.height, exitOnCtrlC: false },
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

async function renderShellFrame(
  model: TeamLiveView,
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
  model: TeamLiveView,
  options: {
    width: number;
    height: number;
    runtime?: ChatRuntimeState;
    useMouse?: boolean;
  },
) {
  const app = await testRender(
    <ChatShellSurface
      model={model}
      runtime={options.runtime ?? fakeChatRuntime()}
      selectedTeamId={model.selectedTeamId}
      selectedTeamLocked={false}
      onSelectTeam={() => undefined}
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

function fakeRuntime(input: Partial<TeamLiveSurfaceRuntime> = {}): TeamLiveSurfaceRuntime {
  return {
    message: "test stream",
    reconnect: () => undefined,
    executeAction: (_action: TeamLiveAction) => undefined,
    clearActionFeedback: () => undefined,
    ...input,
  };
}

function fakeChatRuntime(input: Partial<ChatRuntimeState> = {}): ChatRuntimeState {
  return {
    runtimeView: createRuntimeView(),
    revision: 0,
    connection: { status: "streaming", lastEventId: "event_live" },
    message: "test stream",
    reconnect: () => undefined,
    executeAction: (_action: TeamLiveAction) => undefined,
    clearActionFeedback: () => undefined,
    chatView: { status: "idle", items: [], pendingApprovals: [], activeTools: [], generatedAt: "1970-01-01T00:00:00.000Z" },
    canSubmit: true,
    submitPrompt: async () => true,
    interruptActiveSession: async () => undefined,
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

function withOverflowRows(view: TeamLiveView): TeamLiveView {
  const selected = requireSelected(view);
  const teamId = requireTeamId(view);
  const baseTask = requireFirst(selected.tasks);
  const baseApproval = requireFirst(selected.pendingApprovals);
  const tasks = Array.from({ length: 16 }, (_, index) => ({
    ...baseTask,
    id: `task_overflow_${index + 1}` as TaskId,
    title: `Overflow task ${index + 1}`,
  }));
  const pendingApprovals = Array.from({ length: 10 }, (_, index) => ({
    ...baseApproval,
    id: `approval_overflow_${index + 1}` as ApprovalId,
    toolName: `approval-tool-${index + 1}`,
  }));
  const actions: TeamLiveAction[] = Array.from({ length: 10 }, (_, index) => ({
    type: "run_loop",
    teamId,
    enabled: index % 2 === 0,
    ...(index % 2 === 0 ? {} : { reason: "test_disabled" }),
  }));

  return {
    ...view,
    availableActions: actions,
    selected: {
      ...selected,
      tasks,
      pendingApprovals,
      availableActions: actions,
    },
  };
}

function requireSelected(view: TeamLiveView): NonNullable<TeamLiveView["selected"]> {
  if (!view.selected) throw new Error("fixture requires selected team");
  return view.selected;
}

function requireTeamId(view: TeamLiveView): NonNullable<TeamLiveView["selectedTeamId"]> {
  if (!view.selectedTeamId) throw new Error("fixture requires selected team id");
  return view.selectedTeamId;
}

function requireFirst<T>(items: readonly T[]): T {
  const first = items[0];
  if (!first) throw new Error("fixture requires at least one item");
  return first;
}
