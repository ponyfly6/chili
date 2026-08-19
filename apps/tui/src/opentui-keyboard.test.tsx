import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRuntimeView, type ChatTranscriptItem, type HttpRuntimeClient, type TeamLiveAction, type TeamLiveView } from "@chili/sdk";
import type { ApprovalId, ChiliEvent, MessageId, PartId, RuntimeModelDescriptor, SessionId, TaskId, ThreadId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import type { ClipboardAccess } from "./clipboard.js";
import { CONVERSATION_INTERRUPTED_NOTICE, CTRL_C_EXIT_CONFIRM_MS, ChatShellApp, ChatShellSurface, isWithinCtrlCExitWindow, type ChatShellExitInfo } from "./ChatShellApp.js";
import { TeamLiveSurface } from "./TeamLiveApp.js";
import type { ChatApproveOptions, ChatRuntimeState } from "./useChatRuntime.js";
import type { ModelCandidate, ModelSelection, ReasoningLevel } from "./model-state.js";
import type { SkillSummary } from "@chili/skills";
import type { TeamLiveSurfaceRuntime } from "./components/types.js";
import { chiliDarkTheme } from "./theme/index.js";
import { teamLiveFixture } from "./test-fixtures.js";

test("plain prompt creates a session and submits through the runtime client", async () => {
  const records = chatClientRecords();
  const client = fakeChatClient(records);
  const app = await mountChatApp(client);

  try {
    await typeText(app, "fix failing tests");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    expect(records.create).toHaveLength(1);
    expect(records.submit).toHaveLength(1);
    expect(records.create[0]).toMatchObject({ cwd: "/repo/chili" });
    expect(records.create[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(records.submit[0]).toMatchObject({
      sessionId: "session_created",
      threadId: "thread_created",
      text: "fix failing tests",
      cwd: "/repo/chili",
    });
    expect(records.submit[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(records.submit[0]).not.toHaveProperty("system");
  } finally {
    app.renderer.destroy();
  }
});

test("runtime connection error keeps the typed prompt visible", async () => {
  const records = chatClientRecords();
  const client = fakeChatClient(records, [], {
    createError: new Error("Unable to connect. Is the computer able to access the url?"),
  });
  const app = await mountChatApp(client);

  try {
    await typeText(app, "hello runtime");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(records.create).toHaveLength(1);
    expect(records.submit).toHaveLength(0);
    expect(frame).toContain("Runtime offline at http://runtime.test");
    expect(frame).toContain("hello runtime");
  } finally {
    app.renderer.destroy();
  }
});

test("Chinese prompt submits through native input without text drift", async () => {
  const records = chatClientRecords();
  const client = fakeChatClient(records);
  const app = await mountChatApp(client);

  try {
    await typeText(app, "修复中文光标");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    expect(records.submit[0]).toMatchObject({
      text: "修复中文光标",
    });
  } finally {
    app.renderer.destroy();
  }
});

test("ctrl+c clears the prompt before a quick second press exits", async () => {
  const exits: ChatShellExitInfo[] = [];
  const app = await mountShell(teamLiveFixture(), {
    onExit: (info) => exits.push(info ?? {}),
  });

  try {
    await typeText(app, "draft prompt");
    await press(app, () => app.mockInput.pressKey("c", { ctrl: true }));

    const frame = app.captureCharFrame();
    expect(exits).toHaveLength(0);
    expect(frame).not.toContain("draft prompt");
    expect(frame).toContain("Input cleared. Press Ctrl+C again to exit.");

    await press(app, () => app.mockInput.pressKey("c", { ctrl: true }));
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ cwd: "/repo/chili" });
  } finally {
    app.renderer.destroy();
  }
});

test("ctrl+c exit confirmation expires outside the quick-press window", () => {
  const firstPressMs = 10_000;

  expect(isWithinCtrlCExitWindow(firstPressMs, firstPressMs + CTRL_C_EXIT_CONFIRM_MS)).toBe(true);
  expect(isWithinCtrlCExitWindow(firstPressMs, firstPressMs + CTRL_C_EXIT_CONFIRM_MS + 1)).toBe(false);
});

test("bang prompt runs a local shell command without submitting to the runtime", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-tui-shell-"));
  const submitted: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    cwd,
    localMessageTtlMs: 0,
    runtime: {
      submitPrompt: async (text) => {
        submitted.push(text);
        return true;
      },
    },
  });

  try {
    await typeText(app, "!printf shell-ok");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(160);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(submitted).toEqual([]);
    expect(frame).toContain("! printf shell-ok");
    expect(frame).toContain("shell-ok");
    expect(frame).toContain("exit 0");
  } finally {
    app.renderer.destroy();
  }
});

test("empty bang prompt shows local shell help", async () => {
  const submitted: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    localMessageTtlMs: 0,
    runtime: {
      submitPrompt: async (text) => {
        submitted.push(text);
        return true;
      },
    },
  });

  try {
    await typeText(app, "!");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(submitted).toEqual([]);
    expect(frame).toContain("Prefix a command with ! to run it locally");
    expect(frame).toContain("Example: !ls");
  } finally {
    app.renderer.destroy();
  }
});

test("bang prompt switches the composer into shell mode while typing", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "!echo shell-mode");

    const frame = app.captureCharFrame();
    expect(frame).toContain("Shell");
    expect(frame).toContain("echo shell-mode");
    expect(frame).not.toContain("> !echo shell-mode");
  } finally {
    app.renderer.destroy();
  }
});

test("resume session and thread submit without creating a new session", async () => {
  const records = chatClientRecords();
  const client = fakeChatClient(records);
  const app = await mountChatApp(client, {
    sessionId: "session_resume" as SessionId,
    threadId: "thread_resume" as ThreadId,
  });

  try {
    await typeText(app, "continue");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    expect(records.create).toHaveLength(0);
    expect(records.submit).toHaveLength(1);
    expect(records.submit[0]).toMatchObject({
      sessionId: "session_resume",
      threadId: "thread_resume",
      text: "continue",
    });
  } finally {
    app.renderer.destroy();
  }
});

test("resumed chat keeps the stream global so /resume can switch sessions", async () => {
  const records = chatClientRecords();
  const client = fakeChatClient(records);
  const app = await mountChatApp(client, {
    sessionId: "session_resume" as SessionId,
    threadId: "thread_resume" as ThreadId,
  });

  try {
    await Bun.sleep(80);
    await app.renderOnce();

    expect(records.stream[0]?.sessionId).toBeUndefined();
    expect(records.stream[0]?.threadId).toBeUndefined();
  } finally {
    app.renderer.destroy();
  }
});

test("resume session without a thread blocks submit without creating a new session", async () => {
  const records = chatClientRecords();
  const client = fakeChatClient(records);
  const app = await mountChatApp(client, {
    sessionId: "session_resume_missing_thread" as SessionId,
  });

  try {
    await Bun.sleep(80);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Session resume needs a thread");

    await typeText(app, "continue");
    await press(app, () => app.mockInput.pressEnter());

    expect(records.create).toHaveLength(0);
    expect(records.submit).toHaveLength(0);
  } finally {
    app.renderer.destroy();
  }
});

test("default chat ignores streamed history and starts a new session", async () => {
  const records = chatClientRecords();
  const sessionId = "session_streamed" as SessionId;
  const threadId = "thread_streamed" as ThreadId;
  const messageId = "msg_streamed" as MessageId;
  const partId = "part_streamed" as PartId;
  const client = fakeChatClient(records, [
    {
      id: "event_streamed_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, cwd: "/repo/chili" },
    },
    {
      id: "event_streamed_message",
      type: "message.created",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
      payload: { messageId, role: "assistant" },
    },
    {
      id: "event_streamed_part",
      type: "message.part_added",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: {
        messageId,
        part: { id: partId, messageId, sessionId, type: "text", text: "old streamed answer" },
      },
    },
  ]);
  const app = await mountChatApp(client);

  try {
    await Bun.sleep(80);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Ask anything");
    expect(app.captureCharFrame()).not.toContain("old streamed answer");

    await typeText(app, "start fresh");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    expect(records.create).toHaveLength(1);
    expect(records.submit[0]).toMatchObject({
      sessionId: "session_created",
      threadId: "thread_created",
      text: "start fresh",
    });
  } finally {
    app.renderer.destroy();
  }
});

test("/new starts a fresh runtime session for following prompts", async () => {
  const records = chatClientRecords();
  const client = fakeChatClient(records);
  const app = await mountChatApp(client);

  try {
    await typeText(app, "first session");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    expect(records.create).toHaveLength(1);
    expect(records.submit[0]).toMatchObject({
      sessionId: "session_created",
      threadId: "thread_created",
      text: "first session",
    });

    await typeText(app, "/new");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    expect(records.create).toHaveLength(2);

    await typeText(app, "second session");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    expect(records.submit[1]).toMatchObject({
      sessionId: "session_created_2",
      threadId: "thread_created_2",
      text: "second session",
    });
  } finally {
    app.renderer.destroy();
  }
});

test("running session blocks a second prompt submit", async () => {
  const submitted: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      canSubmit: false,
      chatView: {
        status: "running",
        items: [],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      submitPrompt: async (text) => {
        submitted.push(text);
        return true;
      },
    },
  });

  try {
    await typeText(app, "another prompt");
    await press(app, () => app.mockInput.pressEnter());

    expect(submitted).toHaveLength(0);
    expect(app.captureCharFrame()).toContain("Ctrl+X to interrupt");
  } finally {
    app.renderer.destroy();
  }
});

test("Escape restores an output-free interrupted prompt for editing", async () => {
  const submitted: string[] = [];
  let resolveFirstSubmit: ((accepted: boolean) => void) | undefined;
  let interrupted = 0;
  const app = await mountStatefulShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async (text) => {
        submitted.push(text);
        if (submitted.length === 1) {
          return new Promise<boolean>((resolve) => {
            resolveFirstSubmit = resolve;
          });
        }
        return true;
      },
      interruptActiveSession: async () => {
        interrupted += 1;
      },
    },
  });

  try {
    await typeText(app, "hi");
    await press(app, () => app.mockInput.pressEnter());
    expect(submitted).toEqual(["hi"]);

    await act(async () => {
      app.setRuntime((current) => ({
        ...current,
        canSubmit: false,
        chatView: {
          ...current.chatView,
          status: "running",
          items: [chatTextMessage("msg_interrupt_user", "user", "hi", 1)],
        },
      }));
    });
    await app.renderOnce();

    await press(app, () => app.mockInput.pressEscape());
    expect(interrupted).toBe(1);

    await act(async () => {
      app.setRuntime((current) => ({
        ...current,
        canSubmit: true,
        chatView: {
          ...current.chatView,
          status: "cancelled",
          items: [],
        },
      }));
    });
    await Bun.sleep(60);
    await app.renderOnce();

    const restoredFrame = app.captureCharFrame();
    expect(restoredFrame).toContain("hi");
    expect(restoredFrame).not.toContain(CONVERSATION_INTERRUPTED_NOTICE);

    resolveFirstSubmit?.(true);
    await Bun.sleep(60);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("hi");

    await typeText(app, " there");
    await press(app, () => app.mockInput.pressEnter());
    expect(submitted).toEqual(["hi", "hi there"]);
  } finally {
    app.renderer.destroy();
  }
});

test("Escape keeps visible output and adds a persistent red interruption notice", async () => {
  let interrupted = 0;
  const interruptedItems = [
    chatTextMessage("msg_interrupt_visible_user", "user", "explain", 1),
    chatTextMessage("msg_interrupt_visible_assistant", "assistant", "partial answer", 2),
  ];
  const app = await mountStatefulShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async () => true,
      interruptActiveSession: async () => {
        interrupted += 1;
      },
    },
  });

  try {
    await typeText(app, "explain");
    await press(app, () => app.mockInput.pressEnter());

    await act(async () => {
      app.setRuntime((current) => ({
        ...current,
        canSubmit: false,
        chatView: {
          ...current.chatView,
          status: "running",
          items: interruptedItems,
        },
      }));
    });
    await app.renderOnce();

    await press(app, () => app.mockInput.pressEscape());
    expect(interrupted).toBe(1);

    await act(async () => {
      app.setRuntime((current) => ({
        ...current,
        canSubmit: true,
        chatView: {
          ...current.chatView,
          status: "cancelled",
          items: interruptedItems,
        },
      }));
    });
    await Bun.sleep(60);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(frame).toContain("partial answer");
    expect(frame).toContain(CONVERSATION_INTERRUPTED_NOTICE);
    expect(frame).not.toContain(`error: ${CONVERSATION_INTERRUPTED_NOTICE}`);
    expect(frame.match(/explain/g)).toHaveLength(1);
    const noticePosition = frameTextPosition(frame, CONVERSATION_INTERRUPTED_NOTICE);
    expect(foregroundMatches(app, noticePosition.x, noticePosition.y, chiliDarkTheme.colors.status.error)).toBe(true);
  } finally {
    app.renderer.destroy();
  }
});

test("/clear clears local TUI notices and resets prompt history", async () => {
  const submitted: string[] = [];
  let started = 0;
  const clipboard = fakeClipboard({
    readText: async () => "",
  });
  const app = await mountShell(teamLiveFixture(), {
    clipboard,
    runtime: {
      submitPrompt: async (text) => {
        submitted.push(text);
        return true;
      },
      startNewSession: async () => {
        started += 1;
      },
    },
  });

  try {
    await typeText(app, "remembered prompt");
    await press(app, () => app.mockInput.pressEnter());
    expect(submitted).toEqual(["remembered prompt"]);

    await press(app, () => app.mockInput.pressKey("v", { ctrl: true }));
    expect(app.captureCharFrame()).toContain("Clipboard is empty.");

    await typeText(app, "/clear");
    await press(app, () => app.mockInput.pressEnter());

    expect(started).toBe(1);
    expect(app.captureCharFrame()).not.toContain("Clipboard is empty.");

    await press(app, () => app.mockInput.pressArrow("up"));
    expect(app.captureCharFrame()).not.toContain("remembered prompt");
  } finally {
    app.renderer.destroy();
  }
});

test("prompt history navigates successful ordinary prompts with Up and Down", async () => {
  const submitted: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async (text) => {
        submitted.push(text);
        return true;
      },
    },
  });

  try {
    await typeText(app, "first prompt");
    await press(app, () => app.mockInput.pressEnter());
    await typeText(app, "second prompt");
    await press(app, () => app.mockInput.pressEnter());

    expect(submitted).toEqual(["first prompt", "second prompt"]);

    await press(app, () => app.mockInput.pressArrow("up"));
    expect(app.captureCharFrame()).toContain("second prompt");

    await press(app, () => app.mockInput.pressArrow("up"));
    expect(app.captureCharFrame()).toContain("first prompt");

    await press(app, () => app.mockInput.pressArrow("down"));
    expect(app.captureCharFrame()).toContain("second prompt");
  } finally {
    app.renderer.destroy();
  }
});

test("prompt history restores the in-progress draft at the bottom", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "stored prompt");
    await press(app, () => app.mockInput.pressEnter());
    await typeText(app, "current draft");

    await press(app, () => app.mockInput.pressArrow("up"));
    expect(app.captureCharFrame()).toContain("stored prompt");

    await press(app, () => app.mockInput.pressArrow("down"));
    expect(app.captureCharFrame()).toContain("current draft");
  } finally {
    app.renderer.destroy();
  }
});

test("slash completion selection uses Up and Down without switching prompt history", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "history prompt");
    await press(app, () => app.mockInput.pressEnter());
    await typeText(app, "/");

    expect(app.captureCharFrame()).toContain("> /team - Open the team cockpit");

    await press(app, () => app.mockInput.pressArrow("down"));
    expect(app.captureCharFrame()).toContain("> /team run - Start the selected team loop");
    expect(app.captureCharFrame()).not.toContain("history prompt");

    await press(app, () => app.mockInput.pressArrow("up"));
    expect(app.captureCharFrame()).toContain("> /team - Open the team cockpit");
  } finally {
    app.renderer.destroy();
  }
});

test("slash completion Up wraps from the first item to the last item", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "/");

    await press(app, () => app.mockInput.pressArrow("up"));
    expect(app.captureCharFrame()).toContain("> /skills disable [--user|--project] <name> - Disable a skill");
  } finally {
    app.renderer.destroy();
  }
});

test("Enter executes the selected slash completion without Tab", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountShell(withRunLoopReady(teamLiveFixture()), { executed });

  try {
    await typeText(app, "/");
    await press(app, () => app.mockInput.pressArrow("down"));
    await press(app, () => app.mockInput.pressEnter());

    expect(executed).toEqual([expect.objectContaining({ type: "run_loop" })]);
    expect(app.captureCharFrame()).not.toContain("Unknown command");
  } finally {
    app.renderer.destroy();
  }
});

test("slash completion keeps the input visible in a short frame", async () => {
  const app = await mountShell(teamLiveFixture(), {
    width: 72,
    height: 12,
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "/");
    const frame = app.captureCharFrame();

    expect(frame).toContain("Commands");
    expect(frame).toContain("/team");
    expect(frame).toContain("> /");
  } finally {
    app.renderer.destroy();
  }
});

test("Tab accepts slash completion without leaving the completion list open", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "/");
    expect(app.captureCharFrame()).toContain("Open the team cockpit");

    await press(app, () => app.mockInput.pressTab());
    const frame = app.captureCharFrame();

    expect(frame).toContain("/team ");
    expect(frame).not.toContain("Open the team cockpit");
    expect(frame).not.toContain("Start the selected team loop");
  } finally {
    app.renderer.destroy();
  }
});

test("Tab accepts the strongest slash completion for a typed prefix", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "/mo");
    expect(app.captureCharFrame()).toContain("> /model [provider/model] - Select model");

    await press(app, () => app.mockInput.pressTab());
    const frame = app.captureCharFrame();

    expect(frame).toContain("/model ");
    expect(frame).not.toContain("/commands reload ");
  } finally {
    app.renderer.destroy();
  }
});

test("/mcp opens the MCP manager without writing status into the transcript", async () => {
  const calls: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      refreshMcpStatus: async () => {
        calls.push("status");
        return {
          summary: { total: 0, running: 0, disabled: 0, authRequired: 0, errored: 0 },
          servers: [],
        };
      },
    },
  });

  try {
    await typeText(app, "/mcp");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(calls).toEqual(["status"]);
    expect(frame).toContain("Manage MCP servers");
    expect(frame).toContain("No MCP servers configured.");
    expect(frame).toContain("Up/Down navigate");
    expect(frame).not.toContain("MCP servers:");
  } finally {
    app.renderer.destroy();
  }
});

test("/mcp manager opens server tools with keyboard navigation", async () => {
  const toolCalls: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      refreshMcpStatus: async () => ({
        summary: { total: 1, running: 1, disabled: 0, authRequired: 0, errored: 0 },
        servers: [
          {
            name: "MiniMax",
            status: "running",
            enabled: true,
            transport: "stdio",
            command: "uvx",
            args: ["minimax-coding-plan-mcp", "-y"],
            toolCount: 2,
            auth: { required: false },
          },
        ],
      }),
      listMcpTools: async (server) => {
        toolCalls.push(server);
        return {
          server,
          tools: [
            { name: "web_search", description: "Search the web" },
            { name: "understand_image", description: "Analyze an image" },
          ],
        };
      },
    },
  });

  try {
    await typeText(app, "/mcp");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("> MiniMax");

    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("MiniMax MCP Server");
    expect(app.captureCharFrame()).toContain("> View tools");

    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(toolCalls).toEqual(["MiniMax"]);
    expect(frame).toContain("Tools for MiniMax");
    expect(frame).toContain("web_search");
    expect(frame).toContain("understand_image");

    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("Tool name: web_search");

    await press(app, () => app.mockInput.pressEscape());
    expect(app.captureCharFrame()).toContain("Tools for MiniMax");
  } finally {
    app.renderer.destroy();
  }
});

test("/mcp manager offers tools when tool count is unknown", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      refreshMcpStatus: async () => ({
        summary: { total: 1, running: 1, disabled: 0, authRequired: 0, errored: 0 },
        servers: [
          {
            name: "unknown-tools",
            status: "running",
            enabled: true,
            transport: "http",
            url: "https://mcp.example.test",
            auth: { required: false },
          },
        ],
      }),
      listMcpTools: async (server) => ({ server, tools: [] }),
    },
  });

  try {
    await typeText(app, "/mcp");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    await press(app, () => app.mockInput.pressEnter());
    const frame = app.captureCharFrame();
    expect(frame).toContain("Unknown-tools MCP Server");
    expect(frame).toContain("> View tools - Fetch discovered tools");
  } finally {
    app.renderer.destroy();
  }
});

test("/mcp status renders runtime MCP server state", async () => {
  const calls: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      refreshMcpStatus: async () => {
        calls.push("status");
        return {
          summary: { total: 1, running: 1, disabled: 0, authRequired: 0, errored: 0 },
          servers: [
            {
              name: "github",
              status: "running",
              enabled: true,
              transport: "http",
              url: "https://mcp.example.test",
              toolCount: 2,
              auth: { required: false },
            },
          ],
        };
      },
    },
  });

  try {
    await typeText(app, "/mcp status");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(calls).toEqual(["status"]);
    expect(frame).toContain("MCP servers: total=1 running=1");
    expect(frame).toContain("github");
    expect(frame).toContain("https://mcp.example.test");
  } finally {
    app.renderer.destroy();
  }
});

test("/mcp tools lists MCP tools without submitting a prompt", async () => {
  const submissions: string[] = [];
  const toolCalls: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async (text) => {
        submissions.push(text);
        return true;
      },
      listMcpTools: async (server) => {
        toolCalls.push(server);
        return {
          server,
          tools: [
            { name: "search_issues", description: "Search issue titles and descriptions" },
            { name: "create_issue" },
          ],
        };
      },
    },
  });

  try {
    await typeText(app, "/mcp tools github");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(submissions).toEqual([]);
    expect(toolCalls).toEqual(["github"]);
    expect(frame).toContain("MCP tools for github: 2");
    expect(frame).toContain("search_issues");
    expect(frame).toContain("create_issue");
  } finally {
    app.renderer.destroy();
  }
});

test("/mcp reload refreshes MCP config and prompt commands", async () => {
  const calls: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      reloadMcp: async () => {
        calls.push("mcp");
        return {
          reloaded: true,
          servers: [],
          errors: [{ server: "bad", message: "config failed" }],
        };
      },
      reloadCommands: async () => {
        calls.push("commands");
        return { commands: [], diagnostics: [], directories: [], skippedConflicts: [] };
      },
    },
  });

  try {
    await typeText(app, "/mcp reload");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(calls).toEqual(["mcp", "commands"]);
    expect(frame).toContain("MCP reloaded: yes servers=0 errors=1");
    expect(frame).toContain("error bad: config failed");
    expect(frame).toContain("Prompt commands refreshed.");
  } finally {
    app.renderer.destroy();
  }
});

test("$ opens a skill picker and Tab inserts a path-bound skill mention", async () => {
  const submissions: Array<{ text: string; skillMentions?: unknown }> = [];
  const app = await mountShell(teamLiveFixture(), {
    skills: [skillSummary("reviewer"), skillSummary("react-component")],
    runtime: {
      submitPrompt: async (text, options) => {
        submissions.push({ text, skillMentions: options?.skillMentions });
        return true;
      },
    },
  });

  try {
    await typeText(app, "$rev");
    expect(app.captureCharFrame()).toContain("Skills");
    expect(app.captureCharFrame()).toContain("> $reviewer");

    await press(app, () => app.mockInput.pressTab());
    expect(app.captureCharFrame()).toContain("$reviewer ");
    expect(app.captureCharFrame()).not.toContain("Skills");

    await typeText(app, "please review");
    await press(app, () => app.mockInput.pressEnter());
    expect(submissions).toEqual([
      {
        text: "$reviewer please review",
        skillMentions: [{ name: "reviewer", path: "/repo/.chili/skills/reviewer/SKILL.md" }],
      },
    ]);
  } finally {
    app.renderer.destroy();
  }
});

test("$ skill picker distinguishes duplicate names with source and path hints", async () => {
  const app = await mountShell(teamLiveFixture(), {
    width: 160,
    skills: [
      skillSummary("same", { source: "user", baseDir: "/home/.chili/skills/same" }),
      skillSummary("same", { source: "project", baseDir: "/repo/.chili/skills/same" }),
    ],
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "$same");
    const frame = app.captureCharFrame();
    expect(frame).toContain("> $same - user /home/.chili/skills/same");
    expect(frame).toContain("  $same - project /repo/.chili/skills/same");
  } finally {
    app.renderer.destroy();
  }
});

test("duplicate skill picker keeps only the latest path binding by name", async () => {
  const submissions: Array<{ text: string; skillMentions?: unknown }> = [];
  const userSkill = skillSummary("same", { source: "user", baseDir: "/home/.chili/skills/same" });
  const projectSkill = skillSummary("same", { source: "project", baseDir: "/repo/.chili/skills/same" });
  const app = await mountShell(teamLiveFixture(), {
    skills: [userSkill, projectSkill],
    runtime: {
      submitPrompt: async (text, options) => {
        submissions.push({ text, skillMentions: options?.skillMentions });
        return true;
      },
    },
  });

  try {
    await typeText(app, "$same");
    await press(app, () => app.mockInput.pressTab());
    await typeText(app, "and $same");
    await press(app, () => app.mockInput.pressArrow("down"));
    await press(app, () => app.mockInput.pressTab());
    await typeText(app, "please");
    await press(app, () => app.mockInput.pressEnter());

    expect(submissions).toEqual([
      {
        text: "$same and $same please",
        skillMentions: [{ name: "same", path: projectSkill.filePath }],
      },
    ]);
  } finally {
    app.renderer.destroy();
  }
});

test("manual unknown skill mention warns locally and still submits", async () => {
  const submissions: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    skills: [skillSummary("reviewer")],
    runtime: {
      submitPrompt: async (text) => {
        submissions.push(text);
        return true;
      },
    },
  });

  try {
    await typeText(app, "$unknown please");
    await press(app, () => app.mockInput.pressEnter());

    expect(submissions).toEqual(["$unknown please"]);
    expect(app.captureCharFrame()).toContain("Skill $unknown was not found; it will not be injected.");
  } finally {
    app.renderer.destroy();
  }
});

test("manual ambiguous skill mention warns locally without picker binding", async () => {
  const submissions: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    skills: [
      skillSummary("same", { source: "user", baseDir: "/home/.chili/skills/same" }),
      skillSummary("same", { source: "project", baseDir: "/repo/.chili/skills/same" }),
    ],
    runtime: {
      submitPrompt: async (text) => {
        submissions.push(text);
        return true;
      },
    },
  });

  try {
    await typeText(app, "$same please");
    await press(app, () => app.mockInput.pressEnter());

    expect(submissions).toEqual(["$same please"]);
    expect(app.captureCharFrame()).toContain("Skill $same is ambiguous; select it from /skills so Chili can bind the exact SKILL.md.");
  } finally {
    app.renderer.destroy();
  }
});

test("deleted skill mention bindings are not submitted", async () => {
  const submissions: Array<{ text: string; skillMentions?: unknown }> = [];
  const app = await mountShell(teamLiveFixture(), {
    skills: [skillSummary("reviewer")],
    runtime: {
      submitPrompt: async (text, options) => {
        submissions.push({ text, skillMentions: options?.skillMentions });
        return true;
      },
    },
  });

  try {
    await typeText(app, "$rev");
    await press(app, () => app.mockInput.pressTab());
    await typeText(app, "plain prompt");
    await backspace(app, "$reviewer plain prompt".length);
    await typeText(app, "plain prompt");
    await press(app, () => app.mockInput.pressEnter());

    expect(submissions[0]).toEqual({ text: "plain prompt", skillMentions: undefined });
  } finally {
    app.renderer.destroy();
  }
});

test("/skills inserts $ and opens the skill picker", async () => {
  const app = await mountShell(teamLiveFixture(), {
    skills: [skillSummary("reviewer")],
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "/skills");
    await press(app, () => app.mockInput.pressEnter());

    const frame = app.captureCharFrame();
    expect(frame).toContain("> $");
    expect(frame).toContain("Skills");
    expect(frame).toContain("$reviewer");
  } finally {
    app.renderer.destroy();
  }
});

test("/thinking hide and show toggle reasoning visibility", async () => {
  const callId = "call_reasoning_toggle" as ToolCallId;
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      chatView: {
        status: "idle",
        items: [
          {
            id: "msg_reasoning_toggle" as MessageId,
            kind: "message",
            role: "assistant",
            createdAt: 1,
            parts: [
              { type: "reasoning", id: "part_reasoning_toggle" as PartId, text: "checking private chain" },
              {
                type: "text",
                id: "part_intermediate_toggle" as PartId,
                text: "Let me inspect private chain.",
                phase: "commentary",
              },
              {
                type: "tool_call",
                id: "part_call_toggle" as PartId,
                callId,
                toolName: "read",
                status: "completed",
                input: { file: "private.ts" },
                displayStatus: "succeeded",
              },
            ],
          },
          {
            id: "msg_answer_toggle" as MessageId,
            kind: "message",
            role: "assistant",
            createdAt: 2,
            parts: [
              { type: "text", id: "part_answer_toggle" as PartId, text: "done", phase: "final_answer" },
            ],
          },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  });

  try {
    expect(app.captureCharFrame()).toContain("Thinking: checking private chain");
    expect(app.captureCharFrame()).toContain("Let me inspect private chain.");
    expect(app.captureCharFrame()).toContain("done");

    await typeText(app, "/thinking hide");
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("Thinking traces hidden.");
    expect(app.captureCharFrame()).toContain("🫧");
    expect(app.captureCharFrame()).not.toContain("Thinking: checking private chain");
    expect(app.captureCharFrame()).not.toContain("Let me inspect private chain.");
    expect(app.captureCharFrame()).toContain("done");

    await typeText(app, "/thinking show");
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("Thinking traces shown.");
    expect(app.captureCharFrame()).toContain("Thinking: checking private chain");
    expect(app.captureCharFrame()).toContain("Let me inspect private chain.");
  } finally {
    app.renderer.destroy();
  }
});

test("/hide-thinking and /show-thinking toggle reasoning visibility", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      chatView: {
        status: "idle",
        items: [
          {
            id: "msg_hide_thinking_command" as MessageId,
            kind: "message",
            role: "assistant",
            createdAt: 1,
            parts: [
              { type: "reasoning", id: "part_hide_thinking_reasoning" as PartId, text: "checking command visibility" },
              { type: "text", id: "part_hide_thinking_answer" as PartId, text: "done" },
            ],
          },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  });

  try {
    await typeText(app, "/hide-thinking");
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("Thinking traces hidden.");
    expect(app.captureCharFrame()).toContain("🫧");
    expect(app.captureCharFrame()).not.toContain("Thinking: checking command visibility");

    await typeText(app, "/show-thinking");
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("Thinking traces shown.");
    expect(app.captureCharFrame()).toContain("Thinking: checking command visibility");
  } finally {
    app.renderer.destroy();
  }
});

test("leading slash absolute paths submit as normal prompts", async () => {
  const submitted: string[] = [];
  const prompt = "/Users/pony/Code/opensource/ai/agent/clis/opencli go inspect this repo";
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async (text) => {
        submitted.push(text);
        return true;
      },
    },
  });

  try {
    await typeText(app, prompt);
    await press(app, () => app.mockInput.pressEnter());

    expect(submitted).toEqual([prompt]);
    expect(app.captureCharFrame()).not.toContain("Unknown command");
  } finally {
    app.renderer.destroy();
  }
});

test("command palette selection uses Up and Down without switching prompt history", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "palette history");
    await press(app, () => app.mockInput.pressEnter());
    await press(app, () => app.mockInput.pressKey("p", { ctrl: true }));

    expect(app.captureCharFrame()).toContain("Command Palette");
    expect(app.captureCharFrame()).toContain("> /team - Open the team cockpit");

    await press(app, () => app.mockInput.pressArrow("down"));
    expect(app.captureCharFrame()).toContain("> /team run - Start the selected team loop");
    expect(app.captureCharFrame()).not.toContain("palette history");
  } finally {
    app.renderer.destroy();
  }
});

test("command palette keeps the draft visible without entering prompt history", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "draft before palette");
    await press(app, () => app.mockInput.pressKey("p", { ctrl: true }));

    expect(app.captureCharFrame()).toContain("Command Palette");
    expect(app.captureCharFrame()).toContain("draft before palette");

    await press(app, () => app.mockInput.pressArrow("down"));
    const frame = app.captureCharFrame();
    expect(frame).toContain("draft before palette");
    expect(frame).toContain("> /team run - Start the selected team loop");
  } finally {
    app.renderer.destroy();
  }
});

test("Ctrl+V pastes clipboard text into the prompt", async () => {
  const submitted: string[] = [];
  const clipboard = fakeClipboard({
    readText: async () => "from\nclipboard",
  });
  const app = await mountShell(teamLiveFixture(), {
    clipboard,
    runtime: {
      submitPrompt: async (text) => {
        submitted.push(text);
        return true;
      },
    },
  });

  try {
    await press(app, () => app.mockInput.pressKey("v", { ctrl: true }));
    const frame = app.captureCharFrame();
    expect(frame).toContain("from");
    expect(frame).toContain("clipboard");

    await press(app, () => app.mockInput.pressEnter());
    expect(submitted).toEqual(["from\nclipboard"]);
  } finally {
    app.renderer.destroy();
  }
});

test("Ctrl+V ignores decorative-only clipboard text", async () => {
  const clipboard = fakeClipboard({
    readText: async () => "▝              ",
  });
  const app = await mountShell(teamLiveFixture(), { clipboard });

  try {
    await press(app, () => app.mockInput.pressKey("v", { ctrl: true }));

    expect(app.captureCharFrame()).toContain("Clipboard is empty.");
    expect(app.captureCharFrame()).not.toContain("▝");
  } finally {
    app.renderer.destroy();
  }
});

test("Ctrl+V saves clipboard images and submits them as prompt attachments", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-tui-paste-image-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwOKGAAAAABJRU5ErkJggg==", "base64");
  const submitted: Array<{ text: string; options: Parameters<ChatRuntimeState["submitPrompt"]>[1] }> = [];
  const clipboard = fakeClipboard({
    readImage: async () => ({ bytes: png, mimeType: "image/png", extension: "png" }),
    readText: async () => {
      throw new Error("text clipboard should not be read when an image is present");
    },
  });
  const app = await mountShell(teamLiveFixture(), {
    cwd,
    clipboard,
    runtime: {
      submitPrompt: async (text, options) => {
        submitted.push({ text, options });
        return true;
      },
    },
  });

  try {
    await press(app, () => app.mockInput.pressKey("v", { ctrl: true }));
    expect(app.captureCharFrame()).toContain("Pasted image [Image #1]:");
    expect(app.captureCharFrame()).toContain("[Image #1]");
    expect(app.captureCharFrame()).toContain(".chili/clipboard-images/");

    await press(app, () => app.mockInput.pressEnter());
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.text).toBe("[Image #1]");
    expect(submitted[0]?.options?.images).toHaveLength(1);
    expect(submitted[0]?.options?.images?.[0]).toMatchObject({ mimeType: "image/png" });
    expect(Buffer.from(submitted[0]?.options?.images?.[0]?.data ?? "", "base64")).toEqual(png);
    const pathMatch = /\.chili\/clipboard-images\/clipboard-[^\s]+\.png/.exec(submitted[0]?.options?.images?.[0]?.sourcePath ?? "");
    expect(pathMatch?.[0]).toBeDefined();
    expect(await readFile(path.join(cwd, pathMatch?.[0] ?? ""))).toEqual(png);
  } finally {
    app.renderer.destroy();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Ctrl+V keeps image placeholders and submits tool-readable paths for known text-only models", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-tui-paste-image-text-only-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwOKGAAAAABJRU5ErkJggg==", "base64");
  const submitted: Array<{ text: string; options: Parameters<ChatRuntimeState["submitPrompt"]>[1] }> = [];
  const textOnlyModel = { provider: "faux", model: "text-only", inputCapabilities: ["text"] };
  const clipboard = fakeClipboard({
    readImage: async () => ({ bytes: png, mimeType: "image/png", extension: "png" }),
  });
  const app = await mountShell(teamLiveFixture(), {
    cwd,
    clipboard,
    runtime: {
      modelCandidates: [textOnlyModel],
      modelConfig: {
        sessionId: "session_text_only" as SessionId,
        models: [textOnlyModel],
        availableReasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
        modelSelection: { provider: textOnlyModel.provider, model: textOnlyModel.model },
      },
      submitPrompt: async (text, options) => {
        submitted.push({ text, options });
        return true;
      },
    },
  });

  try {
    await Bun.sleep(20);
    await app.renderOnce();
    await press(app, () => app.mockInput.pressKey("v", { ctrl: true }));
    const frame = app.captureCharFrame();
    expect(frame).toContain("Pasted image [Image #1]:");
    expect(frame).toContain(".chili/clipboard-images/");
    expect(frame).toContain("[Image #1]");

    await press(app, () => app.mockInput.pressEnter());
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.text).toContain("[Image #1]");
    expect(submitted[0]?.text).toContain("<pasted_image_files>");
    expect(submitted[0]?.text).toContain("path=.chili/clipboard-images/");
    expect(submitted[0]?.text).toContain("MCP image-understanding or OCR tool");
    expect(submitted[0]?.text).toContain("absolutePath=");
    expect(submitted[0]?.options?.displayText).toBe("[Image #1]");
    expect(submitted[0]?.options?.images).toBeUndefined();
    const pathMatch = /\.chili\/clipboard-images\/clipboard-[^\s]+\.png/.exec(submitted[0]?.text ?? "");
    expect(pathMatch?.[0]).toBeDefined();
    expect(await readFile(path.join(cwd, pathMatch?.[0] ?? ""))).toEqual(png);
  } finally {
    app.renderer.destroy();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal bracketed paste inserts text into the prompt", async () => {
  const submitted: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async (text) => {
        submitted.push(text);
        return true;
      },
    },
  });

  try {
    await act(async () => {
      await app.mockInput.pasteBracketedText("terminal\npaste");
    });
    await Bun.sleep(60);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(frame).toContain("terminal");
    expect(frame).toContain("paste");

    await press(app, () => app.mockInput.pressEnter());
    expect(submitted).toEqual(["terminal\npaste"]);
  } finally {
    app.renderer.destroy();
  }
});

test("large multiline paste uses a prompt placeholder but submits and displays the original text", async () => {
  const pasted = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const submitted: Array<{ text: string; options: Parameters<ChatRuntimeState["submitPrompt"]>[1] }> = [];
  const clipboard = fakeClipboard({
    readText: async () => pasted,
  });
  const app = await mountShell(teamLiveFixture(), {
    clipboard,
    runtime: {
      submitPrompt: async (text, options) => {
        submitted.push({ text, options });
        return true;
      },
    },
  });

  try {
    await press(app, () => app.mockInput.pressKey("v", { ctrl: true }));

    const frame = app.captureCharFrame();
    expect(frame).toContain("[Pasted ~12 lines]");
    expect(frame).not.toContain("line 12");

    await typeText(app, "评价一下");
    await press(app, () => app.mockInput.pressEnter());
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.text).toBe(`${pasted}评价一下`);
    expect(submitted[0]?.options?.displayText).toBeUndefined();
  } finally {
    app.renderer.destroy();
  }
});

test("Ctrl+J inserts a newline in the prompt", async () => {
  const submitted: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async (text) => {
        submitted.push(text);
        return true;
      },
    },
  });

  try {
    await typeText(app, "first");
    await press(app, () => app.mockInput.pressKey("j", { ctrl: true }));
    await typeText(app, "second");
    await press(app, () => app.mockInput.pressEnter());

    expect(submitted).toEqual(["first\nsecond"]);
  } finally {
    app.renderer.destroy();
  }
});

test("Ctrl+V pastes without scrolling the transcript down", async () => {
  const clipboard = fakeClipboard({
    readText: async () => "clip",
  });
  const app = await mountShell(teamLiveFixture(), {
    width: 120,
    height: 24,
    clipboard,
    runtime: {
      chatView: {
        status: "idle",
        items: chatMessages(30),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      submitPrompt: async () => true,
    },
  });

  try {
    for (let index = 0; index < 4; index += 1) {
      await press(app, () => app.mockInput.pressKey("y", { ctrl: true }));
    }
    expect(app.captureCharFrame()).toContain("message 01");

    await press(app, () => app.mockInput.pressKey("v", { ctrl: true }));
    const frame = app.captureCharFrame();
    expect(frame).toContain("message 01");
    expect(frame).not.toContain("message 30");
    expect(frame).toContain("clip");
  } finally {
    app.renderer.destroy();
  }
});

test("Ctrl+Shift+C copies the latest assistant reply when nothing is selected", async () => {
  const copied: string[] = [];
  const clipboard = fakeClipboard({
    writeText: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const app = await mountShell(teamLiveFixture(), {
    clipboard,
    kittyKeyboard: true,
    runtime: {
      chatView: {
        status: "idle",
        items: [
          {
            id: "msg_copy" as MessageId,
            kind: "message",
            role: "assistant",
            createdAt: 1,
            parts: [
              { type: "text", id: "part_copy" as PartId, text: "copy this reply" },
            ],
          },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      submitPrompt: async () => true,
    },
  });

  try {
    await press(app, () => app.mockInput.pressKey("c", { ctrl: true, shift: true }));

    expect(copied).toEqual(["copy this reply"]);
    expect(app.captureCharFrame()).toContain("Copied latest assistant reply.");
  } finally {
    app.renderer.destroy();
  }
});

test("local copy notices expire", async () => {
  const copied: string[] = [];
  const clipboard = fakeClipboard({
    writeText: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const app = await mountShell(teamLiveFixture(), {
    clipboard,
    kittyKeyboard: true,
    localMessageTtlMs: 120,
    runtime: {
      chatView: {
        status: "idle",
        items: transcriptCopyItems(),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      submitPrompt: async () => true,
    },
  });

  try {
    await press(app, () => app.mockInput.pressKey("c", { ctrl: true, shift: true }));
    expect(copied).toEqual(["copy transcript reply"]);
    expect(app.captureCharFrame()).toContain("Copied latest assistant reply.");

    await Bun.sleep(180);
    await app.renderOnce();

    expect(app.captureCharFrame()).not.toContain("Copied latest assistant reply.");
  } finally {
    app.renderer.destroy();
  }
});

test("Ctrl+Shift+C copies the transcript when transcript view is active", async () => {
  const copied: string[] = [];
  const clipboard = fakeClipboard({
    writeText: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const app = await mountShell(teamLiveFixture(), {
    clipboard,
    kittyKeyboard: true,
    runtime: {
      chatView: {
        status: "idle",
        items: transcriptCopyItems(),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      submitPrompt: async () => true,
    },
  });

  try {
    await press(app, () => app.mockInput.pressKey("t", { ctrl: true }));
    await press(app, () => app.mockInput.pressKey("c", { ctrl: true, shift: true }));

    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("message assistant msg_copy_transcript");
    expect(copied[0]).toContain("tool bash succeeded tool_copy_transcript");
    expect(copied[0]).toContain("RAW_COPY_OUTPUT");
    expect(app.captureCharFrame()).toContain("Copied transcript.");
  } finally {
    app.renderer.destroy();
  }
});

test("local notices clear when the active session changes", async () => {
  const clipboard = fakeClipboard({
    readText: async () => "",
  });
  const app = await mountStatefulShell(teamLiveFixture(), {
    clipboard,
  });

  try {
    await press(app, () => app.mockInput.pressKey("v", { ctrl: true }));
    expect(app.captureCharFrame()).toContain("Clipboard is empty.");

    await act(async () => {
      app.setRuntime((current) => ({
        ...current,
        activeSessionId: "session_next" as SessionId,
        activeThreadId: "thread_next" as ThreadId,
      }));
    });
    await app.renderOnce();

    expect(app.captureCharFrame()).not.toContain("Clipboard is empty.");
  } finally {
    app.renderer.destroy();
  }
});

test("finished terminal selection is copied to the clipboard", async () => {
  const copied: string[] = [];
  const clipboard = fakeClipboard({
    writeText: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const app = await mountShell(teamLiveFixture(), { clipboard });

  try {
    emitSelection(app.renderer, "selected text   \n");
    await Bun.sleep(60);

    expect(copied).toEqual(["selected text"]);
  } finally {
    app.renderer.destroy();
  }
});

test("decorative-only terminal selection is not copied", async () => {
  const copied: string[] = [];
  const clipboard = fakeClipboard({
    writeText: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const app = await mountShell(teamLiveFixture(), { clipboard });

  try {
    emitSelection(app.renderer, "▝              ");
    await Bun.sleep(60);

    expect(copied).toEqual([]);
  } finally {
    app.renderer.destroy();
  }
});

test("left double click selects a transcript word", async () => {
  const copied: string[] = [];
  const clipboard = fakeClipboard({
    writeText: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const app = await mountShell(teamLiveFixture(), {
    width: 90,
    height: 18,
    useMouse: true,
    clipboard,
    runtime: {
      chatView: {
        status: "idle",
        items: [requireFirst(chatMessages(1))],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  });

  try {
    const target = frameTextPosition(app.captureCharFrame(), "message");
    await act(async () => {
      await app.mockMouse.doubleClick(target.x + 2, target.y);
      await Bun.sleep(80);
      await app.renderOnce();
    });

    expect(app.renderer.getSelection()?.getSelectedText()).toBe("message");
    expect(copied.at(-1)).toBe("message");
  } finally {
    app.renderer.destroy();
  }
});

test("left double click selects an assistant markdown path token", async () => {
  const copied: string[] = [];
  const clipboard = fakeClipboard({
    writeText: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const pathToken = "/repo/chili/apps/tui/src/lines.tsx:42";
  const app = await mountShell(teamLiveFixture(), {
    width: 100,
    height: 18,
    useMouse: true,
    clipboard,
    runtime: {
      chatView: {
        status: "idle",
        items: [
          {
            id: "msg_assistant_double_click" as MessageId,
            kind: "message",
            role: "assistant",
            createdAt: 1,
            parts: [
              { type: "text", id: "part_assistant_double_click" as PartId, text: `Open ${pathToken} now` },
            ],
          },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  });

  try {
    const target = frameTextPosition(app.captureCharFrame(), pathToken);
    await act(async () => {
      await app.mockMouse.doubleClick(target.x + 8, target.y);
      await Bun.sleep(80);
      await app.renderOnce();
    });

    expect(app.renderer.getSelection()?.getSelectedText()).toBe(pathToken);
    expect(copied.at(-1)).toBe(pathToken);
  } finally {
    app.renderer.destroy();
  }
});

test("left double click selects a concealed markdown word", async () => {
  const copied: string[] = [];
  const clipboard = fakeClipboard({
    writeText: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const word = "fantastic";
  const app = await mountShell(teamLiveFixture(), {
    width: 100,
    height: 18,
    useMouse: true,
    clipboard,
    runtime: {
      chatView: {
        status: "idle",
        items: [
          {
            id: "msg_assistant_bold_double_click" as MessageId,
            kind: "message",
            role: "assistant",
            createdAt: 1,
            parts: [
              { type: "text", id: "part_assistant_bold_double_click" as PartId, text: `This is **${word}** now` },
            ],
          },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  });

  try {
    const target = frameTextPosition(app.captureCharFrame(), word);
    await act(async () => {
      await app.mockMouse.doubleClick(target.x + 3, target.y);
      await Bun.sleep(80);
      await app.renderOnce();
    });

    expect(app.renderer.getSelection()?.getSelectedText()).toBe(word);
    expect(copied.at(-1)).toBe(word);
  } finally {
    app.renderer.destroy();
  }
});

test("left double click selects a wrapped assistant markdown word", async () => {
  const copied: string[] = [];
  const clipboard = fakeClipboard({
    writeText: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const word = "supercalifragilisticexpialidocious";
  const app = await mountShell(teamLiveFixture(), {
    width: 36,
    height: 18,
    useMouse: true,
    clipboard,
    runtime: {
      chatView: {
        status: "idle",
        items: [
          {
            id: "msg_assistant_wrapped_double_click" as MessageId,
            kind: "message",
            role: "assistant",
            createdAt: 1,
            parts: [
              {
                type: "text",
                id: "part_assistant_wrapped_double_click" as PartId,
                text: `Token ${word} done`,
                phase: "final_answer",
              },
            ],
          },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  });

  try {
    const target = frameTextPosition(app.captureCharFrame(), "fragilistic");
    await act(async () => {
      await app.mockMouse.doubleClick(target.x + 3, target.y);
      await Bun.sleep(80);
      await app.renderOnce();
    });

    expect(app.renderer.getSelection()?.getSelectedText()).toBe(word);
    expect(copied.at(-1)).toBe(word);
  } finally {
    app.renderer.destroy();
  }
});

test("left double click selects only a final assistant markdown word", async () => {
  const copied: string[] = [];
  const clipboard = fakeClipboard({
    writeText: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const sentence = "I told my wife she was drawing her eyebrows too high.";
  const app = await mountShell(teamLiveFixture(), {
    width: 100,
    height: 18,
    useMouse: true,
    clipboard,
    runtime: {
      chatView: {
        status: "idle",
        items: [
          {
            id: "msg_assistant_final_word_double_click" as MessageId,
            kind: "message",
            role: "assistant",
            createdAt: 1,
            parts: [
              {
                type: "text",
                id: "part_assistant_final_word_double_click" as PartId,
                text: `英文：\n${sentence}`,
                phase: "final_answer",
              },
            ],
          },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  });

  try {
    const frame = app.captureCharFrame();
    const lineStart = frameTextPosition(frame, "I told");
    const target = frameTextPosition(frame, "high");
    await act(async () => {
      await app.mockMouse.doubleClick(target.x + 2, target.y);
      await Bun.sleep(80);
      await app.renderOnce();
    });

    expect(selectionBgAt(app, target.x, target.y)).toBe(true);
    expect(selectionBgAt(app, target.x + "high".length, target.y)).toBe(false);
    expect(selectionBgAt(app, lineStart.x, lineStart.y)).toBe(false);
    expect(copied.at(-1)).toBe("high");
  } finally {
    app.renderer.destroy();
  }
});

test("left triple click selects an assistant markdown line", async () => {
  const copied: string[] = [];
  const clipboard = fakeClipboard({
    writeText: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const pathToken = "/repo/chili/apps/tui/src/lines.tsx:42";
  const lineText = `Open ${pathToken} now`;
  const app = await mountShell(teamLiveFixture(), {
    width: 100,
    height: 18,
    useMouse: true,
    clipboard,
    runtime: {
      chatView: {
        status: "idle",
        items: [
          {
            id: "msg_assistant_triple_click" as MessageId,
            kind: "message",
            role: "assistant",
            createdAt: 1,
            parts: [
              { type: "text", id: "part_assistant_triple_click" as PartId, text: lineText },
            ],
          },
        ],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  });

  try {
    const target = frameTextPosition(app.captureCharFrame(), pathToken);
    await act(async () => {
      await app.mockMouse.doubleClick(target.x + 8, target.y);
      await app.mockMouse.click(target.x + 8, target.y);
      await Bun.sleep(80);
      await app.renderOnce();
    });

    expect(app.renderer.getSelection()?.getSelectedText()).toBe(lineText);
    expect(copied.at(-1)).toBe(lineText);
  } finally {
    app.renderer.destroy();
  }
});

test("Shift+Up and Shift+Down scroll the transcript instead of prompt history", async () => {
  const app = await mountShell(teamLiveFixture(), {
    width: 120,
    height: 24,
    runtime: {
      chatView: {
        status: "idle",
        items: chatMessages(30),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "scroll history");
    await press(app, () => app.mockInput.pressEnter());

    expect(app.captureCharFrame()).toContain("message 30");
    expect(app.captureCharFrame()).not.toContain("message 01");

    for (let index = 0; index < 4; index += 1) {
      await press(app, () => app.mockInput.pressArrow("up", { shift: true }));
    }
    expect(app.captureCharFrame()).toContain("message 01");
    expect(app.captureCharFrame()).not.toContain("scroll history");

    for (let index = 0; index < 4; index += 1) {
      await press(app, () => app.mockInput.pressArrow("down", { shift: true }));
    }
    expect(app.captureCharFrame()).toContain("message 30");
    expect(app.captureCharFrame()).not.toContain("scroll history");
  } finally {
    app.renderer.destroy();
  }
});

test("chat scroll stays on history when new messages arrive above the bottom", async () => {
  const app = await mountStatefulShell(teamLiveFixture(), {
    width: 120,
    height: 24,
    runtime: {
      chatView: {
        status: "idle",
        items: chatMessages(30),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      submitPrompt: async () => true,
    },
  });

  try {
    for (let index = 0; index < 4; index += 1) {
      await press(app, () => app.mockInput.pressKey("y", { ctrl: true }));
    }
    expect(app.captureCharFrame()).toContain("message 01");
    expect(app.captureCharFrame()).not.toContain("message 30");

    await act(async () => {
      app.setRuntime((current) => ({
        ...current,
        chatView: {
          ...current.chatView,
          items: chatMessages(31),
          generatedAt: "1970-01-01T00:00:01.000Z",
        },
      }));
    });
    await Bun.sleep(60);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(frame).toContain("message 01");
    expect(frame).not.toContain("message 31");
  } finally {
    app.renderer.destroy();
  }
});

test("chat follows the bottom when new messages arrive at offset zero", async () => {
  const app = await mountStatefulShell(teamLiveFixture(), {
    width: 120,
    height: 24,
    runtime: {
      chatView: {
        status: "idle",
        items: chatMessages(2),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      submitPrompt: async () => true,
    },
  });

  try {
    expect(app.captureCharFrame()).toContain("message 02");

    await act(async () => {
      app.setRuntime((current) => ({
        ...current,
        chatView: {
          ...current.chatView,
          items: chatMessages(3),
          generatedAt: "1970-01-01T00:00:01.000Z",
        },
      }));
    });
    await Bun.sleep(60);
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("message 03");
  } finally {
    app.renderer.destroy();
  }
});

test("transcript scroll stays on history when raw output grows above the bottom", async () => {
  const app = await mountStatefulShell(teamLiveFixture(), {
    width: 120,
    height: 24,
    runtime: {
      chatView: {
        status: "idle",
        items: rawOutputToolItems(40),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      submitPrompt: async () => true,
    },
  });

  try {
    await press(app, () => app.mockInput.pressKey("t", { ctrl: true }));
    expect(app.captureCharFrame()).toContain("raw_line_40");

    await press(app, () => app.mockInput.pressKey("y", { ctrl: true }));
    await press(app, () => app.mockInput.pressKey("y", { ctrl: true }));
    await press(app, () => app.mockInput.pressKey("y", { ctrl: true }));
    expect(app.captureCharFrame()).toContain("raw_line_01");

    await act(async () => {
      app.setRuntime((current) => ({
        ...current,
        chatView: {
          ...current.chatView,
          items: rawOutputToolItems(45),
          generatedAt: "1970-01-01T00:00:01.000Z",
        },
      }));
    });
    await Bun.sleep(60);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(frame).toContain("raw_line_01");
    expect(frame).not.toContain("raw_line_45");
  } finally {
    app.renderer.destroy();
  }
});

test("running disabled composer does not switch to prompt history", async () => {
  const app = await mountStatefulShell(teamLiveFixture(), {
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "saved prompt");
    await press(app, () => app.mockInput.pressEnter());

    await act(async () => {
      app.setRuntime((current) => ({
        ...current,
        canSubmit: false,
        chatView: {
          ...current.chatView,
          status: "running",
        },
      }));
    });
    await app.renderOnce();

    await press(app, () => app.mockInput.pressArrow("up"));
    const frame = app.captureCharFrame();
    expect(frame).toContain("Ctrl+X to interrupt");
    expect(frame).not.toContain("saved prompt");
  } finally {
    app.renderer.destroy();
  }
});

test("pending approval renders the approval dock and shortcuts resolve it", async () => {
  const approved: Array<{ id: ApprovalId; scope: ChatApproveOptions["scope"] }> = [];
  const rejected: ApprovalId[] = [];
  const approvalId = "approval_chat_pending" as ApprovalId;
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      canSubmit: false,
      chatView: {
        status: "waiting_for_approval",
        items: [],
        pendingApprovals: [
          {
            id: approvalId,
            kind: "approval",
            permission: "tool.bash",
            patterns: ["bun test"],
            status: "pending",
            createdAt: 1,
            toolName: "bash",
            toolDisplayStatus: "waiting_permission",
            inputSummary: { title: "bash", command: "bun test", detail: "bun test" },
            metadata: {
              reason: "Policy requires approval for shell execution",
              source: "project permissions",
              approvalRisks: [{ pattern: "bun test", action: "ask", reason: "shell command can execute local scripts" }],
            },
          },
        ] as never,
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      approveApproval: async (id, options) => {
        approved.push({ id, scope: options?.scope });
      },
      rejectApproval: async (id) => {
        rejected.push(id);
      },
    },
  });

  try {
    expect(app.captureCharFrame()).toContain("Approval required: bash");
    expect(app.captureCharFrame()).toContain("risk: shell command");
    expect(app.captureCharFrame()).toContain("> bun test");
    expect(app.captureCharFrame()).toContain("a once | s session | A always | x deny");

    await press(app, () => app.mockInput.pressKey("a"));
    expect(approved).toEqual([{ id: approvalId, scope: "once" }]);

    await press(app, () => app.mockInput.pressKey("s"));
    expect(approved).toEqual([{ id: approvalId, scope: "once" }, { id: approvalId, scope: "session" }]);

    await press(app, () => app.mockInput.pressKey("a", { shift: true }));
    expect(approved).toEqual([
      { id: approvalId, scope: "once" },
      { id: approvalId, scope: "session" },
      { id: approvalId, scope: "persistent" },
    ]);

    await press(app, () => app.mockInput.pressKey("x"));
    expect(rejected).toEqual([approvalId]);
  } finally {
    app.renderer.destroy();
  }
});

test("one-time approval shortcuts cannot grant a wider scope", async () => {
  const approved: Array<{ id: ApprovalId; scope: ChatApproveOptions["scope"] }> = [];
  const approvalId = "approval_once_only" as ApprovalId;
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      canSubmit: false,
      chatView: {
        status: "waiting_for_approval",
        items: [],
        pendingApprovals: [
          {
            id: approvalId,
            kind: "approval",
            permission: "bash.unsandboxed",
            patterns: ["remindctl status"],
            maxApprovalScope: "once",
            status: "pending",
            createdAt: 1,
            toolName: "bash",
            toolDisplayStatus: "waiting_permission",
            inputSummary: { title: "bash", command: "remindctl status", detail: "remindctl status" },
          },
        ] as never,
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      approveApproval: async (id, options) => {
        approved.push({ id, scope: options?.scope });
      },
    },
  });

  try {
    expect(app.captureCharFrame()).toContain("a once | x deny");

    await press(app, () => app.mockInput.pressKey("s"));
    await press(app, () => app.mockInput.pressKey("a", { shift: true }));
    expect(approved).toEqual([]);

    await press(app, () => app.mockInput.pressKey("a"));
    expect(approved).toEqual([{ id: approvalId, scope: "once" }]);
  } finally {
    app.renderer.destroy();
  }
});

test("unsandboxed approval cannot be accepted until the full command fits", async () => {
  const approved: ApprovalId[] = [];
  const approvalId = "approval_resize_review" as ApprovalId;
  const command = `remindctl status ${"--include-completed ".repeat(60)}`;
  const app = await mountShell(teamLiveFixture(), {
    width: 60,
    height: 18,
    runtime: {
      canSubmit: false,
      chatView: {
        status: "waiting_for_approval",
        items: [],
        pendingApprovals: [
          {
            id: approvalId,
            kind: "approval",
            permission: "bash.unsandboxed",
            patterns: [command],
            maxApprovalScope: "once",
            status: "pending",
            createdAt: 1,
            toolName: "bash",
            toolDisplayStatus: "waiting_permission",
            inputSummary: { title: "bash", command, detail: command, scope: "/repo" },
            metadata: { justification: "inspect Reminders access" },
          },
        ] as never,
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      approveApproval: async (id) => {
        approved.push(id);
      },
    },
  });

  try {
    expect(app.captureCharFrame()).toContain("Resize the terminal to review the full command");
    await press(app, () => app.mockInput.pressKey("a"));
    expect(approved).toEqual([]);
  } finally {
    app.renderer.destroy();
  }
});

test("pending approval shortcuts work when the prompt still has a draft", async () => {
  const approved: Array<{ id: ApprovalId; scope: ChatApproveOptions["scope"] }> = [];
  const approvalId = "approval_with_draft" as ApprovalId;
  const app = await mountStatefulShell(teamLiveFixture(), {
    runtime: {
      approveApproval: async (id, options) => {
        approved.push({ id, scope: options?.scope });
      },
    },
  });

  try {
    await typeText(app, "draft left in composer");
    await act(async () => {
      app.setRuntime((current) => ({
        ...current,
        canSubmit: false,
        chatView: {
          status: "waiting_for_approval",
          items: [],
          pendingApprovals: [
            {
              id: approvalId,
              kind: "approval",
              permission: "git_stage",
              patterns: ["apps/tui/src/ChatShellApp.tsx"],
              status: "pending",
              createdAt: 1,
              toolName: "git_stage",
              toolDisplayStatus: "waiting_permission",
              inputSummary: { title: "git_stage", detail: "apps/tui/src/ChatShellApp.tsx" },
              metadata: { reason: "No permission rule matched git_stage:apps/tui/src/ChatShellApp.tsx.", source: "default" },
            },
          ] as never,
          activeTools: [],
          generatedAt: "1970-01-01T00:00:01.000Z",
        },
      }));
    });
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(frame).toContain("draft left");
    expect(frame).toContain("in composer");

    await press(app, () => app.mockInput.pressKey("s"));
    await press(app, () => app.mockInput.pressKey("a", { shift: true }));

    expect(approved).toEqual([
      { id: approvalId, scope: "session" },
      { id: approvalId, scope: "persistent" },
    ]);
  } finally {
    app.renderer.destroy();
  }
});

test("stale approval resolve failures are shown instead of success", async () => {
  const records = chatClientRecords();
  const sessionId = "session_stale_approval" as SessionId;
  const threadId = "thread_stale_approval" as ThreadId;
  const approvalId = "approval_stale" as ApprovalId;
  const client = fakeChatClient(records, approvalEvents(sessionId, threadId, approvalId), {
    approveResolved: false,
  });
  const app = await mountChatApp(client, { sessionId, threadId });

  try {
    await Bun.sleep(80);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("approval bash pending");

    await press(app, () => app.mockInput.pressKey("a"));
    expect(records.approve).toHaveLength(1);
    expect(app.captureCharFrame()).toContain("Approval is no longer pending after recheck");
    expect(app.captureCharFrame()).not.toContain("approval allowed once");
  } finally {
    app.renderer.destroy();
  }
});

test("session approval shortcut sends session-scoped approval", async () => {
  const records = chatClientRecords();
  const sessionId = "session_scoped_approval" as SessionId;
  const threadId = "thread_scoped_approval" as ThreadId;
  const approvalId = "approval_scoped" as ApprovalId;
  const client = fakeChatClient(records, approvalEvents(sessionId, threadId, approvalId));
  const app = await mountChatApp(client, { sessionId, threadId });

  try {
    await Bun.sleep(80);
    await app.renderOnce();

    await press(app, () => app.mockInput.pressKey("s"));
    expect(records.approve).toHaveLength(1);
    expect(records.approve[0]).toMatchObject({ approvalId, scope: "session" });
    expect(app.captureCharFrame()).toContain("approval allowed for session");
  } finally {
    app.renderer.destroy();
  }
});

test("persistent approval shortcut sends persistent-scoped approval", async () => {
  const records = chatClientRecords();
  const sessionId = "session_persistent_approval" as SessionId;
  const threadId = "thread_persistent_approval" as ThreadId;
  const approvalId = "approval_persistent" as ApprovalId;
  const client = fakeChatClient(records, approvalEvents(sessionId, threadId, approvalId));
  const app = await mountChatApp(client, { sessionId, threadId });

  try {
    await Bun.sleep(80);
    await app.renderOnce();

    await press(app, () => app.mockInput.pressKey("a", { shift: true }));
    expect(records.approve).toHaveLength(1);
    expect(records.approve[0]).toMatchObject({ approvalId, scope: "persistent" });
    expect(app.captureCharFrame()).toContain("approval allowed always");
  } finally {
    app.renderer.destroy();
  }
});

test("/skills enable and disable update project skill settings", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "chili-tui-skills-"));
  const refreshed: string[] = [];
  const reviewer = skillSummary("reviewer", { baseDir: path.join(cwd, ".chili", "skills", "reviewer") });
  const app = await mountShell(teamLiveFixture(), {
    cwd,
    skills: [reviewer],
    allSkills: [reviewer],
    onSkillsChanged: async () => {
      refreshed.push("yes");
    },
    runtime: {
      submitPrompt: async () => true,
    },
  });

  try {
    await typeText(app, "/skills disable reviewer");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    expect(JSON.parse(await readFile(path.join(cwd, ".chili", "skills.json"), "utf8"))).toEqual({ disabled: ["reviewer"] });
    expect(refreshed).toEqual(["yes"]);
    expect(app.captureCharFrame()).toContain("Skill $reviewer disabled (project).");

    await typeText(app, "/skills enable reviewer");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(80);
    await app.renderOnce();

    expect(JSON.parse(await readFile(path.join(cwd, ".chili", "skills.json"), "utf8"))).toEqual({ disabled: [] });
    expect(refreshed).toEqual(["yes", "yes"]);
    expect(app.captureCharFrame()).toContain("Skill $reviewer enabled (project).");
  } finally {
    app.renderer.destroy();
  }
});

test("slash team opens cockpit and Escape returns to chat shell", async () => {
  const app = await mountShell(teamLiveFixture());

  try {
    await typeText(app, "/team");
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("Chili Team Live");

    await press(app, () => app.mockInput.pressEscape());
    expect(app.captureCharFrame()).toContain("Ask anything");
    expect(app.captureCharFrame()).not.toContain("Chili Team Live");
  } finally {
    app.renderer.destroy();
  }
});

test("Ctrl+P opens the command palette", async () => {
  const app = await mountShell(teamLiveFixture());

  try {
    await press(app, () => app.mockInput.pressKey("p", { ctrl: true }));
    expect(app.captureCharFrame()).toContain("Command Palette");
    expect(app.captureCharFrame()).toContain("/team");
    expect(app.captureCharFrame()).toContain("/model [provider/model] - Select model");
    expect(app.captureCharFrame()).toContain("/thinking <off|minimal|low");
    expect(app.captureCharFrame()).toContain("/fast <on|off|status> - Set Codex Fast mode");
    expect(app.captureCharFrame()).toContain("/theme - Switch theme");
  } finally {
    app.renderer.destroy();
  }
});

test("slash completion includes team command", async () => {
  const app = await mountShell(teamLiveFixture());

  try {
    await typeText(app, "/");
    expect(app.captureCharFrame()).toContain("Commands");
    expect(app.captureCharFrame()).toContain("/team");
    expect(app.captureCharFrame()).toContain("/hide-thinking");
  } finally {
    app.renderer.destroy();
  }
});

test("/theme opens the theme picker", async () => {
  const app = await mountShell(teamLiveFixture());

  try {
    await typeText(app, "/theme");
    await press(app, () => app.mockInput.pressEnter());

    const frame = app.captureCharFrame();
    expect(frame).toContain("Theme");
    expect(frame).toContain("  Chili Dark");
    expect(frame).toContain("  Terminal Dark");
    expect(frame).toContain("> System (fallback)");
    expect(frame).toContain("  Chili Light");
    expect(frame).toContain("  Warm Light");
  } finally {
    app.renderer.destroy();
  }
});

test("/resume opens a searchable project-scoped picker and switches sessions", async () => {
  const resumed: string[] = [];
  const sessions = [
    {
      id: "session_current" as SessionId,
      threadId: "thread_current" as ThreadId,
      cwd: "/repo/chili",
      title: "Current chat",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "session_saved" as SessionId,
      threadId: "thread_saved" as ThreadId,
      cwd: "/repo/chili",
      title: "Fix resume flow",
      preview: "Wire the saved conversation picker",
      source: "interactive" as const,
      status: "active" as const,
      createdAt: 2,
      updatedAt: 3,
    },
    {
      id: "session_other" as SessionId,
      threadId: "thread_other" as ThreadId,
      cwd: "/repo/other",
      title: "Other project",
      source: "interactive" as const,
      status: "active" as const,
      createdAt: 2,
      updatedAt: 4,
    },
    {
      id: "session_worker" as SessionId,
      threadId: "thread_worker" as ThreadId,
      cwd: "/repo/chili",
      title: "Internal worker",
      source: "subagent" as const,
      status: "active" as const,
      createdAt: 2,
      updatedAt: 5,
    },
  ];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      activeSessionId: "session_current" as SessionId,
      activeThreadId: "thread_current" as ThreadId,
      chatView: {
        sessionId: "session_current" as SessionId,
        threadId: "thread_current" as ThreadId,
        status: "idle",
        items: [],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      listSessions: async () => sessions,
      resumeSession: async (session) => {
        resumed.push(session.id);
        return true;
      },
    },
  });

  try {
    await typeText(app, "/resume");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(40);
    await app.renderOnce();

    let frame = app.captureCharFrame();
    expect(frame).toContain("Resume saved chat");
    expect(frame).toContain("Fix resume flow");
    expect(frame).not.toContain("Other project");
    expect(frame).not.toContain("Internal worker");

    await press(app, () => app.mockInput.pressKey("a", { ctrl: true }));
    frame = app.captureCharFrame();
    expect(frame).toContain("Other project");
    expect(frame).not.toContain("Internal worker");

    await typeText(app, "Fix resume");
    await press(app, () => app.mockInput.pressEnter());
    expect(resumed).toEqual(["session_saved"]);
  } finally {
    app.renderer.destroy();
  }
});

test("/rename edits and saves the current chat title", async () => {
  const renamed: string[] = [];
  const sessionId = "session_rename" as SessionId;
  const threadId = "thread_rename" as ThreadId;
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      activeSessionId: sessionId,
      activeThreadId: threadId,
      chatView: {
        sessionId,
        threadId,
        status: "idle",
        items: [],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      listSessions: async () => [{
        id: sessionId,
        threadId,
        cwd: "/repo/chili",
        title: "Old",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }],
      renameSession: async (title) => {
        renamed.push(title);
        return { id: sessionId, threadId, cwd: "/repo/chili", title, status: "active", createdAt: 1, updatedAt: 2 };
      },
    },
  });

  try {
    await typeText(app, "/rename");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(40);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("Rename chat");
    expect(app.captureCharFrame()).toContain("> Old");

    await backspace(app, 3);
    await typeText(app, "Investigation");
    await press(app, () => app.mockInput.pressEnter());
    expect(renamed).toEqual(["Investigation"]);
  } finally {
    app.renderer.destroy();
  }
});

test("theme picker Up and Down preview the selected theme", async () => {
  const app = await mountShell(teamLiveFixture());

  try {
    await typeText(app, "/theme");
    await press(app, () => app.mockInput.pressEnter());

    await press(app, () => app.mockInput.pressArrow("down"));
    expect(app.captureCharFrame()).toContain("> Chili Light");

    await press(app, () => app.mockInput.pressArrow("down"));
    expect(app.captureCharFrame()).toContain("> Warm Light");

    await press(app, () => app.mockInput.pressArrow("up"));
    expect(app.captureCharFrame()).toContain("> Chili Light");
  } finally {
    app.renderer.destroy();
  }
});

test("theme picker Escape rolls back the previewed theme", async () => {
  const app = await mountShell(teamLiveFixture());

  try {
    await typeText(app, "/theme");
    await press(app, () => app.mockInput.pressEnter());
    await press(app, () => app.mockInput.pressArrow("down"));
    expect(app.captureCharFrame()).toContain("> Chili Light");

    await press(app, () => app.mockInput.pressEscape());
    expect(app.captureCharFrame()).not.toContain("> Chili Light");

    await typeText(app, "/theme");
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("> System (fallback)");
  } finally {
    app.renderer.destroy();
  }
});

test("theme picker preserves an in-progress draft opened from the command palette", async () => {
  const app = await mountShell(teamLiveFixture());

  try {
    await typeText(app, "draft before theme");
    await press(app, () => app.mockInput.pressKey("p", { ctrl: true }));
    await selectPaletteCommand(app, "/theme");
    await press(app, () => app.mockInput.pressEnter());

    expect(app.captureCharFrame()).toContain("Theme");
    expect(app.captureCharFrame()).toContain("draft before theme");

    await press(app, () => app.mockInput.pressArrow("down"));
    expect(app.captureCharFrame()).toContain("> Chili Light");

    await press(app, () => app.mockInput.pressEscape());
    expect(app.captureCharFrame()).toContain("draft before theme");
    expect(app.captureCharFrame()).not.toContain("Theme");
  } finally {
    app.renderer.destroy();
  }
});

test("theme picker Enter confirms the previewed theme", async () => {
  const app = await mountShell(teamLiveFixture());

  try {
    await typeText(app, "/theme");
    await press(app, () => app.mockInput.pressEnter());
    await press(app, () => app.mockInput.pressArrow("down"));
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).not.toContain("> Chili Light");

    await typeText(app, "/theme");
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("> Chili Light");
  } finally {
    app.renderer.destroy();
  }
});

test("/model uses runtime catalog and persists the selected model", async () => {
  const records = chatClientRecords();
  const client = fakeChatClient(records, [], {
    models: [
      { provider: "minimax", model: "MiniMax-M2.7-highspeed", displayName: "MiniMax runtime" },
    ],
  });
  const app = await mountChatApp(client);

  try {
    await Bun.sleep(120);
    await app.renderOnce();

    await typeText(app, "/model");
    await press(app, () => app.mockInput.pressEnter());

    const pickerFrame = app.captureCharFrame();
    expect(records.listModels.length).toBeGreaterThan(0);
    expect(pickerFrame).toContain("MiniMax-M2.7-highspeed");
    expect(pickerFrame).not.toContain("gpt-5.5");

    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(120);
    await app.renderOnce();

    expect(records.create).toHaveLength(1);
    expect(records.setModel[0]).toMatchObject({
      sessionId: "session_created",
      threadId: "thread_created",
      modelSelection: { provider: "minimax", model: "MiniMax-M2.7-highspeed" },
    });
    const footerLine = app.captureCharFrame().split("\n").find((line) => line.includes("MiniMax-M2.7-highspeed") && line.includes("Build")) ?? "";
    expect(footerLine).toContain("MiniMax-M2.7-highspeed");
    expect(footerLine).not.toContain("minimax/");
  } finally {
    app.renderer.destroy();
  }
});

test("/model uses a focused search surface and skips empty sources", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      modelCandidates: [
        { provider: "test-provider", providerDisplayName: "Test Provider", model: "test-model" },
        { provider: "anthropic", providerDisplayName: "Anthropic", model: "claude-opus-4.1" },
        { provider: "openai", providerDisplayName: "OpenAI", model: "gpt-5.5" },
      ],
    },
  });

  try {
    await typeText(app, "/model");
    await press(app, () => app.mockInput.pressEnter());

    let frame = app.captureCharFrame();
    expect(frame).toContain("Select model");
    expect(frame).toContain("Search  > ▏  type a model or source");
    expect(frame).toContain("Source  All · 3 models  tab switch");
    expectFramedModelSearch(frame);

    await typeText(app, " ");
    frame = app.captureCharFrame();
    expect(frame).toContain("type a model or source");
    expect(frame).toContain("Source  All · 3 models  tab switch");
    expectFramedModelSearch(frame);
    await press(app, () => app.mockInput.pressBackspace());

    await press(app, () => app.mockInput.pressTab());
    frame = app.captureCharFrame();
    expect(frame).toContain("Source  Anthropic · 1 model  tab switch");
    expect(frame).toContain("claude-opus-4.1 [Anthropic]");
    expect(frame).not.toContain("test-model [Test Provider]");

    await typeText(app, "opus");
    frame = app.captureCharFrame();
    expect(frame).toContain("Source  Anthropic · 1 match  tab switch");
    expect(frame).toContain("Search  > opus▏");
    expect(frame).toContain("claude-opus-4.1 [Anthropic]");
    expect(frame).not.toContain("gpt-5.5");

    await press(app, () => app.mockInput.pressArrow("left"));
    await typeText(app, "x");
    frame = app.captureCharFrame();
    expect(frame).toContain("Search  > opux▏s");
    await press(app, () => app.mockInput.pressBackspace());
    await press(app, () => app.mockInput.pressArrow("right"));
    frame = app.captureCharFrame();
    expect(frame).toContain("Search  > opus▏");

    await press(app, () => app.mockInput.pressArrow("left"));
    await press(app, () => app.mockInput.pressArrow("left"));
    await press(app, () => app.mockInput.pressKey("DELETE"));
    frame = app.captureCharFrame();
    expect(frame).toContain("Search  > op▏s");
    expectFramedModelSearch(frame);
    await typeText(app, "u");
    await press(app, () => app.mockInput.pressArrow("right"));
    frame = app.captureCharFrame();
    expect(frame).toContain("Search  > opus▏");

    await press(app, () => app.mockInput.pressTab());
    frame = app.captureCharFrame();
    expect(frame).toContain("Source  All · 1 match  tab switch");
    await press(app, () => app.mockInput.pressTab());
    frame = app.captureCharFrame();
    expect(frame).toContain("Source  Anthropic · 1 match  tab switch");
    await press(app, () => app.mockInput.pressTab({ shift: true }));
    frame = app.captureCharFrame();
    expect(frame).toContain("Source  All · 1 match  tab switch");
  } finally {
    app.renderer.destroy();
  }
});

test("/model keeps its chrome and prompt separate in a 48x13 home terminal", async () => {
  const app = await mountShell(teamLiveFixture(), {
    width: 48,
    height: 13,
    runtime: {
      modelCandidates: Array.from({ length: 10 }, (_, index) => ({
        provider: "compact",
        providerDisplayName: "Compact",
        model: `model-${String(index + 1).padStart(2, "0")}`,
      })),
    },
  });

  try {
    await typeText(app, "/model");
    await press(app, () => app.mockInput.pressEnter());

    const frame = app.captureCharFrame();
    expectFramedModelSearch(frame);
    expect(frame).toContain("Source  All · 10 models");
    expect(frame).not.toContain("> model-01 [Compact]");
    expect(frame).toContain("↑/↓ navigate");
    expect(frame).toContain("> Choose a model");

    const lines = frame.split("\n");
    const helpLine = lines.findIndex((line) => line.includes("↑/↓ navigate"));
    const promptLine = lines.findIndex((line) => line.includes("> Choose a model"));
    expect(helpLine).toBeGreaterThan(-1);
    expect(promptLine).toBeGreaterThan(helpLine);
    expect(lines[helpLine]).not.toContain("Choose a model");
  } finally {
    app.renderer.destroy();
  }
});

test("/model keeps its chrome and prompt separate in a 48x15 active chat", async () => {
  const app = await mountShell(teamLiveFixture(), {
    width: 48,
    height: 15,
    runtime: {
      chatView: {
        status: "idle",
        items: chatMessages(1),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      modelCandidates: Array.from({ length: 10 }, (_, index) => ({
        provider: "compact",
        providerDisplayName: "Compact",
        model: `model-${String(index + 1).padStart(2, "0")}`,
      })),
    },
  });

  try {
    await typeText(app, "/model");
    await press(app, () => app.mockInput.pressEnter());

    const frame = app.captureCharFrame();
    expectFramedModelSearch(frame);
    expect(frame).toContain("Source  All · 10 models");
    expect(frame).not.toContain("> model-01 [Compact]");
    expect(frame).toContain("↑/↓ navigate");
    expect(frame).toContain("> Choose a model");

    const lines = frame.split("\n");
    const helpLine = lines.findIndex((line) => line.includes("↑/↓ navigate"));
    const promptLine = lines.findIndex((line) => line.includes("> Choose a model"));
    expect(helpLine).toBeGreaterThan(-1);
    expect(promptLine).toBeGreaterThan(helpLine);
    expect(lines[helpLine]).not.toContain("Choose a model");
  } finally {
    app.renderer.destroy();
  }
});

test("/model removes result rows when a 48x20 approval dock appears", async () => {
  const approvalId = "approval_model_picker_compact" as ApprovalId;
  const app = await mountStatefulShell(teamLiveFixture(), {
    width: 48,
    height: 20,
    runtime: {
      chatView: {
        status: "idle",
        items: chatMessages(1),
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      modelCandidates: Array.from({ length: 10 }, (_, index) => ({
        provider: "compact",
        providerDisplayName: "Compact",
        model: `model-${String(index + 1).padStart(2, "0")}`,
      })),
    },
  });

  try {
    await typeText(app, "/model");
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("> model-01 [Compact]");

    await act(async () => {
      app.setRuntime((runtime) => ({
        ...runtime,
        revision: runtime.revision + 1,
        chatView: {
          ...runtime.chatView,
          status: "waiting_for_approval",
          pendingApprovals: [{
            id: approvalId,
            kind: "approval",
            permission: "tool.bash",
            patterns: ["bun test"],
            status: "pending",
            createdAt: 1,
            toolName: "bash",
            toolDisplayStatus: "waiting_permission",
            inputSummary: { title: "bash", command: "bun test", detail: "bun test" },
          }] as never,
        },
      }));
    });
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(frame).toContain("Approval required: bash");
    expect(frame).toContain("> bun test");
    expect(frame).toContain("a once | s session | A always | x deny");
    expectFramedModelSearch(frame);
    expect(frame).toContain("Source  All · 10 models");
    expect(frame).not.toContain("> model-01 [Compact]");
    expect(frame).toContain("> Choose a model");

    const lines = frame.split("\n");
    const approvalHintLine = lines.findIndex((line) => line.includes("a once | s session"));
    const searchLine = lines.findIndex((line) => line.includes("Search  >"));
    const pickerHelpLine = lines.findIndex((line) => line.includes("↑/↓ navigate"));
    const promptLine = lines.findIndex((line) => line.includes("> Choose a model"));
    expect(approvalHintLine).toBeGreaterThan(-1);
    expect(searchLine).toBeGreaterThan(approvalHintLine);
    expect(pickerHelpLine).toBeGreaterThan(searchLine);
    expect(promptLine).toBeGreaterThan(pickerHelpLine);
  } finally {
    app.renderer.destroy();
  }
});

test("/model labels identical Codex models as ChatGPT or Api and selects the right provider", async () => {
  const selected: ModelSelection[] = [];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      modelCandidates: [
        {
          provider: "codex-api",
          providerDisplayName: "Api",
          model: "gpt-5.6-sol",
          connectionLabel: "Third-party API",
        },
        {
          provider: "openai-codex",
          providerDisplayName: "ChatGPT",
          model: "gpt-5.6-sol",
          connectionLabel: "ChatGPT OAuth",
        },
      ],
      setRuntimeModel: async (selection) => {
        selected.push(selection);
        return true;
      },
    },
  });

  try {
    await typeText(app, "/model");
    await press(app, () => app.mockInput.pressEnter());

    let frame = app.captureCharFrame();
    const chatGptIndex = frame.indexOf("gpt-5.6-sol [ChatGPT]");
    const apiIndex = frame.indexOf("gpt-5.6-sol [Api]");
    expect(chatGptIndex).toBeGreaterThanOrEqual(0);
    expect(apiIndex).toBeGreaterThan(chatGptIndex);
    expect(frame).not.toContain("[ChatGPT Codex]");
    expect(frame).not.toContain("[Codex API]");

    await typeText(app, "chatgpt");
    frame = app.captureCharFrame();
    expect(frame).toContain("gpt-5.6-sol [ChatGPT]");
    expect(frame).not.toContain("gpt-5.6-sol [Api]");

    await backspace(app, "chatgpt".length);
    await typeText(app, "api");
    frame = app.captureCharFrame();
    expect(frame).toContain("Source  All · 1 match  tab switch");
    expect(frame).toContain("gpt-5.6-sol [Api]");
    expect(frame).not.toContain("gpt-5.6-sol [ChatGPT]");

    await press(app, () => app.mockInput.pressEnter());
    expect(selected).toEqual([{ provider: "codex-api", model: "gpt-5.6-sol" }]);
  } finally {
    app.renderer.destroy();
  }
});

test("/model search highlights the best match instead of keeping a weaker current model", async () => {
  const current = { provider: "openai-codex", model: "gpt-5.6-sol" };
  const candidates: RuntimeModelDescriptor[] = [
    { ...current, providerDisplayName: "ChatGPT", default: true },
    { provider: "codex-api", providerDisplayName: "Api", model: "gpt-5.6-sol", default: true },
    { provider: "openai-codex", providerDisplayName: "ChatGPT", model: "gpt-5.6-luna" },
    { provider: "codex-api", providerDisplayName: "Api", model: "gpt-5.6-luna" },
  ];
  const selected: ModelSelection[] = [];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      modelCandidates: candidates,
      modelConfig: {
        sessionId: "session_model_search" as SessionId,
        models: candidates,
        availableReasoningLevels: [],
        modelSelection: current,
      },
      setRuntimeModel: async (selection) => {
        selected.push(selection);
        return true;
      },
    },
  });

  try {
    await typeText(app, "/model");
    await press(app, () => app.mockInput.pressEnter());
    await typeText(app, "gpt-5.6-l");

    const frame = app.captureCharFrame();
    expect(frame).toContain("> gpt-5.6-luna [ChatGPT]");
    expect(frame.indexOf("gpt-5.6-luna [Api]")).toBeGreaterThan(frame.indexOf("gpt-5.6-luna [ChatGPT]"));

    await press(app, () => app.mockInput.pressEnter());
    expect(selected).toEqual([{ provider: "openai-codex", model: "gpt-5.6-luna" }]);
  } finally {
    app.renderer.destroy();
  }
});

test("/model keeps the highlighted model stable when a refreshed catalog reorders rows", async () => {
  const selected: ModelSelection[] = [];
  const initialModels: RuntimeModelDescriptor[] = [
    { provider: "stable", providerDisplayName: "Stable", model: "alpha" },
    { provider: "stable", providerDisplayName: "Stable", model: "gamma" },
  ];
  const app = await mountStatefulShell(teamLiveFixture(), {
    runtime: {
      modelCandidates: initialModels,
      setRuntimeModel: async (selection) => {
        selected.push(selection);
        return true;
      },
    },
  });

  try {
    await typeText(app, "/model");
    await press(app, () => app.mockInput.pressEnter());
    await press(app, () => app.mockInput.pressArrow("down"));
    expect(app.captureCharFrame()).toContain("> gamma [Stable]");

    await act(async () => {
      app.setRuntime((runtime) => ({
        ...runtime,
        revision: runtime.revision + 1,
        modelCandidates: [
          initialModels[0]!,
          { provider: "stable", providerDisplayName: "Stable", model: "beta" },
          initialModels[1]!,
        ],
      }));
    });
    await app.renderOnce();

    expect(app.captureCharFrame()).toContain("> gamma [Stable]");
    await press(app, () => app.mockInput.pressEnter());
    expect(selected).toEqual([{ provider: "stable", model: "gamma" }]);
  } finally {
    app.renderer.destroy();
  }
});

test("/model falls back to All when a refreshed catalog removes the active source", async () => {
  const selected: ModelSelection[] = [];
  const remaining: RuntimeModelDescriptor = {
    provider: "stay",
    providerDisplayName: "Stay",
    model: "stay-model",
  };
  const app = await mountStatefulShell(teamLiveFixture(), {
    runtime: {
      modelCandidates: [
        { provider: "gone", providerDisplayName: "Gone", model: "gone-model" },
        remaining,
      ],
      setRuntimeModel: async (selection) => {
        selected.push(selection);
        return true;
      },
    },
  });

  try {
    await typeText(app, "/model");
    await press(app, () => app.mockInput.pressEnter());
    await press(app, () => app.mockInput.pressTab());
    expect(app.captureCharFrame()).toContain("Source  Gone · 1 model  tab switch");

    await act(async () => {
      app.setRuntime((runtime) => ({
        ...runtime,
        revision: runtime.revision + 1,
        modelCandidates: [remaining],
      }));
    });
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(frame).toContain("Source  All · 1 model  tab switch");
    expect(frame).toContain("> stay-model [Stay]");
    await press(app, () => app.mockInput.pressEnter());
    expect(selected).toEqual([{ provider: "stay", model: "stay-model" }]);
  } finally {
    app.renderer.destroy();
  }
});

test("/model detail shows safe connection metadata", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      modelCandidates: [{
        provider: "codex-api",
        model: "gpt-5.5",
        connectionLabel: "Third-party API",
        authSource: "environment",
        endpoint: "https://gateway-user:secret@gateway.example:8443/v1?api_key=hidden#fragment",
      }],
    },
  });

  try {
    await typeText(app, "/model");
    await press(app, () => app.mockInput.pressEnter());

    const frame = app.captureCharFrame();
    expect(frame).toContain("connection Third-party API");
    expect(frame).toContain("auth API key");
    expect(frame).toContain("endpoint gateway.example:8443");
    expect(frame).not.toContain("gateway-user");
    expect(frame).not.toContain("secret");
    expect(frame).not.toContain("api_key");
  } finally {
    app.renderer.destroy();
  }
});

test("/model keeps the old UI state when persistence fails", async () => {
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      modelCandidates: [
        { provider: "openai-codex", model: "gpt-5.5", displayName: "GPT-5.5" },
      ],
      setRuntimeModel: async () => false,
    },
  });

  try {
    await typeText(app, "/model openai-codex/gpt-5.5");
    await press(app, () => app.mockInput.pressEnter());
    await Bun.sleep(120);
    await app.renderOnce();

    const frame = app.captureCharFrame();
    expect(frame).toContain("Model unchanged: failed to persist openai-codex/gpt-5.5");
    expect(frame.split("\n").some((line) => line.includes("test-model") && line.includes("Build"))).toBe(true);
    expect(frame).not.toContain("openai-codex/gpt-5.5 Build");
  } finally {
    app.renderer.destroy();
  }
});

test("/status separates the live event stream from execution and reports unsupported MiniMax controls", async () => {
  let serviceTierChanges = 0;
  const selection = { provider: "minimax", model: "MiniMax-M3[1m]" };
  const models: ModelCandidate[] = [{
    ...selection,
    capabilities: { reasoning: true },
    reasoningLevels: [],
  }];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      modelCandidates: models,
      modelConfig: {
        sessionId: "session_minimax_status" as SessionId,
        models: [{
          ...selection,
          capabilities: { reasoning: true },
          reasoningLevels: [],
        }],
        availableReasoningLevels: [],
        modelSelection: selection,
        reasoningLevel: "high",
        serviceTier: "fast",
      },
      setRuntimeServiceTier: async () => {
        serviceTierChanges += 1;
        return true;
      },
    },
  });

  try {
    await typeText(app, "/status");
    await press(app, () => app.mockInput.pressEnter());

    let frame = app.captureCharFrame();
    expect(frame).toContain("event stream: connected");
    expect(frame).toContain("execution: idle");
    expect(frame).toContain("thinking: unsupported");
    expect(frame).toContain("service tier: unsupported");
    expect(frame).not.toContain("connection: streaming");

    await press(app, () => app.mockInput.pressEscape());
    await typeText(app, "/thinking");
    await press(app, () => app.mockInput.pressEnter());
    frame = app.captureCharFrame();
    expect(frame).toContain("does not support configurable thinking");
    expect(frame).not.toContain("Very brief reasoning");

    await typeText(app, "/fast on");
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("Fast mode is not available for the selected model");
    expect(serviceTierChanges).toBe(0);
  } finally {
    app.renderer.destroy();
  }
});

test("/status preserves effective reasoning and fast tier for OpenAI Codex", async () => {
  const selection = { provider: "openai-codex", model: "gpt-5.6-sol" };
  const models: ModelCandidate[] = [{
    ...selection,
    connectionLabel: "ChatGPT OAuth",
    authSource: "oauth",
    endpoint: "https://chatgpt.com/backend-api",
    capabilities: { reasoning: true },
    reasoningLevels: ["off", "low", "medium", "high"],
    serviceTiers: ["standard", "fast"],
  }];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      modelCandidates: models,
      modelConfig: {
        sessionId: "session_codex_status" as SessionId,
        models: [{
          ...selection,
          connectionLabel: "ChatGPT OAuth",
          authSource: "oauth",
          endpoint: "https://chatgpt.com/backend-api",
          capabilities: { reasoning: true },
          reasoningLevels: ["off", "low", "medium", "high"],
          serviceTiers: ["standard", "fast"],
        }],
        availableReasoningLevels: ["off", "low", "medium", "high"],
        modelSelection: selection,
        reasoningLevel: "high",
        serviceTier: "fast",
      },
    },
  });

  try {
    await typeText(app, "/status");
    await press(app, () => app.mockInput.pressEnter());

    const frame = app.captureCharFrame();
    expect(frame).toContain("model: openai-codex/gpt-5.6-sol");
    expect(frame).toContain("connection: ChatGPT OAuth");
    expect(frame).toContain("auth: ChatGPT OAuth");
    expect(frame).toContain("endpoint: chatgpt.com");
    expect(frame).toContain("thinking: high");
    expect(frame).toContain("service tier: fast");
  } finally {
    app.renderer.destroy();
  }
});

test("/status distinguishes a third-party API key connection from ChatGPT OAuth", async () => {
  const selection = { provider: "codex-api", model: "gpt-5.5" };
  const models: RuntimeModelDescriptor[] = [
    {
      provider: "openai-codex",
      model: "gpt-5.5",
      connectionLabel: "ChatGPT OAuth",
      authSource: "oauth",
      endpoint: "https://chatgpt.com/backend-api",
    },
    {
      ...selection,
      connectionLabel: "Third-party API",
      authSource: "environment",
      endpoint: "https://gateway-user:secret@gateway.example:8443/v1?api_key=hidden#fragment",
    },
  ];
  const app = await mountShell(teamLiveFixture(), {
    runtime: {
      modelCandidates: models,
      modelConfig: {
        sessionId: "session_api_status" as SessionId,
        models,
        availableReasoningLevels: [],
        modelSelection: selection,
      },
    },
  });

  try {
    await typeText(app, "/status");
    await press(app, () => app.mockInput.pressEnter());

    const frame = app.captureCharFrame();
    expect(frame).toContain("model: codex-api/gpt-5.5");
    expect(frame).toContain("connection: Third-party API");
    expect(frame).toContain("auth: API key");
    expect(frame).toContain("endpoint: gateway.example:8443");
    expect(frame).not.toContain("ChatGPT OAuth");
    expect(frame).not.toContain("chatgpt.com");
    expect(frame).not.toContain("gateway-user");
    expect(frame).not.toContain("secret");
    expect(frame).not.toContain("api_key");
  } finally {
    app.renderer.destroy();
  }
});

test("/status shows status reasons for failed and cancelled executions", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    const reason = `${status} because the provider closed the response stream`;
    const app = await mountShell(teamLiveFixture(), {
      runtime: {
        chatView: {
          status,
          statusReason: reason,
          items: [],
          pendingApprovals: [],
          activeTools: [],
          generatedAt: "1970-01-01T00:00:00.000Z",
        },
      },
    });

    try {
      await typeText(app, "/status");
      await press(app, () => app.mockInput.pressEnter());

      const frame = app.captureCharFrame();
      expect(frame).toContain(`execution: ${status}`);
      expect(frame).toContain(`reason: ${reason}`);
    } finally {
      app.renderer.destroy();
    }
  }
});

test("/status shortcut copies the complete status page on a narrow screen and shows feedback", async () => {
  const copied: string[] = [];
  const sessionId = "session_status_copy_with_a_value_longer_than_the_visible_status_row" as SessionId;
  const threadId = "thread_status_copy_with_a_value_longer_than_the_visible_status_row" as ThreadId;
  const reason = "Provider request failed after every response retry was exhausted";
  const cwd = "/repo/chili/a/very/long/path/that/is/not/fully/visible/in/the/status/view";
  const app = await mountShell(teamLiveFixture(), {
    width: 44,
    height: 40,
    cwd,
    kittyKeyboard: true,
    clipboard: fakeClipboard({
      writeText: async (text) => {
        copied.push(text);
        return true;
      },
    }),
    runtime: {
      activeSessionId: sessionId,
      activeThreadId: threadId,
      chatView: {
        status: "failed",
        statusReason: reason,
        items: [{
          id: "msg_status_copy_previous" as MessageId,
          kind: "message",
          role: "assistant",
          createdAt: 1,
          parts: [{ type: "text", id: "part_status_copy_previous" as PartId, text: "PREVIOUS ASSISTANT REPLY" }],
        }],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  });

  try {
    await typeText(app, "/status");
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).not.toContain(sessionId);

    await press(app, () => app.mockInput.pressKey("c", { ctrl: true, shift: true }));

    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain(`execution: failed\nreason: ${reason}`);
    expect(copied[0]).toContain(`session: ${sessionId}`);
    expect(copied[0]).toContain(`thread: ${threadId}`);
    expect(copied[0]).toContain(`cwd: ${cwd}`);
    expect(copied[0]).not.toContain("PREVIOUS ASSISTANT REPLY");
    expect(app.captureCharFrame()).toContain("Copied status.");
  } finally {
    app.renderer.destroy();
  }
});

test("/status does not show clipboard feedback left by the chat view", async () => {
  const copied: string[] = [];
  const app = await mountShell(teamLiveFixture(), {
    localMessageTtlMs: 0,
    kittyKeyboard: true,
    clipboard: fakeClipboard({
      writeText: async (text) => {
        copied.push(text);
        return true;
      },
    }),
    runtime: {
      chatView: {
        status: "idle",
        items: [{
          id: "msg_status_stale_feedback" as MessageId,
          kind: "message",
          role: "assistant",
          createdAt: 1,
          parts: [{ type: "text", id: "part_status_stale_feedback" as PartId, text: "ASSISTANT COPY SOURCE" }],
        }],
        pendingApprovals: [],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  });

  try {
    await press(app, () => app.mockInput.pressKey("c", { ctrl: true, shift: true }));
    expect(copied).toEqual(["ASSISTANT COPY SOURCE"]);
    expect(app.captureCharFrame()).toContain("Copied latest assistant reply.");

    await typeText(app, "/status");
    await press(app, () => app.mockInput.pressEnter());

    const frame = app.captureCharFrame();
    expect(frame).toContain("Status");
    expect(frame).not.toContain("Copied latest assistant reply.");
    expect(frame).not.toContain("Copied status.");
  } finally {
    app.renderer.destroy();
  }
});

test("/status discards a pending copy result when the active session changes", async () => {
  let resolveWrite: ((copied: boolean) => void) | undefined;
  const writeResult = new Promise<boolean>((resolve) => {
    resolveWrite = resolve;
  });
  const oldSessionId = "session_status_copy_old" as SessionId;
  const oldThreadId = "thread_status_copy_old" as ThreadId;
  const newSessionId = "session_status_copy_new" as SessionId;
  const newThreadId = "thread_status_copy_new" as ThreadId;
  const app = await mountStatefulShell(teamLiveFixture(), {
    clipboard: fakeClipboard({ writeText: async () => writeResult }),
    runtime: {
      activeSessionId: oldSessionId,
      activeThreadId: oldThreadId,
    },
  });

  try {
    await typeText(app, "/status");
    await press(app, () => app.mockInput.pressEnter());
    await press(app, () => app.mockInput.pressKey("c", { ctrl: true, shift: true }));

    await act(async () => {
      app.setRuntime((current) => ({
        ...current,
        activeSessionId: newSessionId,
        activeThreadId: newThreadId,
      }));
      await app.renderOnce();
    });
    resolveWrite?.(true);
    await act(async () => {
      await Bun.sleep(0);
      await app.renderOnce();
    });

    const frame = app.captureCharFrame();
    expect(frame).toContain(`session: ${newSessionId}`);
    expect(frame).toContain(`thread: ${newThreadId}`);
    expect(frame).not.toContain("Copied status.");
  } finally {
    resolveWrite?.(false);
    app.renderer.destroy();
  }
});

test("/status supports themed multi-click selection and keeps selection copy priority", async () => {
  const copied: string[] = [];
  const sessionId = "session_status_selectable" as SessionId;
  const threadId = "thread_status_selectable" as ThreadId;
  const app = await mountShell(teamLiveFixture(), {
    width: 100,
    height: 36,
    useMouse: true,
    kittyKeyboard: true,
    clipboard: fakeClipboard({
      writeText: async (text) => {
        copied.push(text);
        return true;
      },
    }),
    runtime: {
      activeSessionId: sessionId,
      activeThreadId: threadId,
    },
  });

  try {
    await typeText(app, "/status");
    await press(app, () => app.mockInput.pressEnter());

    const frame = app.captureCharFrame();
    const sessionTarget = frameTextPosition(frame, sessionId);
    await act(async () => {
      await app.mockMouse.doubleClick(sessionTarget.x + 4, sessionTarget.y);
      await Bun.sleep(80);
      await app.renderOnce();
    });

    expect(app.renderer.getSelection()?.getSelectedText()).toBe(sessionId);
    expect(copied.at(-1)).toBe(sessionId);
    expect(selectionBgAt(app, sessionTarget.x, sessionTarget.y)).toBe(true);

    copied.length = 0;
    await press(app, () => app.mockInput.pressKey("c", { ctrl: true, shift: true }));
    expect(copied).toEqual([sessionId]);

    const threadTarget = frameTextPosition(app.captureCharFrame(), threadId);
    await act(async () => {
      await app.mockMouse.doubleClick(threadTarget.x + 4, threadTarget.y);
      await app.mockMouse.click(threadTarget.x + 4, threadTarget.y);
      await Bun.sleep(80);
      await app.renderOnce();
    });

    expect(app.renderer.getSelection()?.getSelectedText()).toBe(`thread: ${threadId}`);
    expect(copied.at(-1)).toBe(`thread: ${threadId}`);
  } finally {
    app.renderer.destroy();
  }
});

test("team run slash command executes SDK run-loop action", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountShell(withRunLoopReady(teamLiveFixture()), { executed });

  try {
    await typeText(app, "/team run");
    await press(app, () => app.mockInput.pressEnter());
    expect(executed[0]).toMatchObject({ type: "run_loop", enabled: true });
  } finally {
    app.renderer.destroy();
  }
});

test("team merge slash command executes SDK merge action", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountShell(teamLiveFixture(), { executed });

  try {
    await typeText(app, "/team merge");
    await press(app, () => app.mockInput.pressEnter());
    expect(executed[0]).toMatchObject({ type: "merge", enabled: true, taskId: "task_live" });
  } finally {
    app.renderer.destroy();
  }
});

test("keyboard changes focus with Tab and Shift+Tab", async () => {
  const app = await mountSurface(teamLiveFixture());

  try {
    expect(app.captureCharFrame()).toContain("[teams]");

    await press(app, () => app.mockInput.pressTab());
    expect(app.captureCharFrame()).toContain("[runs]");

    await press(app, () => app.mockInput.pressTab({ shift: true }));
    expect(app.captureCharFrame()).toContain("[teams]");
  } finally {
    app.renderer.destroy();
  }
});

test("keyboard opens detail and Esc closes it", async () => {
  const app = await mountSurface(teamLiveFixture(), { width: 80, height: 24 });

  try {
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("Detail");
    expect(app.captureCharFrame()).toContain("lead:/root");

    await press(app, () => app.mockInput.pressEscape());
    expect(app.captureCharFrame()).toContain("Teams");
    expect(app.captureCharFrame()).not.toContain("lead:/root");
  } finally {
    app.renderer.destroy();
  }
});

test("keyboard opens and closes help", async () => {
  const app = await mountSurface(teamLiveFixture());

  try {
    await press(app, () => app.mockInput.pressKey("?"));
    expect(app.captureCharFrame()).toContain("Team Live Help");

    await press(app, () => app.mockInput.pressEscape());
    expect(app.captureCharFrame()).not.toContain("Team Live Help");
  } finally {
    app.renderer.destroy();
  }
});

test("approve action asks for confirmation before SDK action", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountSurface(teamLiveFixture(), { executed });

  try {
    await press(app, () => app.mockInput.pressKey("a"));
    expect(app.captureCharFrame()).toContain("Approve pending permission?");
    expect(executed).toHaveLength(0);

    await press(app, () => app.mockInput.pressEnter());
    expect(executed[0]?.type).toBe("approve");
  } finally {
    app.renderer.destroy();
  }
});

test("reject action asks for confirmation before SDK action", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountSurface(teamLiveFixture(), { executed });

  try {
    await press(app, () => app.mockInput.pressKey("x"));
    expect(app.captureCharFrame()).toContain("Reject pending permission?");
    expect(executed).toHaveLength(0);

    await press(app, () => app.mockInput.pressEnter());
    expect(executed[0]?.type).toBe("reject");
  } finally {
    app.renderer.destroy();
  }
});

test("merge action asks for confirmation before SDK action and Esc cancels", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountSurface(teamLiveFixture(), { executed });

  try {
    await press(app, () => app.mockInput.pressKey("m"));
    expect(app.captureCharFrame()).toContain("Merge task worktree?");
    await press(app, () => app.mockInput.pressEscape());
    expect(executed).toHaveLength(0);
    expect(app.captureCharFrame()).not.toContain("Merge task worktree?");

    await press(app, () => app.mockInput.pressKey("m"));
    await press(app, () => app.mockInput.pressEnter());
    expect(executed[0]?.type).toBe("merge");
  } finally {
    app.renderer.destroy();
  }
});

test("merge hotkey stays bound to the selected task", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountSurface(withMergeActionOnSecondTask(), { executed });

  try {
    await press(app, () => app.mockInput.pressKey("m"));
    expect(app.captureCharFrame()).not.toContain("Merge task worktree?");
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      type: "merge",
      taskId: "task_without_merge",
      enabled: false,
      reason: "no_selected_merge",
    });
  } finally {
    app.renderer.destroy();
  }
});

test("approval hotkey stays bound to the selected approval", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountSurface(withApprovalActionOnSecondApproval(), { executed });

  try {
    await press(app, () => app.mockInput.pressKey("a"));
    expect(app.captureCharFrame()).not.toContain("Approve pending permission?");
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      type: "approve",
      approvalId: "approval_without_action",
      enabled: false,
      reason: "action_unavailable",
    });
  } finally {
    app.renderer.destroy();
  }
});

test("keyboard keeps task selection visible past the first window", async () => {
  const app = await mountSurface(withManyTasks(teamLiveFixture()), { width: 120, height: 40 });

  try {
    await press(app, () => app.mockInput.pressTab());
    await press(app, () => app.mockInput.pressTab());
    await press(app, () => app.mockInput.pressTab());
    for (let index = 0; index < 15; index += 1) {
      await press(app, () => app.mockInput.pressArrow("down"));
    }

    const frame = app.captureCharFrame();
    expect(frame).toContain("[Task Board 5-16/16]");
    expect(frame).toContain("Task row 16");
  } finally {
    app.renderer.destroy();
  }
});

async function mountSurface(
  model: TeamLiveView,
  options: {
    width?: number;
    height?: number;
    executed?: TeamLiveAction[];
  } = {},
) {
  const runtime: TeamLiveSurfaceRuntime = {
    message: "test stream",
    reconnect: () => undefined,
    executeAction: (action) => {
      options.executed?.push(action);
    },
    clearActionFeedback: () => undefined,
  };

  const app = await testRender(
    <TeamLiveSurface
      model={model}
      runtime={runtime}
      selectedTeamId={model.selectedTeamId}
      selectedTeamLocked={false}
      onSelectTeam={() => undefined}
      onExit={() => undefined}
      theme={chiliDarkTheme}
    />,
    { width: options.width ?? 120, height: options.height ?? 40, exitOnCtrlC: false },
  );
  await act(async () => {
    await app.renderOnce();
  });
  return app;
}

async function mountShell(
  model: TeamLiveView,
  options: {
    width?: number;
    height?: number;
    executed?: TeamLiveAction[];
    runtime?: Partial<ChatRuntimeState>;
    clipboard?: ClipboardAccess;
    kittyKeyboard?: boolean;
    useMouse?: boolean;
    localMessageTtlMs?: number;
    cwd?: string;
    skills?: readonly SkillSummary[];
    allSkills?: readonly SkillSummary[];
    onSkillsChanged?: () => Promise<void> | void;
    onExit?: (info?: ChatShellExitInfo) => void;
  } = {},
) {
  const runtime: ChatRuntimeState = {
    runtimeView: createRuntimeView(),
    revision: 0,
    connection: model.connection,
    message: "test stream",
    reconnect: () => undefined,
    executeAction: (action) => {
      options.executed?.push(action);
    },
    clearActionFeedback: () => undefined,
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
    approveApproval: async () => undefined,
    rejectApproval: async () => undefined,
    ...options.runtime,
  };

  const renderOptions = {
    width: options.width ?? 120,
    height: options.height ?? 40,
    exitOnCtrlC: false,
    ...(options.kittyKeyboard === undefined ? {} : { kittyKeyboard: options.kittyKeyboard }),
    ...(options.useMouse === undefined ? {} : { useMouse: options.useMouse }),
  };
  const app = await testRender(
    <ChatShellSurface
      model={model}
      runtime={runtime}
      selectedTeamId={model.selectedTeamId}
      selectedTeamLocked={false}
      onSelectTeam={() => undefined}
      onExit={options.onExit ?? (() => undefined)}
      options={{ cwd: options.cwd ?? "/repo/chili", modeName: "Build", modelName: "test-model", providerName: "test-provider" }}
      clipboard={options.clipboard}
      localMessageTtlMs={options.localMessageTtlMs}
      skills={options.skills}
      allSkills={options.allSkills}
      onSkillsChanged={options.onSkillsChanged}
    />,
    renderOptions,
  );
  await act(async () => {
    await app.renderOnce();
  });
  return app;
}

async function mountStatefulShell(
  model: TeamLiveView,
  options: {
    width?: number;
    height?: number;
    executed?: TeamLiveAction[];
    runtime?: Partial<ChatRuntimeState>;
    clipboard?: ClipboardAccess;
  } = {},
) {
  const initialRuntime = chatRuntime(model, options);
  let setRuntime: Dispatch<SetStateAction<ChatRuntimeState>> | undefined;

  function StatefulShell() {
    const [runtime, updateRuntime] = useState<ChatRuntimeState>(initialRuntime);
    setRuntime = updateRuntime;
    return (
      <ChatShellSurface
        model={model}
        runtime={runtime}
        selectedTeamId={model.selectedTeamId}
        selectedTeamLocked={false}
        onSelectTeam={() => undefined}
        onExit={() => undefined}
        options={{ cwd: "/repo/chili", modeName: "Build", modelName: "test-model", providerName: "test-provider" }}
        clipboard={options.clipboard}
      />
    );
  }

  const app = await testRender(<StatefulShell />, {
    width: options.width ?? 120,
    height: options.height ?? 40,
    exitOnCtrlC: false,
  });
  await act(async () => {
    await app.renderOnce();
  });

  return {
    ...app,
    setRuntime: (update: SetStateAction<ChatRuntimeState>) => {
      if (!setRuntime) throw new Error("stateful shell runtime setter was not initialized");
      setRuntime(update);
    },
  };
}

function chatRuntime(
  model: TeamLiveView,
  options: {
    executed?: TeamLiveAction[];
    runtime?: Partial<ChatRuntimeState>;
  } = {},
): ChatRuntimeState {
  return {
    runtimeView: createRuntimeView(),
    revision: 0,
    connection: model.connection,
    message: "test stream",
    reconnect: () => undefined,
    executeAction: (action) => {
      options.executed?.push(action);
    },
    clearActionFeedback: () => undefined,
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
    approveApproval: async () => undefined,
    rejectApproval: async () => undefined,
    ...options.runtime,
  };
}

function fakeClipboard(overrides: Partial<ClipboardAccess> = {}): ClipboardAccess {
  return {
    readText: async () => "",
    readImage: async () => undefined,
    writeText: async () => true,
    ...overrides,
  };
}

function skillSummary(name: string, options: Partial<Pick<SkillSummary, "source" | "description" | "filePath" | "baseDir" | "hidden" | "disabled">> = {}): SkillSummary {
  const source = options.source ?? "project";
  const baseDir = options.baseDir ?? `/repo/.chili/skills/${name}`;
  return {
    name,
    source,
    description: options.description ?? `${name} skill`,
    filePath: options.filePath ?? `${baseDir}/SKILL.md`,
    baseDir,
    ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
    ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
  };
}

function emitSelection(renderer: { emit: (event: string, ...args: unknown[]) => boolean }, text: string): void {
  renderer.emit("selection", { getSelectedText: () => text });
}

function expectFramedModelSearch(frame: string): void {
  const lines = frame.split("\n");
  const searchLine = lines.findIndex((line) => line.includes("Search  >"));
  expect(searchLine).toBeGreaterThan(0);
  expect(lines[searchLine - 1] ?? "").toContain("┌");
  expect(lines[searchLine] ?? "").toContain("│");
  expect(lines[searchLine + 1] ?? "").toContain("└");
}

function frameTextPosition(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n");
  for (const [y, line] of lines.entries()) {
    const index = line.indexOf(text);
    if (index >= 0) return { x: Bun.stringWidth(line.slice(0, index)), y };
  }
  throw new Error(`Frame did not include ${text}`);
}

function selectionBgAt(app: { renderer: { currentRenderBuffer: { width: number; buffers: { bg: Float32Array } } } }, x: number, y: number): boolean {
  const width = app.renderer.currentRenderBuffer.width;
  const bg = app.renderer.currentRenderBuffer.buffers.bg;
  const offset = (y * width + x) * 4;
  const [r, g, b, a] = hexRgba(chiliDarkTheme.colors.menu.selectedBackground);
  return Math.abs((bg[offset] ?? 0) - r) < 0.001
    && Math.abs((bg[offset + 1] ?? 0) - g) < 0.001
    && Math.abs((bg[offset + 2] ?? 0) - b) < 0.001
    && Math.abs((bg[offset + 3] ?? 0) - a) < 0.001;
}

function foregroundMatches(
  app: { renderer: { currentRenderBuffer: { width: number; buffers: { fg: Float32Array } } } },
  x: number,
  y: number,
  color: string,
): boolean {
  const width = app.renderer.currentRenderBuffer.width;
  const fg = app.renderer.currentRenderBuffer.buffers.fg;
  const offset = (y * width + x) * 4;
  const [r, g, b, a] = hexRgba(color);
  return Math.abs((fg[offset] ?? 0) - r) < 0.001
    && Math.abs((fg[offset + 1] ?? 0) - g) < 0.001
    && Math.abs((fg[offset + 2] ?? 0) - b) < 0.001
    && Math.abs((fg[offset + 3] ?? 0) - a) < 0.001;
}

function hexRgba(hex: string): [number, number, number, number] {
  const value = hex.replace(/^#/, "");
  const r = Number.parseInt(value.slice(0, 2), 16) / 255;
  const g = Number.parseInt(value.slice(2, 4), 16) / 255;
  const b = Number.parseInt(value.slice(4, 6), 16) / 255;
  return [r, g, b, 1];
}

async function mountChatApp(
  client: HttpRuntimeClient,
  options: {
    sessionId?: SessionId;
    threadId?: ThreadId;
  } = {},
) {
  const app = await testRender(
    <ChatShellApp
      client={client}
      options={{
        baseUrl: "http://runtime.test",
        cwd: "/repo/chili",
        runLoop: false,
        once: false,
        ...options,
      }}
      onExit={() => undefined}
    />,
    { width: 120, height: 40, exitOnCtrlC: false },
  );
  await act(async () => {
    await app.renderOnce();
  });
  return app;
}

type TestRenderHarness = Awaited<ReturnType<typeof testRender>>;

async function press(app: TestRenderHarness, input: () => void): Promise<void> {
  act(() => {
    input();
  });
  await Bun.sleep(60);
  await app.renderOnce();
}

async function typeText(app: TestRenderHarness, text: string): Promise<void> {
  await act(async () => {
    await app.mockInput.typeText(text);
  });
  await Bun.sleep(60);
  await app.renderOnce();
}

async function selectPaletteCommand(app: TestRenderHarness, command: string): Promise<void> {
  for (let index = 0; index < 64; index += 1) {
    if (app.captureCharFrame().includes(`> ${command}`)) return;
    await press(app, () => app.mockInput.pressArrow("down"));
  }
  expect(app.captureCharFrame()).toContain(`> ${command}`);
}

async function backspace(app: TestRenderHarness, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await press(app, () => app.mockInput.pressBackspace());
  }
}

function chatClientRecords(): {
  create: Array<Record<string, unknown>>;
  submit: Array<Record<string, unknown>>;
  interrupt: Array<Record<string, unknown>>;
  approve: Array<Record<string, unknown>>;
  reject: Array<Record<string, unknown>>;
  listModels: Array<Record<string, unknown>>;
  getModel: Array<Record<string, unknown>>;
  setModel: Array<Record<string, unknown>>;
  setReasoning: Array<Record<string, unknown>>;
  stream: Array<Record<string, unknown>>;
} {
  return {
    create: [],
    submit: [],
    interrupt: [],
    approve: [],
    reject: [],
    listModels: [],
    getModel: [],
    setModel: [],
    setReasoning: [],
    stream: [],
  };
}

function fakeChatClient(
  records: ReturnType<typeof chatClientRecords>,
  events: readonly ChiliEvent[] = [],
  options: {
    createError?: Error;
    approveResolved?: boolean;
    rejectResolved?: boolean;
    models?: readonly ModelCandidate[];
    modelSelection?: ModelSelection;
    reasoningLevel?: ReasoningLevel;
    setModelError?: Error;
    setReasoningError?: Error;
  } = {},
): HttpRuntimeClient {
  let currentModelSelection = options.modelSelection;
  let currentReasoningLevel = options.reasoningLevel;
  const client = {
    listModels: async (input: Record<string, unknown> = {}) => {
      records.listModels.push(input);
      return [...(options.models ?? [])];
    },
    getModelConfig: async (input: Record<string, unknown>) => {
      records.getModel.push(input);
      const config = {
        sessionId: input.sessionId as SessionId,
        models: [...(options.models ?? [])],
        availableReasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
        ...(currentModelSelection ? { modelSelection: currentModelSelection } : {}),
        ...(currentReasoningLevel ? { reasoningLevel: currentReasoningLevel } : {}),
      };
      return config;
    },
    setModel: async (input: Record<string, unknown>) => {
      records.setModel.push(input);
      if (options.setModelError) throw options.setModelError;
      currentModelSelection = input.modelSelection as ModelSelection;
      return {
        sessionId: input.sessionId as SessionId,
        models: [...(options.models ?? [])],
        availableReasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
        modelSelection: currentModelSelection,
        ...(currentReasoningLevel ? { reasoningLevel: currentReasoningLevel } : {}),
      };
    },
    setReasoning: async (input: Record<string, unknown>) => {
      records.setReasoning.push(input);
      if (options.setReasoningError) throw options.setReasoningError;
      currentReasoningLevel = input.reasoningLevel as ReasoningLevel;
      return {
        sessionId: input.sessionId as SessionId,
        models: [...(options.models ?? [])],
        availableReasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
        ...(currentModelSelection ? { modelSelection: currentModelSelection } : {}),
        reasoningLevel: currentReasoningLevel,
      };
    },
    createSession: async (input: Record<string, unknown> = {}) => {
      const index = records.create.length + 1;
      records.create.push(input);
      if (options.createError) throw options.createError;
      const suffix = index === 1 ? "" : `_${index}`;
      return { sessionId: `session_created${suffix}` as SessionId, threadId: `thread_created${suffix}` as ThreadId };
    },
    sessionEvents: async (input: Record<string, unknown>) => events.filter((event) => event.sessionId === input.sessionId),
    listSessions: async () => [],
    renameSession: async (input: Record<string, unknown>) => ({
      id: input.sessionId as SessionId,
      cwd: "/repo/chili",
      title: input.title as string,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 2,
    }),
    submitPromptAsync: async (input: Record<string, unknown>) => {
      records.submit.push(input);
      return { status: "accepted", sessionId: input.sessionId as SessionId, threadId: input.threadId as ThreadId };
    },
    submitCommandAsync: async (input: Record<string, unknown>) => {
      records.submit.push(input);
      return { status: "accepted", sessionId: input.sessionId as SessionId, threadId: input.threadId as ThreadId };
    },
    submitPrompt: async () => ({ status: "completed", turns: [] }),
    listCommands: async () => ({
      commands: [],
      diagnostics: [],
      directories: [],
      skippedConflicts: [],
    }),
    reloadCommands: async () => ({
      commands: [],
      diagnostics: [],
      directories: [],
      skippedConflicts: [],
    }),
    interruptSession: async (input: Record<string, unknown>) => {
      records.interrupt.push(input);
      return { interrupted: true };
    },
    approveApproval: async (input: Record<string, unknown>) => {
      records.approve.push(input);
      return { resolved: options.approveResolved ?? true };
    },
    rejectApproval: async (input: Record<string, unknown>) => {
      records.reject.push(input);
      return { resolved: options.rejectResolved ?? true };
    },
    streamEvents: async function* (input: { signal?: AbortSignal } = {}) {
      records.stream.push(input);
      for (const event of events) {
        if (input.signal?.aborted) return;
        yield event;
      }
      await waitForAbort(input.signal);
    },
    runTeamLoop: async () => ({
      teamId: "team_test",
      cycles: 0,
      stopReason: "once",
      startedAt: 0,
      endedAt: 0,
      maxConcurrentVerifications: 2,
      dispatched: [],
      completed: [],
      accepted: [],
      reopened: [],
      merged: [],
      mergeFailed: [],
      mergeConflicted: [],
      mergeSkipped: [],
      failed: [],
      blocked: [],
      skipped: [],
      stillRunning: [],
      errors: [],
    }),
    mergeTeamTasks: async () => ({
      scanned: 0,
      applied: [],
      failed: [],
      conflicted: [],
      skipped: [],
      errors: [],
    }),
  };
  return client as unknown as HttpRuntimeClient;
}

function approvalEvents(sessionId: SessionId, threadId: ThreadId, approvalId: ApprovalId): ChiliEvent[] {
  const callId = "toolcall_stale" as ToolCallId;
  return [
    {
      id: "event_stale_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, cwd: "/repo/chili" },
    },
    {
      id: "event_stale_tool",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
      payload: { turnId: "turn_stale" as TurnId, callId, toolName: "bash", input: { command: "ls -la" } },
    },
    {
      id: "event_stale_waiting",
      type: "tool.call_updated",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: { callId, status: "waiting_for_approval" },
    },
    {
      id: "event_stale_approval",
      type: "approval.requested",
      time: 4 as TimestampMs,
      sessionId,
      threadId,
      payload: { approvalId, callId, permission: "bash", patterns: ["ls -la"] },
    },
  ];
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

function chatTextMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
): Extract<ChatTranscriptItem, { kind: "message" }> {
  return {
    id: id as MessageId,
    kind: "message",
    role,
    createdAt,
    parts: [{ type: "text", id: `${id}_part` as PartId, text }],
  };
}

function rawOutputToolItems(lineCount: number): ChatTranscriptItem[] {
  const output = Array.from({ length: lineCount }, (_, index) => `raw_line_${String(index + 1).padStart(2, "0")}`).join("\n");
  return [
    {
      id: "tool_scroll_raw" as ToolCallId,
      kind: "tool",
      toolName: "bash",
      status: "completed",
      displayStatus: "succeeded",
      waitingForApproval: false,
      updatedAt: 1,
      inputSummary: { title: "bash", command: "bun test", detail: "bun test" },
      input: { command: "bun test" },
      output,
    },
  ];
}

function transcriptCopyItems(): ChatTranscriptItem[] {
  const callId = "tool_copy_transcript" as ToolCallId;
  return [
    {
      id: "msg_copy_transcript" as MessageId,
      kind: "message",
      role: "assistant",
      createdAt: 1,
      parts: [
        { type: "text", id: "part_copy_transcript" as PartId, text: "copy transcript reply" },
      ],
    },
    {
      id: callId,
      kind: "tool",
      toolName: "bash",
      status: "completed",
      displayStatus: "succeeded",
      waitingForApproval: false,
      updatedAt: 2,
      inputSummary: { title: "bash", command: "bun test", detail: "bun test" },
      input: { command: "bun test" },
      output: "RAW_COPY_OUTPUT",
    },
  ];
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function withRunLoopReady(view: TeamLiveView): TeamLiveView {
  const selected = requireSelected(view);
  const teamId = requireTeamId(view);
  const actions: TeamLiveAction[] = [
    { type: "run_loop", teamId, enabled: true },
    ...selected.availableActions.filter((action) => action.type !== "run_loop"),
  ];
  return {
    ...view,
    availableActions: actions,
    selected: {
      ...selected,
      availableActions: actions,
    },
  };
}

function withMergeActionOnSecondTask(): TeamLiveView {
  const view = teamLiveFixture();
  const selected = requireSelected(view);
  const baseTask = requireFirst(selected.tasks);
  const teamId = requireTeamId(view);
  const firstTaskId = "task_without_merge" as TaskId;
  const secondTaskId = "task_with_merge" as TaskId;
  const { merge: _merge, ...taskWithoutMerge } = baseTask;
  const firstTask = {
    ...taskWithoutMerge,
    id: firstTaskId,
    title: "Selected task without merge",
    metadata: withoutMergeMetadata(baseTask.metadata),
  };
  const secondTask = {
    ...baseTask,
    id: secondTaskId,
    title: "Second task with merge",
    merge: { ...requireFirst(selected.mergeQueue), taskId: secondTaskId, title: "Second task with merge" },
  };
  const actions: TeamLiveAction[] = [
    { type: "merge", teamId, taskId: secondTaskId, enabled: true },
  ];

  return {
    ...view,
    availableActions: actions,
    selected: {
      ...selected,
      tasks: [firstTask, secondTask],
      mergeQueue: [secondTask.merge],
      availableActions: actions,
    },
  };
}

function withApprovalActionOnSecondApproval(): TeamLiveView {
  const view = teamLiveFixture();
  const selected = requireSelected(view);
  const baseApproval = requireFirst(selected.pendingApprovals);
  const sessionId = baseApproval.sessionId;
  if (!sessionId) throw new Error("fixture requires approval session");
  const firstApprovalId = "approval_without_action" as ApprovalId;
  const secondApprovalId = "approval_with_action" as ApprovalId;
  const firstApproval = { ...baseApproval, id: firstApprovalId, toolName: "first-edit" };
  const secondApproval = { ...baseApproval, id: secondApprovalId, toolName: "second-edit" };
  const actions: TeamLiveAction[] = [
    { type: "approve", approvalId: secondApprovalId, sessionId, enabled: true },
    { type: "reject", approvalId: secondApprovalId, sessionId, enabled: true },
  ];

  return {
    ...view,
    availableActions: actions,
    selected: {
      ...selected,
      pendingApprovals: [firstApproval, secondApproval],
      availableActions: actions,
    },
  };
}

function withManyTasks(view: TeamLiveView): TeamLiveView {
  const selected = requireSelected(view);
  const baseTask = requireFirst(selected.tasks);
  return {
    ...view,
    selected: {
      ...selected,
      tasks: Array.from({ length: 16 }, (_, index) => ({
        ...baseTask,
        id: `task_window_${index + 1}` as TaskId,
        title: `Task row ${String(index + 1).padStart(2, "0")}`,
      })),
    },
  };
}

function withoutMergeMetadata(metadata: NonNullable<TeamLiveView["selected"]>["tasks"][number]["metadata"]) {
  const { merge: _metadataMerge, ...rest } = metadata;
  return rest;
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
