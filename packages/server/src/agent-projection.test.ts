import { expect, test } from "bun:test";
import type {
  AgentPath,
  AgentRunId,
  ChiliEvent,
  SessionId,
  TaskId,
  TimestampMs,
} from "@chili/protocol";
import { projectRuntimeAgents } from "./agent-projection.js";

const taskId = "task_first_write_wins" as TaskId;
const originalPath = "/root/original" as AgentPath;
const originalSessionId = "session_original_parent" as SessionId;
const originalChildSessionId = "session_original_child" as SessionId;
const runId = "agentrun_first_write_wins" as AgentRunId;

const created: ChiliEvent = {
  id: "event_task_created_original",
  type: "agent.task_created",
  time: 1 as TimestampMs,
  sessionId: originalSessionId,
  payload: {
    taskId,
    path: originalPath,
    parentPath: "/root" as AgentPath,
    parentSessionId: originalSessionId,
    childSessionId: originalChildSessionId,
    taskName: "original task",
    cwd: "/original",
    prompt: "original prompt",
  },
};

const spawned: ChiliEvent = {
  id: "event_task_spawned",
  type: "agent.spawned",
  time: 2 as TimestampMs,
  sessionId: originalSessionId,
  payload: {
    runId,
    taskId,
    path: originalPath,
    parentPath: "/root" as AgentPath,
    parentSessionId: originalSessionId,
    childSessionId: originalChildSessionId,
    taskName: "original task",
    generation: 1,
  },
};

const completed: ChiliEvent = {
  id: "event_task_completed",
  type: "agent.task_completed",
  time: 3 as TimestampMs,
  sessionId: originalSessionId,
  payload: {
    taskId,
    runId,
    path: originalPath,
    status: "completed",
    generation: 1,
    summary: "done",
  },
};

const duplicateCreated: ChiliEvent = {
  id: "event_task_created_duplicate",
  type: "agent.task_created",
  time: 4 as TimestampMs,
  sessionId: "session_duplicate_event" as SessionId,
  payload: {
    taskId,
    path: "/root/duplicate" as AgentPath,
    parentPath: "/different-parent" as AgentPath,
    parentSessionId: "session_duplicate_parent" as SessionId,
    childSessionId: "session_duplicate_child" as SessionId,
    taskName: "duplicate task",
    cwd: "/duplicate",
    prompt: "duplicate prompt",
  },
};

test("projects the first agent task creation as pending", () => {
  expect(projectRuntimeAgents([created]).tasks).toEqual([
    {
      id: taskId,
      status: "pending",
      generation: 0,
      createdAt: 1,
      updatedAt: 1,
      sessionId: originalSessionId,
      ownerPath: originalPath,
      path: originalPath,
      childSessionId: originalChildSessionId,
    },
  ]);
});

test("does not let duplicate task creation rewind a running task or replace its identity", () => {
  const [task] = projectRuntimeAgents([created, spawned, duplicateCreated]).tasks;

  expect(task).toMatchObject({
    id: taskId,
    status: "running",
    generation: 1,
    createdAt: 1,
    updatedAt: 2,
    sessionId: originalSessionId,
    ownerPath: originalPath,
    path: originalPath,
    childSessionId: originalChildSessionId,
  });
  expect(task?.completedAt).toBeUndefined();
});

test("keeps a completed task terminal after duplicate task creation", () => {
  const [task] = projectRuntimeAgents([created, spawned, completed, duplicateCreated]).tasks;

  expect(task).toMatchObject({
    id: taskId,
    status: "completed",
    generation: 1,
    createdAt: 1,
    updatedAt: 3,
    completedAt: 3,
    sessionId: originalSessionId,
    ownerPath: originalPath,
    path: originalPath,
    childSessionId: originalChildSessionId,
  });
});
