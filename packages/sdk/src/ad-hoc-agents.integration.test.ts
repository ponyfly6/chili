import { expect, test } from "bun:test";
import type {
  AgentPath,
  AgentRunId,
  AgentTaskStatus,
  ChiliEvent,
  SessionId,
  TaskId,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import {
  createRuntimeView,
  reduceRuntimeEvents,
  runtimeAgentsSnapshot,
  runtimeDelegationStatus,
  teamLiveView,
} from "./projection.js";

test("ad-hoc agents remain visible when the parent is idle and no persistent team exists", () => {
  const sessionId = "session_ad_hoc_agents" as SessionId;
  const threadId = "thread_ad_hoc_agents" as ThreadId;
  const events: ChiliEvent[] = [
    {
      id: "event_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_parent_idle",
      type: "session.status_changed",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, status: "idle" },
    },
    ...agentLifecycleEvents({ index: 1, sessionId, threadId, status: "completed", summary: "routes mapped" }),
    ...agentLifecycleEvents({ index: 2, sessionId, threadId, status: "completed", summary: "shell mapped" }),
    ...agentLifecycleEvents({ index: 3, sessionId, threadId, status: "completed", summary: "workbench mapped" }),
    ...agentLifecycleEvents({ index: 4, sessionId, threadId, status: "incomplete", summary: "needs repository evidence" }),
    ...agentLifecycleEvents({ index: 5, sessionId, threadId, status: "failed", error: "provider quota 2062" }),
  ];

  const view = reduceRuntimeEvents(events, createRuntimeView());
  const snapshot = runtimeAgentsSnapshot(view, sessionId);
  const status = runtimeDelegationStatus(view, {
    sessionId,
    threadId,
    generatedAt: "2026-08-19T00:00:00.000Z",
  });

  expect(snapshot.agents).toHaveLength(5);
  expect(snapshot.tasks).toHaveLength(5);
  expect(snapshot.agents.map((agent) => agent.status)).toEqual([
    "completed",
    "completed",
    "completed",
    "incomplete",
    "failed",
  ]);
  expect(snapshot.tasks.find((task) => task.id === "task_5")).toMatchObject({
    status: "failed",
    error: "provider quota 2062",
  });

  expect(status.parent).toMatchObject({
    sessionId,
    threadId,
    status: "idle",
    active: false,
  });
  expect(status.agents.counts).toEqual({
    total: 5,
    pending: 0,
    running: 0,
    active: 0,
    completed: 3,
    incomplete: 1,
    failed: 1,
    cancelled: 0,
  });
  expect(status.agents.items.map((agent) => String(agent.taskId))).toEqual([
    "task_5",
    "task_4",
    "task_3",
    "task_2",
    "task_1",
  ]);
  expect(status.agents.errors).toMatchObject([
    {
      taskId: "task_5",
      status: "failed",
      message: "provider quota 2062",
    },
    {
      taskId: "task_4",
      status: "incomplete",
      message: "needs repository evidence",
    },
  ]);
  expect(status.team).toEqual({ count: 0, activeCount: 0 });
  expect(teamLiveView(view, { sessionId }).selected).toBeUndefined();
});

function agentLifecycleEvents(input: {
  index: number;
  sessionId: SessionId;
  threadId: ThreadId;
  status: Exclude<AgentTaskStatus, "pending" | "running">;
  summary?: string;
  error?: string;
}): ChiliEvent[] {
  const taskId = `task_${input.index}` as TaskId;
  const runId = `agent_${input.index}` as AgentRunId;
  const path = `/root/${taskId}` as AgentPath;
  const time = input.index * 10;
  const terminal = {
    taskId,
    path,
    runId,
    generation: 1,
    status: input.status,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.error ? { error: input.error } : {}),
  };

  return [
    {
      id: `event_task_${input.index}`,
      type: "agent.task_created",
      time: time as TimestampMs,
      sessionId: input.sessionId,
      threadId: input.threadId,
      payload: {
        taskId,
        path,
        parentPath: "/root" as AgentPath,
        parentSessionId: input.sessionId,
        parentThreadId: input.threadId,
        childSessionId: `session_child_${input.index}` as SessionId,
        childThreadId: `thread_child_${input.index}` as ThreadId,
        taskName: `slice ${input.index}`,
        cwd: "/repo",
        prompt: `inspect slice ${input.index}`,
        mode: "background",
      },
    },
    {
      id: `event_spawn_${input.index}`,
      type: "agent.spawned",
      time: (time + 1) as TimestampMs,
      sessionId: input.sessionId,
      threadId: input.threadId,
      payload: {
        runId,
        taskId,
        path,
        parentPath: "/root" as AgentPath,
        parentSessionId: input.sessionId,
        parentThreadId: input.threadId,
        childSessionId: `session_child_${input.index}` as SessionId,
        childThreadId: `thread_child_${input.index}` as ThreadId,
        taskName: `slice ${input.index}`,
        cwd: "/repo",
        mode: "background",
        generation: 1,
      },
    },
    {
      id: `event_task_terminal_${input.index}`,
      type: "agent.task_completed",
      time: (time + 2) as TimestampMs,
      sessionId: input.sessionId,
      threadId: input.threadId,
      payload: terminal,
    },
    {
      id: `event_agent_terminal_${input.index}`,
      type: "agent.completed",
      time: (time + 3) as TimestampMs,
      sessionId: input.sessionId,
      threadId: input.threadId,
      payload: terminal,
    },
  ];
}
