import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, SessionId, TaskId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import {
  AgentMessageRecipientMetadataError,
  AgentMessageRecipientNotFoundError,
  AgentTreeControlService,
} from "./agent-tree.js";

test("scopes direct agent recipients to the caller's recursive task tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-message-descendant-scope-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const rootSessionId = "session_root" as SessionId;
  const workerSessionId = "session_worker" as SessionId;
  const nestedSessionId = "session_nested" as SessionId;

  try {
    await seedTask(store, {
      id: "task_worker" as TaskId,
      path: "/root/worker" as AgentPath,
      parentPath: "/root" as AgentPath,
      taskName: "worker",
      parentSessionId: rootSessionId,
      childSessionId: workerSessionId,
    });
    await seedTask(store, {
      id: "task_nested" as TaskId,
      path: "/root/worker/reader" as AgentPath,
      parentPath: "/root/worker" as AgentPath,
      taskName: "nested-reader",
      parentSessionId: workerSessionId,
      childSessionId: nestedSessionId,
    });
    await seedTask(store, {
      id: "task_unrelated" as TaskId,
      path: "/root/unrelated/reader" as AgentPath,
      parentPath: "/root/unrelated" as AgentPath,
      taskName: "nested-reader",
      parentSessionId: "session_unrelated" as SessionId,
      childSessionId: "session_unrelated_reader" as SessionId,
    });

    const service = new AgentTreeControlService({ store, now: () => 10 as TimestampMs });
    const fromRoot = await service.sendMessage({
      messageId: "message_root_to_nested",
      from: "/root" as AgentPath,
      to: "nested-reader",
      content: "root can address a nested descendant",
      sessionId: rootSessionId,
    });
    expect(fromRoot).toMatchObject({
      taskId: "task_nested",
      path: "/root/worker/reader",
      recipientSessionId: nestedSessionId,
    });

    const fromWorker = await service.sendMessage({
      messageId: "message_worker_to_nested",
      from: "/root/worker" as AgentPath,
      to: "/root/worker/reader",
      content: "worker can address its own descendant",
      sessionId: workerSessionId,
    });
    expect(fromWorker.taskId).toBe("task_nested" as TaskId);

    const fromNestedToParent = await service.sendMessage({
      messageId: "message_nested_to_parent",
      from: "/root/worker/reader" as AgentPath,
      to: "parent",
      content: "child can address its owning parent session",
      sessionId: nestedSessionId,
    });
    expect(fromNestedToParent).toMatchObject({
      path: "/root/worker",
      recipientSessionId: workerSessionId,
    });

    await expect(service.sendMessage({
      messageId: "message_worker_cross_tree",
      from: "/root/worker" as AgentPath,
      to: "task_unrelated",
      content: "must not escape the worker tree",
      sessionId: workerSessionId,
    })).rejects.toBeInstanceOf(AgentMessageRecipientNotFoundError);

    await store.append({
      id: "message_corrupt_cross_session",
      type: "agent.message_queued",
      time: 11 as TimestampMs,
      sessionId: rootSessionId,
      payload: {
        taskId: "task_nested" as TaskId,
        path: "/root/worker/reader" as AgentPath,
        from: "/root" as AgentPath,
        recipientSessionId: rootSessionId,
        triggerTurn: true,
        message: { role: "user", content: "must not route into the wrong session" },
      },
    });
    await expect(service.canDeliverMailbox("message_corrupt_cross_session")).rejects.toBeInstanceOf(
      AgentMessageRecipientMetadataError,
    );
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
    childSessionId: SessionId;
  },
): Promise<void> {
  await store.append({
    id: `event_created_${input.id}`,
    type: "agent.task_created",
    time: 1 as TimestampMs,
    sessionId: input.parentSessionId,
    payload: {
      taskId: input.id,
      path: input.path,
      parentPath: input.parentPath,
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      taskName: input.taskName,
      cwd: "/repo",
      prompt: "work",
      mode: "resumable",
    },
  });
}
