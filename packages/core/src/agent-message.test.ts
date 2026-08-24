import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TaskId, ThreadId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { AgentMessageRecipientNotFoundError, AgentTreeControlService } from "./agent-tree.js";

test("scopes direct agent recipients to the caller's recursive task tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-message-descendant-scope-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const rootSessionId = "session_root" as SessionId;
  const rootThreadId = "thread_root" as ThreadId;
  const workerSessionId = "session_worker" as SessionId;
  const workerThreadId = "thread_worker" as ThreadId;
  const nestedSessionId = "session_nested" as SessionId;
  const nestedThreadId = "thread_nested" as ThreadId;

  try {
    await seedTask(store, {
      id: "task_worker" as TaskId,
      path: "/root/worker" as AgentPath,
      parentPath: "/root" as AgentPath,
      taskName: "worker",
      parentSessionId: rootSessionId,
      parentThreadId: rootThreadId,
      childSessionId: workerSessionId,
      childThreadId: workerThreadId,
    });
    await seedTask(store, {
      id: "task_nested" as TaskId,
      path: "/root/worker/reader" as AgentPath,
      parentPath: "/root/worker" as AgentPath,
      taskName: "nested-reader",
      parentSessionId: workerSessionId,
      parentThreadId: workerThreadId,
      childSessionId: nestedSessionId,
      childThreadId: nestedThreadId,
    });
    await seedTask(store, {
      id: "task_unrelated" as TaskId,
      path: "/root/unrelated/reader" as AgentPath,
      parentPath: "/root/unrelated" as AgentPath,
      taskName: "nested-reader",
      parentSessionId: "session_unrelated" as SessionId,
      parentThreadId: "thread_unrelated" as ThreadId,
      childSessionId: "session_unrelated_reader" as SessionId,
      childThreadId: "thread_unrelated_reader" as ThreadId,
    });

    const service = new AgentTreeControlService({ store, now: () => 10 as TimestampMs });
    const fromRoot = await service.sendMessage({
      messageId: "message_root_to_nested",
      from: "/root" as AgentPath,
      to: "nested-reader",
      content: "root can address a nested descendant",
      sessionId: rootSessionId,
      threadId: rootThreadId,
    });
    expect(fromRoot).toMatchObject({
      taskId: "task_nested",
      path: "/root/worker/reader",
      childSessionId: nestedSessionId,
    });

    const fromWorker = await service.sendMessage({
      messageId: "message_worker_to_nested",
      from: "/root/worker" as AgentPath,
      to: "/root/worker/reader",
      content: "worker can address its own descendant",
      sessionId: workerSessionId,
      threadId: workerThreadId,
    });
    expect(fromWorker.taskId).toBe("task_nested" as TaskId);

    await expect(service.sendMessage({
      messageId: "message_worker_cross_tree",
      from: "/root/worker" as AgentPath,
      to: "task_unrelated",
      content: "must not escape the worker tree",
      sessionId: workerSessionId,
      threadId: workerThreadId,
    })).rejects.toBeInstanceOf(AgentMessageRecipientNotFoundError);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function seedTask(
  store: SqliteEventStore,
  input: {
    id: TaskId;
    path: AgentPath;
    parentPath: AgentPath;
    taskName: string;
    parentSessionId: SessionId;
    parentThreadId: ThreadId;
    childSessionId: SessionId;
    childThreadId: ThreadId;
  },
): Promise<void> {
  await store.append({
    id: `event_created_${input.id}`,
    type: "agent.task_created",
    time: 1 as TimestampMs,
    sessionId: input.parentSessionId,
    threadId: input.parentThreadId,
    payload: {
      taskId: input.id,
      path: input.path,
      parentPath: input.parentPath,
      parentSessionId: input.parentSessionId,
      parentThreadId: input.parentThreadId,
      childSessionId: input.childSessionId,
      childThreadId: input.childThreadId,
      taskName: input.taskName,
      cwd: "/repo",
      prompt: "work",
      mode: "resumable",
    },
  });
}
