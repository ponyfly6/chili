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
