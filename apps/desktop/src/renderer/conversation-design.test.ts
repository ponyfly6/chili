import { expect, test } from "bun:test";
import type { DesktopTimelineItem } from "./view-model.js";
import { createRuntimeView } from "@chili/sdk";
import { completedResults, conversationTitle, matchingDesktopCommands, parseReadingPreferences } from "./conversation-design.js";

test("slash commands only intercept a single local command, preserving ordinary prompts", () => {
  expect(matchingDesktopCommands("/mo").map((command) => command.id)).toEqual(["model"]);
  expect(matchingDesktopCommands("/MODEL").map((command) => command.id)).toEqual(["model"]);
  expect(matchingDesktopCommands("/review this folder")).toEqual([]);
  expect(matchingDesktopCommands("Please check /settings")).toEqual([]);
  expect(matchingDesktopCommands("/unknown")).toEqual([]);
});

test("result view excludes streamed answers, commentary, reasoning, and tool output", () => {
  const message = (id: string, parts: unknown[], completedAt?: number) => ({ id, kind: "message", role: "assistant", parts, createdAt: 1, completedAt });
  const items = [
    message("working", [{ id: "a", type: "text", text: "Working", phase: "commentary" }], 2),
    message("stream", [{ id: "b", type: "text", text: "Incomplete" }]),
    message("done", [
      { id: "c", type: "text", text: "Finished", phase: "final_answer" },
      { id: "d", type: "reasoning", text: "Reasoning" },
      { id: "e", type: "tool_result", output: "Internal" },
    ], 3),
  ] as DesktopTimelineItem[];
  expect(completedResults(items)).toEqual([{ id: "done", text: "Finished" }]);
});

test("first message titles preserve whole Unicode characters and avoid long multiline titles", () => {
  expect(conversationTitle("  做一个花店网站\n自然简洁  ")).toBe("做一个花店网站");
  expect(Array.from(conversationTitle("🌶".repeat(60)))).toHaveLength(36);
  expect(conversationTitle(" ")).toBe("新会话");
});

test("providers that only complete a turn produce results; running or failed turns do not", () => {
  const runtime = createRuntimeView();
  runtime.messages.answer = { id: "answer" as never, sessionId: "session" as never, turnId: "turn" as never,
    role: "assistant", createdAt: 1, parts: [] };
  const items: DesktopTimelineItem[] = [{ id: "answer" as never, kind: "message", role: "assistant", createdAt: 1,
    parts: [{ id: "text" as never, type: "text", text: "Completed reply" }] }];
  for (const status of ["running", "failed", "cancelled"] as const) {
    runtime.turnStatuses.turn = status;
    expect(completedResults(items, runtime)).toEqual([]);
  }
  runtime.turnStatuses.turn = "completed";
  expect(completedResults(items, runtime)).toEqual([{ id: "answer", text: "Completed reply" }]);
});

test("reading preferences recover safely from old or invalid local values", () => {
  expect(parseReadingPreferences(null)).toEqual({ autoResult: true, expandWork: false });
  expect(parseReadingPreferences({ autoResult: false, expandWork: true })).toEqual({ autoResult: false, expandWork: true });
  expect(parseReadingPreferences({ autoResult: "false", expandWork: 1 })).toEqual({ autoResult: true, expandWork: false });
});

test("a tool-using turn contributes only its final answer to result history", () => {
  const runtime = createRuntimeView();
  const items: DesktopTimelineItem[] = [];
  for (const [id, turnId, text] of [
    ["plan", "first", "I will read the brief."],
    ["answer", "first", "Created welcome.md."],
    ["followup", "second", "Updated welcome.md."],
  ] as const) {
    runtime.messages[id] = { id: id as never, sessionId: "session" as never, turnId: turnId as never,
      role: "assistant", createdAt: 1, parts: [] };
    runtime.turnStatuses[turnId] = "completed";
    items.push({ id: id as never, kind: "message", role: "assistant", createdAt: 1,
      parts: [{ id: `text-${id}` as never, type: "text", text }] });
  }
  expect(completedResults(items, runtime)).toEqual([
    { id: "answer", text: "Created welcome.md." },
    { id: "followup", text: "Updated welcome.md." },
  ]);
});

test("completed internal tool rounds are not mistaken for completed user-facing results", () => {
  const runtime = createRuntimeView();
  runtime.messages.working = { id: "working" as never, sessionId: "session" as never, turnId: "tool-round" as never,
    role: "assistant", createdAt: 1, parts: [{ id: "call-part" as never, messageId: "working" as never, sessionId: "session" as never,
      type: "tool_call", callId: "call" as never, toolName: "edit", input: {}, status: "completed" }] };
  runtime.turnStatuses["tool-round"] = "completed";
  const items: DesktopTimelineItem[] = [{ id: "working" as never, kind: "message", role: "assistant", createdAt: 1,
    parts: [{ id: "text" as never, type: "text", text: "I'll update the file now." }] }];
  expect(completedResults(items, runtime)).toEqual([]);
});
