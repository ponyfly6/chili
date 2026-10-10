import { expect, test } from "bun:test";
import type { HistoryMessage } from "@chili/protocol";
import { mergeHistoryParts, conversationTasks, isProcessPart, processSummary } from "./conversation-timeline-model.js";

const message = (id: string, workId: string, role: HistoryMessage["role"] = "assistant"): HistoryMessage => ({ id, workId, sessionId: "s", role, createdAt: 1, parts: [{ id: `${id}_text`, type: "text", text: id, hasMore: false }] });
test("loading an earlier page extends the same task without reordering supplements or requiring the whole task", () => {
  const live = [message("progress", "original"), message("supplement", "original", "user"), message("answer", "original"), message("next", "next", "user")];
  const recent = conversationTasks(live);
  expect(recent.map((task) => task.id)).toEqual(["original", "next"]);
  expect(conversationTasks([message("original", "original", "user"), ...live])[0]?.messages.map((item) => item.id)).toEqual(["original", "progress", "supplement", "answer"]);
  expect(recent[0]?.messages.map((item) => item.id)).toEqual(["progress", "supplement", "answer"]);
});
test("progress and final answers stay readable while tools and reasoning form one process", () => {
  expect(isProcessPart({ id: "p", type: "text", text: "progress", phase: "commentary", hasMore: false })).toBe(false);
  expect(isProcessPart({ id: "p", type: "text", text: "answer", phase: "final_answer", hasMore: false })).toBe(false);
  expect(isProcessPart({ id: "p", type: "reasoning", text: "thinking", hasMore: false })).toBe(true);
  expect(processSummary([{ id: "p", type: "tool_call", callId: "call", toolName: "bash", status: "running", subject: "运行测试", text: "", hasMore: true }])).toBe("运行命令 · 运行测试");
});
test("tool call and result share one display entry across page boundaries", () => {
  const first = message("first", "task");
  first.parts = [{ id: "call_part", type: "tool_call", callId: "call", text: "", hasMore: true }];
  const second = message("second", "task", "tool"); second.parts = [{ ...first.parts[0]!, id: "result_part", type: "tool_result" }];
  expect(conversationTasks([first, second])[0]?.messages.flatMap((item) => item.parts)).toHaveLength(1);
});

test("loaded mixed parts stay in their task process after refresh, without losing later pages", () => {
  const base = message("mixed", "task"); base.nextPartOffset = 32;
  const extra: HistoryMessage = { ...base, nextPartOffset: 64, parts: [...base.parts, { id: "tool", type: "tool_call", callId: "call", status: "completed", hasMore: true, text: "" }] };
  const refreshed = { ...base, parts: [{ ...base.parts[0]!, text: "updated" }] };
  const merged = mergeHistoryParts(refreshed, extra);
  expect(merged.nextPartOffset).toBe(64);
  expect(merged.parts.map((part) => part.id)).toEqual(["mixed_text", "tool"]);
  expect(merged.parts[0]?.text).toBe("updated");
  expect(conversationTasks([merged])[0]?.messages[0]?.parts.filter(isProcessPart)).toHaveLength(1);
  const { nextPartOffset: _, ...complete } = extra;
  expect(mergeHistoryParts(base, complete).nextPartOffset).toBeUndefined();
  expect(mergeHistoryParts({ ...base, partCount: 3 }, complete).nextPartOffset).toBe(2);
});
