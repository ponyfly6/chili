import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  AgentPath,
  AgentRunId,
  ChiliEvent,
  MessageId,
  SessionId,
  TaskId,
  ThreadId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import type { SubmitPromptInput, SubmitPromptResult } from "./runtime-service.js";
import {
  AgentMessageConflictError,
  AgentMessageRecipientAmbiguousError,
  AgentMessageRecipientTerminalError,
  AgentTreeControlService,
} from "./agent-tree.js";
import { AgentMailboxDeliveryPump } from "./agent-mailbox-delivery-pump.js";
import { TeamControlService } from "./team.js";

test("builds an agent path tree and consumes mailbox messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const taskId = "task_child" as TaskId;
  const rootPath = "/root" as AgentPath;
  const childPath = "/root/task_child" as AgentPath;

  try {
    await store.appendMany([
      agentSpawned("event_root", "agent_root" as AgentRunId, rootPath, undefined, "lead", 1),
      {
        id: "event_task_created",
        type: "agent.task_created",
        time: 2 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          parentThreadId,
          childSessionId,
          childThreadId,
          taskName: "reader",
          cwd: "/repo",
          prompt: "read",
          mode: "one_shot",
        },
      },
      {
        id: "event_child_run_1",
        type: "agent.spawned",
        time: 3 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          runId: "agent_child_1" as AgentRunId,
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          parentThreadId,
          childSessionId,
          childThreadId,
          taskName: "reader",
          cwd: "/repo",
          mode: "one_shot",
        },
      },
      {
        id: "event_child_run_2",
        type: "agent.spawned",
        time: 4 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          runId: "agent_child_2" as AgentRunId,
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          parentThreadId,
          childSessionId,
          childThreadId,
          taskName: "reader followup",
          cwd: "/repo",
          mode: "one_shot",
        },
      },
      {
        id: "event_mailbox",
        type: "agent.message_queued",
        time: 5 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          taskId,
          path: childPath,
          from: rootPath,
          childSessionId,
          childThreadId,
          triggerTurn: true,
          message: { role: "user", content: "continue" },
        },
      },
    ]);

    const service = new AgentTreeControlService({
      store,
      createId: createSequentialId(),
      now: () => 6 as TimestampMs,
    });

    const snapshot = await service.snapshot({ rootPath });
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]).toMatchObject({
      path: rootPath,
      taskName: "lead",
      children: [
        {
          path: childPath,
          taskName: "reader followup",
          runIds: ["agent_child_1", "agent_child_2"],
          mailbox: [{ id: "event_mailbox", status: "queued" }],
        },
      ],
    });

    const consumed = await service.consumeMailbox({ messageId: "event_mailbox", consumedBy: childPath });
    expect(consumed).toMatchObject({
      id: "event_mailbox",
      status: "consumed",
      consumedAt: 6,
    });
    expect(await service.mailbox({ status: "queued" })).toEqual([]);
    expect((await service.snapshot({ rootPath })).nodes[0]?.children[0]?.mailbox).toEqual([]);
    expect((await service.snapshot({ rootPath, includeConsumedMailbox: true })).nodes[0]?.children[0]?.mailbox).toMatchObject([
      { id: "event_mailbox", status: "consumed" },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("synthesizes missing root and ancestor nodes from agent paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-ancestors-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const rootPath = "/root" as AgentPath;
  const reviewerPath = "/root/reviewer" as AgentPath;
  const childPath = "/root/reviewer/reader" as AgentPath;

  try {
    await store.append(
      agentSpawned(
        "event_reader",
        "agent_reader" as AgentRunId,
        childPath,
        reviewerPath,
        "reader",
        5,
      ),
    );
    const service = new AgentTreeControlService({ store });

    const snapshot = await service.snapshot({ rootPath });

    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]).toMatchObject({
      path: rootPath,
      taskName: "",
      status: "empty",
      children: [
        {
          path: reviewerPath,
          taskName: "",
          status: "empty",
          children: [
            {
              path: childPath,
              parentPath: reviewerPath,
              taskName: "reader",
              runIds: ["agent_reader"],
            },
          ],
        },
      ],
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delivers mailbox messages to child sessions before consuming them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-delivery-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeMailboxRuntime();
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const taskId = "task_child" as TaskId;
  const rootPath = "/root" as AgentPath;
  const childPath = "/root/task_child" as AgentPath;

  try {
    await store.appendMany([
      {
        id: "event_task_created",
        type: "agent.task_created",
        time: 1 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          parentThreadId,
          childSessionId,
          childThreadId,
          taskName: "reader",
          cwd: "/repo",
          prompt: "read",
          mode: "resumable",
        },
      },
      {
        id: "event_task_completed",
        type: "agent.task_completed",
        time: 2 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: { taskId, path: childPath, status: "completed" },
      },
      {
        id: "event_mailbox",
        type: "agent.message_queued",
        time: 2 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          taskId,
          path: childPath,
          from: rootPath,
          childSessionId,
          childThreadId,
          triggerTurn: true,
          message: { role: "user", content: "continue from mailbox" },
        },
      },
    ]);

    const service = new AgentTreeControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 3 as TimestampMs,
    });

    const consumed = await service.consumeMailbox({ messageId: "event_mailbox" });

    expect(runtime.prompts).toMatchObject([
      {
        sessionId: childSessionId,
        threadId: childThreadId,
        cwd: "/repo",
        text: "continue from mailbox",
      },
    ]);
    expect(consumed).toMatchObject({
      id: "event_mailbox",
      status: "consumed",
      consumedAt: 3,
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mailbox delivery pump drains trigger-turn messages without consuming queue-only messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-pump-drain-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const runtime = new FakeMailboxRuntime();
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const childPath = "/root/worker" as AgentPath;

  try {
    await store.appendMany([
      {
        id: "event_trigger_mailbox",
        type: "agent.message_queued",
        time: 1 as TimestampMs,
        payload: {
          path: childPath,
          from: "/root" as AgentPath,
          childSessionId,
          childThreadId,
          triggerTurn: true,
          message: { role: "user", content: "wake up" },
        },
      },
      {
        id: "event_queue_only_mailbox",
        type: "agent.message_queued",
        time: 2 as TimestampMs,
        payload: {
          path: childPath,
          from: "/root" as AgentPath,
          childSessionId,
          childThreadId,
          triggerTurn: false,
          message: { role: "user", content: "remember this" },
        },
      },
    ]);

    const service = new AgentTreeControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 3 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({ agents: service, events: store });

    pump.start();
    await pump.waitForIdle();
    await pump.stop();

    expect(runtime.prompts).toMatchObject([
      {
        sessionId: childSessionId,
        threadId: childThreadId,
        text: "wake up",
      },
    ]);
    expect(runtime.messages).toEqual([]);
    expect(await service.mailbox({ messageId: "event_trigger_mailbox" })).toMatchObject([{ status: "consumed" }]);
    expect(await service.mailbox({ messageId: "event_queue_only_mailbox" })).toMatchObject([{ status: "queued" }]);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mailbox delivery pump subscribes to live trigger-turn messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-pump-live-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const runtime = new FakeMailboxRuntime();
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const childPath = "/root/worker" as AgentPath;

  try {
    const service = new AgentTreeControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 4 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({ agents: service, events: store, includeExisting: false });
    pump.start();

    await store.append({
      id: "event_live_mailbox",
      type: "agent.message_queued",
      time: 1 as TimestampMs,
      payload: {
        path: childPath,
        from: "/root" as AgentPath,
        childSessionId,
        childThreadId,
        triggerTurn: true,
        message: { role: "user", content: "run now" },
      },
    });
    await pump.waitForIdle();
    await pump.stop();

    expect(runtime.prompts).toMatchObject([
      {
        sessionId: childSessionId,
        threadId: childThreadId,
        text: "run now",
      },
    ]);
    expect(await service.mailbox({ messageId: "event_live_mailbox" })).toMatchObject([{ status: "consumed" }]);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mailbox delivery pump reports failures and leaves messages queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-pump-failure-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const runtime = new FakeMailboxRuntime(new Error("child session is busy"));
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const childPath = "/root/worker" as AgentPath;
  const failures: Array<{ messageId: string | undefined; error: unknown }> = [];

  try {
    const service = new AgentTreeControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 5 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({
      agents: service,
      events: store,
      includeExisting: false,
      onError: (error, messageId) => {
        failures.push({ error, messageId });
      },
    });
    pump.start();

    await store.append({
      id: "event_failed_mailbox",
      type: "agent.message_queued",
      time: 1 as TimestampMs,
      payload: {
        path: childPath,
        from: "/root" as AgentPath,
        childSessionId,
        childThreadId,
        triggerTurn: true,
        message: { role: "user", content: "try run" },
      },
    });
    await pump.waitForIdle();
    await pump.stop();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.messageId).toBe("event_failed_mailbox");
    expect(await service.mailbox({ messageId: "event_failed_mailbox" })).toMatchObject([{ status: "queued" }]);
    expect((await store.events({ type: "agent.message_requeued", limit: 10 })).map((event) => event.id)).toEqual([
      "event_2",
    ]);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("claims mailbox before delivery so concurrent consumers only deliver once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-mailbox-claim-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new BlockingMailboxRuntime();
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const taskId = "task_child" as TaskId;
  const rootPath = "/root" as AgentPath;
  const childPath = "/root/task_child" as AgentPath;
  let now = 2;

  try {
    await store.appendMany([
      {
        id: "event_task_created",
        type: "agent.task_created",
        time: 1 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          parentThreadId,
          childSessionId,
          childThreadId,
          taskName: "reader",
          cwd: "/repo",
          prompt: "read",
          mode: "resumable",
        },
      },
      {
        id: "event_task_completed",
        type: "agent.task_completed",
        time: 2 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: { taskId, path: childPath, status: "completed" },
      },
      {
        id: "event_mailbox",
        type: "agent.message_queued",
        time: 2 as TimestampMs,
        sessionId: parentSessionId,
        threadId: parentThreadId,
        payload: {
          taskId,
          path: childPath,
          from: rootPath,
          childSessionId,
          childThreadId,
          triggerTurn: true,
          message: { role: "user", content: "continue from mailbox" },
        },
      },
    ]);

    const service = new AgentTreeControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => (++now) as TimestampMs,
    });

    const first = service.consumeMailbox({ messageId: "event_mailbox" });
    await runtime.started;

    await expect(service.consumeMailbox({ messageId: "event_mailbox" })).rejects.toThrow(
      "Mailbox message is already being delivered",
    );

    runtime.release();
    await expect(first).resolves.toMatchObject({
      id: "event_mailbox",
      status: "consumed",
    });

    expect(runtime.prompts).toHaveLength(1);
    expect((await store.events({ type: "agent.message_claimed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_1",
    ]);
    expect((await store.events({ type: "agent.message_consumed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_3",
    ]);
    expect((await store.events({ type: "agent.message_requeued", limit: 10 }))).toEqual([]);
  } finally {
    runtime.release();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps mailbox queued when delivery fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-delivery-failure-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeMailboxRuntime(new Error("child session is busy"));
  const childSessionId = "session_child" as SessionId;
  const childThreadId = "thread_child" as ThreadId;
  const childPath = "/root/task_child" as AgentPath;

  try {
    await store.append({
      id: "event_mailbox",
      type: "agent.message_queued",
      time: 1 as TimestampMs,
      payload: {
        path: childPath,
        from: "/root" as AgentPath,
        childSessionId,
        childThreadId,
        triggerTurn: true,
        message: { role: "user", content: "continue" },
      },
    });
    const service = new AgentTreeControlService({
      store,
      runtime,
      createId: createSequentialId(),
      now: () => 2 as TimestampMs,
    });

    await expect(service.consumeMailbox({ messageId: "event_mailbox" })).rejects.toThrow("child session is busy");

    expect(await service.mailbox({ messageId: "event_mailbox" })).toMatchObject([
      {
        id: "event_mailbox",
        status: "queued",
      },
    ]);
    expect((await store.events({ type: "agent.message_consumed", limit: 10 }))).toEqual([]);
    expect((await store.events({ type: "agent.message_claimed", limit: 10 })).map((event) => event.id)).toEqual([
      "event_1",
    ]);
    expect((await store.events({ type: "agent.message_requeued", limit: 10 })).map((event) => event.id)).toEqual([
      "event_2",
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("trigger-turn team messages keep member lifecycle in sync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-mailbox-lifecycle-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeMailboxRuntime();
  const workerPath = "/root/worker" as AgentPath;

  try {
    const teams = new TeamControlService({ store, createId: createSequentialId(), now: () => 6 as TimestampMs });
    const team = await teams.createTeam({ name: "lifecycle-team", leadPath: "/root" as AgentPath });
    await teams.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      status: "idle",
      childSessionId: "session_worker" as SessionId,
      childThreadId: "thread_worker" as ThreadId,
    });
    await teams.sendMessage({
      teamId: team.id,
      messageId: "wake_worker",
      from: "/root",
      to: "worker",
      content: "Run the next step.",
      delivery: "triggerTurn",
    });
    const mailbox = (await store.agentMailbox({ path: workerPath }))[0];
    expect(mailbox).toBeDefined();

    let nextDeliveryId = 0;
    const agents = new AgentTreeControlService({
      store,
      runtime,
      createId: (prefix) => `delivery_${prefix}_${++nextDeliveryId}`,
      now: () => 7 as TimestampMs,
    });
    await agents.consumeMailbox({ messageId: mailbox?.id ?? "missing" });

    expect(
      (await store.events({ type: "team.member_status_changed", limit: 10 }))
        .filter(
          (event): event is Extract<ChiliEvent, { type: "team.member_status_changed" }> =>
            event.type === "team.member_status_changed",
        )
        .map((event) => event.payload.status),
    ).toEqual(["running", "idle"]);
    expect(await store.teamMembers({ teamId: team.id, path: workerPath })).toMatchObject([{ status: "idle" }]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sends idempotent agent messages and keeps consumed messages terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-message-idempotency-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const taskId = "task_reader" as TaskId;
  const childPath = "/root/reader" as AgentPath;

  try {
    await seedMessageTask(store, {
      taskId,
      path: childPath,
      taskName: "reader",
      parentSessionId,
      parentThreadId,
      status: "completed",
    });
    const service = new AgentTreeControlService({ store, now: () => 10 as TimestampMs });
    const input = {
      messageId: "agent_message_once",
      from: "/root" as AgentPath,
      to: "reader",
      content: "Use this if you are resumed later.",
      delivery: "queueOnly" as const,
      sessionId: parentSessionId,
      threadId: parentThreadId,
      metadata: { reason: "followup-context" },
    };

    const first = await service.sendMessage(input);
    const retry = await service.sendMessage(input);
    expect(retry.id).toBe(first.id);
    expect(await store.events({ type: "agent.message_queued", limit: 10 })).toHaveLength(1);

    const consumed = await service.consumeMailbox({ messageId: first.id });
    expect(consumed.status).toBe("consumed");
    expect((await service.sendMessage(input)).status).toBe("consumed");
    expect((await store.agentMailbox({ messageId: first.id }))[0]?.status).toBe("consumed");

    await expect(service.sendMessage({ ...input, content: "different" })).rejects.toBeInstanceOf(
      AgentMessageConflictError,
    );
    await expect(service.sendMessage({
      ...input,
      messageId: "agent_message_wake_terminal",
      delivery: "triggerTurn",
    })).rejects.toBeInstanceOf(AgentMessageRecipientTerminalError);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scopes named agent recipients to the sending session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-message-scope-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const sessionA = "session_a" as SessionId;
  const sessionB = "session_b" as SessionId;
  const threadA = "thread_a" as ThreadId;
  const threadB = "thread_b" as ThreadId;

  try {
    await seedMessageTask(store, {
      taskId: "task_reader_a" as TaskId,
      path: "/root/reader_a" as AgentPath,
      taskName: "reader",
      parentSessionId: sessionA,
      parentThreadId: threadA,
      status: "running",
    });
    await seedMessageTask(store, {
      taskId: "task_reader_b" as TaskId,
      path: "/root/reader_b" as AgentPath,
      taskName: "reader",
      parentSessionId: sessionB,
      parentThreadId: threadB,
      status: "running",
    });
    const service = new AgentTreeControlService({ store, now: () => 10 as TimestampMs });

    const scoped = await service.sendMessage({
      messageId: "agent_message_scoped",
      from: "/root" as AgentPath,
      to: "reader",
      content: "session A only",
      sessionId: sessionA,
      threadId: threadA,
    });
    expect(scoped).toMatchObject({ taskId: "task_reader_a", path: "/root/reader_a" });

    await expect(service.sendMessage({
      messageId: "agent_message_ambiguous",
      from: "/root" as AgentPath,
      to: "reader",
      content: "no session scope",
    })).rejects.toBeInstanceOf(AgentMessageRecipientAmbiguousError);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit recipient metadata wins over terminal task lookup and mailbox reads are FIFO", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-message-explicit-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_parent" as SessionId;
  const parentThreadId = "thread_parent" as ThreadId;
  const taskId = "task_done" as TaskId;

  try {
    await seedMessageTask(store, {
      taskId,
      path: "/root/done" as AgentPath,
      taskName: "done",
      parentSessionId,
      parentThreadId,
      status: "completed",
    });
    const service = new AgentTreeControlService({ store, now: () => 20 as TimestampMs });
    await service.sendMessage({
      messageId: "z_first",
      from: "/root/done" as AgentPath,
      to: "/root",
      taskId,
      content: "first",
      delivery: "triggerTurn",
      recipientSessionId: parentSessionId,
      recipientThreadId: parentThreadId,
    });
    await service.sendMessage({
      messageId: "a_second",
      from: "/root/done" as AgentPath,
      to: "/root",
      taskId,
      content: "second",
      recipientSessionId: parentSessionId,
      recipientThreadId: parentThreadId,
    });

    expect((await store.agentMailbox({ path: "/root" as AgentPath })).map((message) => message.id)).toEqual([
      "z_first",
      "a_second",
    ]);
    const explicit = await store.agentMailbox({ messageId: "z_first" });
    expect(explicit).toMatchObject([{
      path: "/root",
      childSessionId: parentSessionId,
      childThreadId: parentThreadId,
      triggerTurn: true,
    }]);
    expect(explicit[0]?.taskId).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function seedMessageTask(
  store: SqliteEventStore,
  input: {
    taskId: TaskId;
    path: AgentPath;
    taskName: string;
    parentSessionId: SessionId;
    parentThreadId: ThreadId;
    status: "running" | "completed";
  },
): Promise<void> {
  const childSessionId = `child_${input.taskId}` as SessionId;
  const childThreadId = `thread_${input.taskId}` as ThreadId;
  await store.append({
    id: `created_${input.taskId}`,
    type: "agent.task_created",
    time: 1 as TimestampMs,
    sessionId: input.parentSessionId,
    threadId: input.parentThreadId,
    payload: {
      taskId: input.taskId,
      path: input.path,
      parentPath: "/root" as AgentPath,
      parentSessionId: input.parentSessionId,
      parentThreadId: input.parentThreadId,
      childSessionId,
      childThreadId,
      taskName: input.taskName,
      cwd: "/repo",
      prompt: "work",
      mode: "resumable",
    },
  });
  if (input.status === "completed") {
    await store.append({
      id: `completed_${input.taskId}`,
      type: "agent.task_completed",
      time: 2 as TimestampMs,
      sessionId: input.parentSessionId,
      threadId: input.parentThreadId,
      payload: {
        taskId: input.taskId,
        path: input.path,
        status: "completed",
      },
    });
  }
}

function agentSpawned(
  id: string,
  runId: AgentRunId,
  path: AgentPath,
  parentPath: AgentPath | undefined,
  taskName: string,
  time: number,
): ChiliEvent {
  const payload: Extract<ChiliEvent, { type: "agent.spawned" }>["payload"] = {
    runId,
    path,
    taskName,
  };
  if (parentPath) payload.parentPath = parentPath;
  return {
    id,
    type: "agent.spawned",
    time: time as TimestampMs,
    payload,
  };
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

class FakeMailboxRuntime {
  readonly messages: Array<{ sessionId: SessionId; threadId: ThreadId; text: string }> = [];
  readonly prompts: SubmitPromptInput[] = [];

  constructor(private readonly error?: Error) {}

  async appendUserMessage(input: { sessionId: SessionId; threadId: ThreadId; text: string }): Promise<MessageId> {
    this.messages.push(input);
    return "message_mailbox" as MessageId;
  }

  async submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult> {
    this.prompts.push(input);
    if (this.error) throw this.error;
    return {
      status: "completed",
      turns: [
        {
          status: "completed",
          turnId: "turn_mailbox" as TurnId,
          assistantMessageId: "message_assistant" as MessageId,
          finishReason: "stop",
        },
      ],
      finishReason: "stop",
    };
  }
}

class BlockingMailboxRuntime {
  readonly messages: Array<{ sessionId: SessionId; threadId: ThreadId; text: string }> = [];
  readonly prompts: SubmitPromptInput[] = [];
  readonly started: Promise<void>;
  private readonly released: Promise<void>;
  private markStarted: () => void = () => {};
  private markReleased: () => void = () => {};
  private isReleased = false;

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
    this.released = new Promise((resolve) => {
      this.markReleased = resolve;
    });
  }

  async appendUserMessage(input: { sessionId: SessionId; threadId: ThreadId; text: string }): Promise<MessageId> {
    this.messages.push(input);
    return "message_mailbox" as MessageId;
  }

  async submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult> {
    this.prompts.push(input);
    this.markStarted();
    await this.released;
    return {
      status: "completed",
      turns: [
        {
          status: "completed",
          turnId: "turn_mailbox" as TurnId,
          assistantMessageId: "message_assistant" as MessageId,
          finishReason: "stop",
        },
      ],
      finishReason: "stop",
    };
  }

  release(): void {
    if (this.isReleased) return;
    this.isReleased = true;
    this.markReleased();
  }
}
