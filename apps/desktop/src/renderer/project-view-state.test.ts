import { expect, test } from "bun:test";
import { eventMatchesProject, ProjectViewMemory } from "./project-view-state.js";

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
