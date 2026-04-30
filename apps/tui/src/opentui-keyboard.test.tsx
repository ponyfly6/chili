import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState, type Dispatch, type SetStateAction } from "react";
import { createRuntimeView, type ChatTranscriptItem, type HttpRuntimeClient, type TeamLiveAction, type TeamLiveView } from "@chili/sdk";
import type { ApprovalId, ChiliEvent, MessageId, PartId, SessionId, TaskId, ThreadId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import type { ClipboardAccess } from "./clipboard.js";
import { ChatShellApp, ChatShellSurface } from "./ChatShellApp.js";
import { TeamLiveSurface } from "./TeamLiveApp.js";
import type { ChatRuntimeState } from "./useChatRuntime.js";
import type { TeamLiveSurfaceRuntime } from "./components/types.js";
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
    expect(app.captureCharFrame()).toContain("Session running - ctrl+x interrupt");
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
    expect(app.captureCharFrame()).toContain("from clipboard");

    await press(app, () => app.mockInput.pressEnter());
    expect(submitted).toEqual(["from clipboard"]);
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

    expect(app.captureCharFrame()).toContain("terminal paste");

    await press(app, () => app.mockInput.pressEnter());
    expect(submitted).toEqual(["terminal paste"]);
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
    await press(app, () => app.mockInput.pressKey("y", { ctrl: true }));
    await press(app, () => app.mockInput.pressKey("y", { ctrl: true }));
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

    await press(app, () => app.mockInput.pressArrow("up", { shift: true }));
    await press(app, () => app.mockInput.pressArrow("up", { shift: true }));
    expect(app.captureCharFrame()).toContain("message 01");
    expect(app.captureCharFrame()).not.toContain("scroll history");

    await press(app, () => app.mockInput.pressArrow("down", { shift: true }));
    await press(app, () => app.mockInput.pressArrow("down", { shift: true }));
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
    await press(app, () => app.mockInput.pressKey("y", { ctrl: true }));
    await press(app, () => app.mockInput.pressKey("y", { ctrl: true }));
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
    expect(frame).toContain("Session running - ctrl+x interrupt");
    expect(frame).not.toContain("saved prompt");
  } finally {
    app.renderer.destroy();
  }
});

test("pending approval renders the approval dock and shortcuts resolve it", async () => {
  const approved: ApprovalId[] = [];
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
          },
        ],
        activeTools: [],
        generatedAt: "1970-01-01T00:00:00.000Z",
      },
      approveApproval: async (id) => {
        approved.push(id);
      },
      rejectApproval: async (id) => {
        rejected.push(id);
      },
    },
  });

  try {
    expect(app.captureCharFrame()).toContain("tool.bash");
    expect(app.captureCharFrame()).toContain("waiting_permission");
    expect(app.captureCharFrame()).toContain("command: bun test");
    expect(app.captureCharFrame()).toContain("a approve once | x reject");

    await press(app, () => app.mockInput.pressKey("a"));
    expect(approved).toEqual([approvalId]);

    await press(app, () => app.mockInput.pressKey("x"));
    expect(rejected).toEqual([approvalId]);
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
    expect(app.captureCharFrame()).toContain("Approval is no longer pending");
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
    await press(app, () => app.mockInput.pressArrow("down"));
    await press(app, () => app.mockInput.pressArrow("down"));
    await press(app, () => app.mockInput.pressArrow("down"));
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
    chatView: { status: "idle", items: [], pendingApprovals: [], activeTools: [], generatedAt: "1970-01-01T00:00:00.000Z" },
    canSubmit: true,
    submitPrompt: async () => true,
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
  };
  const app = await testRender(
    <ChatShellSurface
      model={model}
      runtime={runtime}
      selectedTeamId={model.selectedTeamId}
      selectedTeamLocked={false}
      onSelectTeam={() => undefined}
      onExit={() => undefined}
      options={{ cwd: "/repo/chili", modeName: "Build", modelName: "test-model", providerName: "test-provider" }}
      clipboard={options.clipboard}
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
    chatView: { status: "idle", items: [], pendingApprovals: [], activeTools: [], generatedAt: "1970-01-01T00:00:00.000Z" },
    canSubmit: true,
    submitPrompt: async () => true,
    interruptActiveSession: async () => undefined,
    approveApproval: async () => undefined,
    rejectApproval: async () => undefined,
    ...options.runtime,
  };
}

function fakeClipboard(overrides: Partial<ClipboardAccess> = {}): ClipboardAccess {
  return {
    readText: async () => "",
    writeText: async () => true,
    ...overrides,
  };
}

function emitSelection(renderer: { emit: (event: string, ...args: unknown[]) => boolean }, text: string): void {
  renderer.emit("selection", { getSelectedText: () => text });
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

function chatClientRecords(): {
  create: Array<Record<string, unknown>>;
  submit: Array<Record<string, unknown>>;
  interrupt: Array<Record<string, unknown>>;
  approve: Array<Record<string, unknown>>;
  reject: Array<Record<string, unknown>>;
} {
  return { create: [], submit: [], interrupt: [], approve: [], reject: [] };
}

function fakeChatClient(
  records: ReturnType<typeof chatClientRecords>,
  events: readonly ChiliEvent[] = [],
  options: { createError?: Error; approveResolved?: boolean; rejectResolved?: boolean } = {},
): HttpRuntimeClient {
  const client = {
    createSession: async (input: Record<string, unknown> = {}) => {
      records.create.push(input);
      if (options.createError) throw options.createError;
      return { sessionId: "session_created" as SessionId, threadId: "thread_created" as ThreadId };
    },
    submitPromptAsync: async (input: Record<string, unknown>) => {
      records.submit.push(input);
      return { status: "accepted", sessionId: input.sessionId as SessionId, threadId: input.threadId as ThreadId };
    },
    submitPrompt: async () => ({ status: "completed", turns: [] }),
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
