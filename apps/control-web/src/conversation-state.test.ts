import { describe, expect, test } from "bun:test";
import { clearSubmittedDraft, forgetRememberedTask, readRememberedTask, rememberTask } from "./conversation-state.js";

describe("task draft continuity", () => {
  test("late send completion clears only the original unchanged draft", () => {
    const drafts = new Map([["old", "submitted"], ["current", "still writing"]]);
    const next = clearSubmittedDraft(drafts, "old", "submitted");
    expect(next.get("old")).toBeUndefined();
    expect(next.get("current")).toBe("still writing");
    expect(drafts.get("old")).toBe("submitted");
  });
  test("a new edit in the original task survives the old receipt", () => {
    const drafts = new Map([["old", "new direction"]]);
    expect(clearSubmittedDraft(drafts, "old", "submitted")).toBe(drafts);
  });
});

describe("native recent task metadata", () => {
  function store() {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  }
  test("restores only the same device and host and stores no extra record fields", () => {
    const storage = store();
    const context = { hostId: "host-one", deviceId: "phone-one", privateKeyPkcs8: "must-not-persist" };
    rememberTask(storage, context, "task-one");
    expect(readRememberedTask(storage, context)).toBe("task-one");
    expect([...storage.values.values()].join()).not.toContain("must-not-persist");
    expect(readRememberedTask(storage, { ...context, hostId: "host-two" })).toBeNull();
    expect(readRememberedTask(storage, { ...context, deviceId: "phone-two" })).toBeNull();
    forgetRememberedTask(storage);
    expect(readRememberedTask(storage, context)).toBeNull();
  });
  test("malformed or unavailable storage falls back to the task list", () => {
    const context = { hostId: "h", deviceId: "d" };
    for (const value of ["broken", "null", "[]", JSON.stringify({ ...context, sessionId: "x".repeat(129) })]) {
      expect(readRememberedTask({ getItem: () => value }, context)).toBeNull();
    }
    expect(readRememberedTask({ getItem: () => { throw new Error("storage blocked"); } }, context)).toBeNull();
    expect(() => rememberTask({ setItem: () => { throw new Error("storage full"); } }, context, "task")).not.toThrow();
  });
});
