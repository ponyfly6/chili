import { expect, test } from "bun:test";
import type { ChatMessageRow, ChatSessionView, ChatToolCallRow, ChiliRuntimeView } from "@chili/sdk";
import { desktopTimelineItems, type DesktopWorkItem } from "./view-model.js";
import { workCurrentDetail, workHeadline, workStages } from "./work-presentation.js";

const user = (id: string, createdAt = 1): ChatMessageRow => ({
  id: id as never, kind: "message", role: "user", createdAt,
  parts: [{ id: `${id}_text` as never, type: "text", text: "Inspect the project." }],
});
const assistant = (id: string, text: string, phase?: "commentary" | "final_answer"): ChatMessageRow => ({
  id: id as never, kind: "message", role: "assistant", createdAt: 2,
  parts: [{ id: `${id}_text` as never, type: "text", text, ...(phase ? { phase } : {}) }],
});
const tool = (id: string, name = "read", displayStatus: ChatToolCallRow["displayStatus"] = "succeeded"): ChatToolCallRow => ({
  id: id as never, kind: "tool", toolName: name, status: displayStatus === "succeeded" ? "completed" : "running",
  displayStatus, waitingForApproval: displayStatus === "waiting_permission", updatedAt: 10,
  inputSummary: { title: name, path: "README.md" },
});
const chat = (items: ChatSessionView["items"], status: ChatSessionView["status"] = "idle"): ChatSessionView => ({
  items, status, pendingApprovals: [], activeTools: [], generatedAt: "now",
});
const runtime = (messages: Record<string, string>, calls: Record<string, string>, statuses: Record<string, string> = {}) => ({
  messages: Object.fromEntries(Object.entries(messages).map(([id, turnId]) => [id, { turnId }])),
  toolCalls: Object.fromEntries(Object.entries(calls).map(([id, turnId]) => [id, { turnId }])),
  turnStatuses: statuses,
  turnStartedAt: Object.fromEntries(Object.keys(statuses).map((id, index) => [id, index + 1])),
}) as unknown as Pick<ChiliRuntimeView, "messages" | "toolCalls" | "turnStatuses" | "turnStartedAt">;
const workRows = (items: ReturnType<typeof desktopTimelineItems>): DesktopWorkItem[] => items.filter((item) => item.kind === "work");

test("a MiniMax request spanning three internal turns has one disclosure and only its final answer", () => {
  const items = [user("user"), assistant("read_note", "I will inspect the files."), tool("read"),
    assistant("run_note", "Now I will run the check."), tool("bash", "bash"), assistant("answer", "Ready.")];
  const result = desktopTimelineItems(chat(items), runtime(
    { user: "first", read_note: "first", run_note: "second", answer: "third" },
    { read: "first", bash: "second" }, { first: "completed", second: "completed", third: "completed" },
  ));
  expect(result.map((item) => item.kind)).toEqual(["message", "work", "message"]);
  expect(workRows(result)[0]).toMatchObject({ id: "work:first", toolCount: 2, active: false, status: "completed" });
  expect(result[2]).toMatchObject({ id: "answer" });
  expect(workRows(result)[0]?.items.map((item) => String(item.id))).toEqual(["read_note", "read", "run_note", "bash"]);
});

test("the same request stays active between tool turns and keeps its disclosure identity", () => {
  const items = [user("user"), assistant("note", "Reading."), tool("read")];
  const projection = runtime({ user: "first", note: "first" }, { read: "first" }, { first: "completed" });
  const working = workRows(desktopTimelineItems(chat(items, "running"), projection))[0]!;
  expect(working).toMatchObject({ id: "work:first", active: true, status: "running" });
  expect(workHeadline(working)).toBe("正在整理结果");
  const finished = workRows(desktopTimelineItems(chat([...items, assistant("answer", "Done.")]), projection))[0]!;
  expect(finished.id).toBe(working.id);
  expect(finished.active).toBe(false);
});

test("late tool rows retain the original request and do not merge into a later request", () => {
  const projection = runtime({ first_user: "first", first_note: "first", first_answer: "second", next_user: "third", next_note: "third" },
    { old_read: "first", next_read: "third" }, { first: "completed", second: "completed", third: "running" });
  const result = desktopTimelineItems(chat([user("first_user"), assistant("first_note", "Reading."),
    assistant("first_answer", "First result."), user("next_user", 20), assistant("next_note", "More reading."),
    tool("old_read"), tool("next_read", "read", "running")], "running"), projection);
  expect(workRows(result)).toHaveLength(2);
  expect(workRows(result)[0]).toMatchObject({ id: "work:first", active: false, toolCount: 1 });
  expect(workRows(result)[1]).toMatchObject({ id: "work:third", active: true, toolCount: 1 });
  expect(workRows(result)[0]?.items.map((item) => String(item.id))).toEqual(["first_note", "old_read"]);
});

test("explicit final answers and synthetic failure explanations remain visible even in a tool turn", () => {
  const failure = assistant("failure", "Could not finish.");
  failure.parts = failure.parts.map((part) => part.type === "text" ? { ...part, synthetic: true } : part);
  const result = desktopTimelineItems(chat([user("user"), assistant("answer", "A useful result.", "final_answer"),
    tool("read"), failure], "failed"), runtime({ user: "turn", answer: "turn", failure: "turn" }, { read: "turn" }, { turn: "failed" }));
  expect(result.filter((item) => item.kind === "message").map((item) => String(item.id))).toEqual(["user", "answer", "failure"]);
  expect(workRows(result)[0]?.status).toBe("failed");
});

test("legacy tool messages fold their unphased progress without hiding the following answer", () => {
  const note = assistant("note", "Checking.");
  note.parts.push({ type: "tool_call", id: "part" as never, callId: "call" as never, toolName: "read", status: "completed" });
  const result = desktopTimelineItems(chat([user("user"), note, tool("call"), assistant("answer", "Done.")]));
  expect(result.map((item) => item.kind)).toEqual(["message", "work", "message"]);
  expect(result[2]).toMatchObject({ id: "answer" });
});

test("a new running request without tools does not reactivate the preceding request's work", () => {
  const result = desktopTimelineItems(chat([user("first"), tool("call"), assistant("answer", "Done."), user("second", 20)], "running"));
  expect(workRows(result)[0]?.active).toBe(false);
});

test("compacted tool-only messages still anchor delayed calls to their original request", () => {
  const message = assistant("tool_message", "");
  message.parts = [{ type: "tool_call", id: "part" as never, callId: "call" as never, toolName: "read", status: "completed" }];
  const rows = workRows(desktopTimelineItems(chat([user("first"), message, user("second", 20), tool("call")], "running"),
    runtime({ first: "one", tool_message: "two", second: "three" }, { call: "two" }, { one: "completed", two: "completed", three: "running" })));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: "work:one", active: false, toolCount: 1 });
});

test("cancelled calls do not become failures and historical failures do not imply the request is blocked", () => {
  const result = workRows(desktopTimelineItems(chat([user("user"), tool("failed", "bash", "failed"),
    tool("cancelled", "bash", "cancelled"), tool("retry", "bash"), assistant("answer", "Done.")])))[0]!;
  expect(result.failureCount).toBe(1);
  expect(result.status).toBe("completed");
  expect(workHeadline(result)).toBe("处理结束");
});

test("stages aggregate consecutive operations, retain notes and report parallel work", () => {
  const work = workRows(desktopTimelineItems(chat([user("user"), tool("read_1"), assistant("note", "Found the entry.", "commentary"),
    tool("read_2"), tool("edit", "apply_patch"), tool("command_1", "bash", "running"), tool("command_2", "bash", "running")], "running")))[0]!;
  const stages = workStages(work);
  expect(stages.map((stage) => [stage.label, stage.toolCount, stage.active])).toEqual([
    ["读取与搜索", 2, false], ["修改文件", 1, false], ["运行命令", 2, true],
  ]);
  expect(stages.flatMap((stage) => stage.items).map((item) => String(item.id))).toEqual(work.items.map((item) => String(item.id)));
  expect(workHeadline(work)).toBe("正在运行命令 · 2 项并行");
  expect(workCurrentDetail(work)).toBe("README.md");
});

test("pending approval has an explicit waiting headline", () => {
  const work = workRows(desktopTimelineItems(chat([user("user"), tool("call", "bash", "waiting_permission")], "waiting_for_approval")))[0]!;
  expect(workHeadline(work)).toBe("等待授权");
});
