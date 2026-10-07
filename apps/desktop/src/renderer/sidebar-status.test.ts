import { expect, test } from "bun:test";
import { sessionActivity } from "./sidebar-status.js";

test("actionable requests take precedence over processing and queued follow-ups", () => {
  expect(sessionActivity({ status: "running", pendingInput: true, queuedCount: 2 })).toEqual({
    label: "待补充", description: "需要你补充信息，还有 2 条消息待处理", tone: "attention",
  });
  expect(sessionActivity({ status: "waiting_for_approval", queuedCount: 1 })).toEqual({
    label: "审查中", description: "正在自动审查操作，还有 1 条消息待处理", tone: "working",
  });
  expect(sessionActivity({ status: "cancelling", pendingInput: true, paused: true })?.label).toBe("正在停止");
});

test("describes running work and retains the queued count in its accessible detail", () => {
  expect(sessionActivity({ status: "running", queuedCount: 3 })).toEqual({
    label: "处理中", description: "正在处理，还有 3 条消息待处理", tone: "working",
  });
  expect(sessionActivity({ status: "idle", queuedCount: 3 })).toEqual({
    label: "待处理 3", description: "3 条消息待处理", tone: "quiet",
  });
});

test("pause comes from the queue, never inferred from a cancelled run", () => {
  expect(sessionActivity({ status: "cancelled" })).toBeUndefined();
  expect(sessionActivity({ status: "cancelled", paused: true, queuedCount: 2 })).toEqual({
    label: "已暂停", description: "已暂停，可继续处理，还有 2 条消息待处理", tone: "quiet",
  });
  expect(sessionActivity({ status: "running", paused: true })?.label).toBe("处理中");
  expect(sessionActivity({ status: "failed" })?.label).toBe("未完成");
});

test("keeps idle, unknown and archived conversations quiet", () => {
  expect(sessionActivity({ status: "idle" })).toBeUndefined();
  expect(sessionActivity({ status: "unknown" })).toBeUndefined();
  expect(sessionActivity({})).toBeUndefined();
  expect(sessionActivity({ status: "running", pendingInput: true, queuedCount: 2, archived: true })).toBeUndefined();
});
