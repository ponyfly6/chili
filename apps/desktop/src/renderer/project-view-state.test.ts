import { expect, test } from "bun:test";
import { eventMatchesProject, PendingSessionSelection, ProjectViewMemory } from "./project-view-state.js";

test("selection requests are scoped to their project and survive background readers until consumed", () => {
  const selection = new PendingSessionSelection();
  selection.request("project-a", "created");
  expect(selection.read("project-b")).toBeUndefined();
  expect(selection.read("project-a")).toBe("created");
  expect(selection.read("project-a")).toBe("created");
  selection.consume("project-b", "created");
  expect(selection.read("project-a")).toBe("created");
  selection.consume("project-a", "created");
  expect(selection.read("project-a")).toBeUndefined();
});

test("an older request cannot consume a newer explicit selection", () => {
  const selection = new PendingSessionSelection();
  selection.request(undefined, "first");
  selection.request(undefined, "second");
  selection.consume(undefined, "first");
  expect(selection.read(undefined)).toBe("second");
  selection.clear();
  expect(selection.read(undefined)).toBeUndefined();
});

test("remembers each project's selection and draft independently, including equal session IDs", () => {
  const views = new ProjectViewMemory();
  views.remember("/a", "same-id", "draft A");
  views.remember("/b", "same-id", "draft B");
  views.remember("/a", undefined, "");
  expect(views.read("/a")).toEqual({ sessionId: "same-id", draft: "draft A" });
  expect(views.read("/b")).toEqual({ sessionId: "same-id", draft: "draft B" });
  expect(views.read("/unknown")).toBeUndefined();
});

test("rejects stale project events while accepting global state and legacy events", () => {
  expect(eventMatchesProject({ type: "queue.changed", projectId: "a", sessionId: "same-id", count: 1 }, "b")).toBe(false);
  expect(eventMatchesProject({ type: "queue.changed", projectId: "a", sessionId: "same-id", count: 1 }, "a")).toBe(true);
  expect(eventMatchesProject({ type: "queue.changed", sessionId: "same-id", count: 1 }, undefined)).toBe(true);
});

test("keeps drafts for earlier conversations when switching within one project", () => {
  const views = new ProjectViewMemory();
  views.remember("/a", "first", "补充第一条会话");
  views.remember("/a", "second", "补充第二条会话");
  expect(views.readDraft("/a", "first")).toBe("补充第一条会话");
  expect(views.readDraft("/a", "second")).toBe("补充第二条会话");
  expect(views.read("/a")?.sessionId).toBe("second");
  views.remember("/a", "first", "");
  expect(views.readDraft("/a", "first")).toBe("");
  expect(views.readDraft("/a", "second")).toBe("补充第二条会话");
});

test("stores the new conversation draft without losing the last selected conversation", () => {
  const views = new ProjectViewMemory();
  views.remember("/a", "first", "已有会话");
  views.remember("/a", undefined, "新会话草稿");
  views.remember("/b", undefined, "另一个目录的草稿");
  views.remember(undefined, "first", "没有目录时不保存");
  expect(views.read("/a")).toEqual({ sessionId: "first", draft: "已有会话" });
  expect(views.readDraft("/a", undefined)).toBe("新会话草稿");
  expect(views.readDraft("/b", undefined)).toBe("另一个目录的草稿");
  expect(views.readDraft("/a", "missing")).toBeUndefined();
  expect(views.readDraft(undefined, "first")).toBeUndefined();
});

test("forgetting a removed conversation clears its selection and draft only in its workspace", () => {
  const views = new ProjectViewMemory();
  views.remember("/a", "older", "保留的草稿");
  views.remember("/a", "removed", "已删除的草稿");
  views.remember("/a", undefined, "新会话草稿");
  views.remember("/b", "removed", "另一个项目的草稿");
  views.forgetSession("/a", "removed");
  expect(views.read("/a")).toBeUndefined();
  expect(views.readDraft("/a", "removed")).toBeUndefined();
  expect(views.readDraft("/a", "older")).toBe("保留的草稿");
  expect(views.readDraft("/a", undefined)).toBe("新会话草稿");
  expect(views.read("/b")).toEqual({ sessionId: "removed", draft: "另一个项目的草稿" });
});

test("forgetting a background conversation preserves the current selection and draft", () => {
  const views = new ProjectViewMemory();
  views.remember("/a", "removed", "待删除");
  views.remember("/a", "current", "继续编辑");
  views.forgetSession("/a", "removed");
  expect(views.read("/a")).toEqual({ sessionId: "current", draft: "继续编辑" });
  expect(views.readDraft("/a", "removed")).toBeUndefined();
});
