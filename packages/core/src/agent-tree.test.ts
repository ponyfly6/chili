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
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import type { AgentMailboxRow, AgentTaskRow } from "@chili/store";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import type { SubmitPromptInput, SubmitPromptResult } from "./runtime-service.js";
import {
  AgentMessageConflictError,
  AgentMessageRecipientAmbiguousError,
  AgentMessageRecipientMetadataError,
  AgentMessageRecipientTerminalError,
  AgentTreeControlService,
} from "./agent-tree.js";
import { AgentMailboxDeliveryPump } from "./agent-mailbox-delivery-pump.js";
import { TeamControlService } from "./team.js";

test("builds an agent path tree and consumes mailbox messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_parent" as SessionId;
  const childSessionId = "session_child" as SessionId;
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
        payload: {
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          childSessionId,
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
        payload: {
          runId: "agent_child_1" as AgentRunId,
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          childSessionId,
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
        payload: {
          runId: "agent_child_2" as AgentRunId,
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          childSessionId,
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
        payload: {
          taskId,
          path: childPath,
          from: rootPath,
          recipientSessionId: childSessionId,
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

test("delivers direct mailbox turns without overriding the persisted session cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-delivery-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeMailboxRuntime();
  const parentSessionId = "session_parent" as SessionId;
  const childSessionId = "session_child" as SessionId;
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
        payload: {
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          childSessionId,
          taskName: "reader",
          cwd: "/stale/task-row",
          prompt: "read",
          mode: "resumable",
        },
      },
      {
        id: "event_task_completed",
        type: "agent.task_completed",
        time: 2 as TimestampMs,
        sessionId: parentSessionId,
        payload: { taskId, path: childPath, status: "completed" },
      },
      {
        id: "event_mailbox",
        type: "agent.message_queued",
        time: 2 as TimestampMs,
        sessionId: parentSessionId,
        payload: {
          taskId,
          path: childPath,
          from: rootPath,
          recipientSessionId: childSessionId,
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

    expect(runtime.prompts).toEqual([
      {
        sessionId: childSessionId,
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
          recipientSessionId: childSessionId,
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
          recipientSessionId: childSessionId,
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
        recipientSessionId: childSessionId,
        triggerTurn: true,
        message: { role: "user", content: "run now" },
      },
    });
    await pump.waitForIdle();
    await pump.stop();

    expect(runtime.prompts).toMatchObject([
      {
        sessionId: childSessionId,
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
        recipientSessionId: childSessionId,
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
  const childSessionId = "session_child" as SessionId;
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
        payload: {
          taskId,
          path: childPath,
          parentPath: rootPath,
          parentSessionId,
          childSessionId,
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
        payload: { taskId, path: childPath, status: "completed" },
      },
      {
        id: "event_mailbox",
        type: "agent.message_queued",
        time: 2 as TimestampMs,
        sessionId: parentSessionId,
        payload: {
          taskId,
          path: childPath,
          from: rootPath,
          recipientSessionId: childSessionId,
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

test("keeps mailbox queued with a bounded diagnostic when delivery fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-tree-delivery-failure-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeMailboxRuntime(hostileAgentTreeError("child session is busy"));
  const childSessionId = "session_child" as SessionId;
  const childPath = "/root/task_child" as AgentPath;

  try {
    await store.append({
      id: "event_mailbox",
      type: "agent.message_queued",
      time: 1 as TimestampMs,
      payload: {
        path: childPath,
        from: "/root" as AgentPath,
        recipientSessionId: childSessionId,
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
    const requeuedEvents = await store.events({ type: "agent.message_requeued", limit: 10 });
    expect(requeuedEvents.map((event) => event.id)).toEqual(["event_2"]);
    const requeued = requeuedEvents[0] as Extract<ChiliEvent, { type: "agent.message_requeued" }>;
    expectAgentTreeSafeDiagnostic(requeued.payload.error);
    expect(jsonByteLength(requeued)).toBeLessThanOrEqual(128 * 1024);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("trigger-turn team messages preserve session cwd ownership and member lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-team-mailbox-lifecycle-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new FakeMailboxRuntime();
  const workerPath = "/root/worker" as AgentPath;
  const rootSessionId = "session_team_root" as SessionId;
  const workerSessionId = "session_worker" as SessionId;

  try {
    const teams = new TeamControlService({ store, createId: createSequentialId(), now: () => 6 as TimestampMs });
    const team = await teams.createTeam({
      sessionId: rootSessionId,
      name: "lifecycle-team",
      leadPath: "/root" as AgentPath,
    });
    await store.appendMany([
      {
        id: "event_team_worker_task_created",
        type: "agent.task_created",
        time: 4 as TimestampMs,
        sessionId: rootSessionId,
        payload: {
          taskId: "task_team_worker" as TaskId,
          path: workerPath,
          parentPath: "/root" as AgentPath,
          parentSessionId: rootSessionId,
          childSessionId: workerSessionId,
          taskName: "team worker",
          cwd: "/stale/team-task-row",
          prompt: "initial team task",
          mode: "resumable",
        },
      },
      {
        id: "event_team_worker_task_completed",
        type: "agent.task_completed",
        time: 5 as TimestampMs,
        sessionId: rootSessionId,
        payload: {
          taskId: "task_team_worker" as TaskId,
          path: workerPath,
          status: "completed",
          generation: 1,
          summary: "initial team task complete",
        },
      },
    ]);
    await teams.addMember({
      teamId: team.id,
      path: workerPath,
      name: "worker",
      role: "implementer",
      status: "idle",
      childSessionId: workerSessionId,
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

    expect(runtime.prompts).toEqual([{
      sessionId: workerSessionId,
      text: "Run the next step.",
    }]);
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
  const taskId = "task_reader" as TaskId;
  const childPath = "/root/reader" as AgentPath;

  try {
    await seedMessageTask(store, {
      taskId,
      path: childPath,
      taskName: "reader",
      parentSessionId,
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

test("normalizes nested mailbox metadata diagnostics without redacting ordinary feedback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-message-metadata-bounds-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const parentSessionId = "session_metadata_bounds" as SessionId;
  const taskId = "task_metadata_bounds" as TaskId;
  const childPath = "/root/metadata_bounds" as AgentPath;
  const ordinaryFeedback = `User feedback keeps ${AGENT_TREE_HOSTILE_SECRET}`;
  const metadata: Record<string, unknown> = {
    feedback: ordinaryFeedback,
    diagnostics: { feedback: hostileAgentTreeError("diagnostic feedback") },
    nested: { failureReason: hostileAgentTreeError("nested failure") },
    "failure reason": hostileAgentTreeError("spaced failure key"),
    oversized: "\u0000\"\\\n".repeat(Math.ceil((5 * 1024 * 1024) / 4)),
  };
  Object.defineProperty(metadata, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { error: hostileAgentTreeError("prototype key failure") },
  });
  metadata.circular = metadata;

  try {
    await seedMessageTask(store, {
      taskId,
      path: childPath,
      taskName: "metadata_bounds",
      parentSessionId,
      status: "running",
    });
    const service = new AgentTreeControlService({ store, now: () => 10 as TimestampMs });
    await service.sendMessage({
      messageId: "agent_message_metadata_bounds",
      from: "/root" as AgentPath,
      to: childPath,
      content: "Keep ordinary content",
      sessionId: parentSessionId,
      metadata,
    });

    const queued = (await store.events({ type: "agent.message_queued", limit: 10 })).at(-1) as
      | Extract<ChiliEvent, { type: "agent.message_queued" }>
      | undefined;
    expect(queued).toBeDefined();
    const message = queued!.payload.message;
    if (!message || !("content" in message)) throw new Error("expected text mailbox message");
    const persistedMetadata = message.metadata;
    expect(persistedMetadata?.feedback).toBe(ordinaryFeedback);
    expectAgentTreeSafeDiagnostic(
      ((persistedMetadata?.diagnostics as Record<string, unknown> | undefined)?.feedback as string | undefined),
    );
    expectAgentTreeSafeDiagnostic(
      ((persistedMetadata?.nested as Record<string, unknown> | undefined)?.failureReason as string | undefined),
    );
    expectAgentTreeSafeDiagnostic(persistedMetadata?.["failure reason"] as string | undefined);
    expect(Object.prototype.hasOwnProperty.call(persistedMetadata, "__proto__")).toBe(true);
    expectAgentTreeSafeDiagnostic(
      ((persistedMetadata?.["__proto__"] as Record<string, unknown> | undefined)?.error as string | undefined),
    );
    expect(jsonByteLength(persistedMetadata)).toBeLessThanOrEqual(256 * 1024);
    expect(jsonByteLength(queued)).toBeLessThanOrEqual(320 * 1024);
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

  try {
    await seedMessageTask(store, {
      taskId: "task_reader_a" as TaskId,
      path: "/root/reader_a" as AgentPath,
      taskName: "reader",
      parentSessionId: sessionA,
      status: "running",
    });
    await seedMessageTask(store, {
      taskId: "task_reader_b" as TaskId,
      path: "/root/reader_b" as AgentPath,
      taskName: "reader",
      parentSessionId: sessionB,
      status: "running",
    });
    const service = new AgentTreeControlService({ store, now: () => 10 as TimestampMs });

    const scoped = await service.sendMessage({
      messageId: "agent_message_scoped",
      from: "/root" as AgentPath,
      to: "reader",
      content: "session A only",
      sessionId: sessionA,
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
  const taskId = "task_done" as TaskId;

  try {
    await seedMessageTask(store, {
      taskId,
      path: "/root/done" as AgentPath,
      taskName: "done",
      parentSessionId,
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
    });
    await service.sendMessage({
      messageId: "a_second",
      from: "/root/done" as AgentPath,
      to: "/root",
      taskId,
      content: "second",
      recipientSessionId: parentSessionId,
    });

    expect((await store.agentMailbox({ path: "/root" as AgentPath })).map((message) => message.id)).toEqual([
      "z_first",
      "a_second",
    ]);
    const explicit = await store.agentMailbox({ messageId: "z_first" });
    expect(explicit).toMatchObject([{
      path: "/root",
      recipientSessionId: parentSessionId,
      triggerTurn: true,
    }]);
    expect(explicit[0]?.taskId).toBeUndefined();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects every corrupt projection that shares one child session across tasks", async () => {
  const childSessionId = "session_duplicate" as SessionId;
  const directTask: AgentTaskRow = {
    id: "task_direct" as TaskId,
    path: "/root/direct" as AgentPath,
    status: "running",
    taskName: "direct",
    generation: 1,
    childSessionId,
    createdAt: 1,
    updatedAt: 1,
  };
  const otherTask: AgentTaskRow = {
    ...directTask,
    id: "task_other" as TaskId,
    path: "/root/other" as AgentPath,
    taskName: "other",
  };
  const message: AgentMailboxRow = {
    id: "message_duplicate_session",
    path: directTask.path,
    fromPath: "/root" as AgentPath,
    triggerTurn: true,
    status: "queued",
    taskId: directTask.id,
    recipientSessionId: childSessionId,
    message: { role: "user", content: "continue" },
    createdAt: 1,
  };
  const service = new AgentTreeControlService({
    store: {
      agentTasks: async () => [directTask, otherTask],
    } as never,
  });
  const internal = service as unknown as {
    resolveMailboxAgentTask(
      mailbox: AgentMailboxRow,
      task?: AgentTaskRow,
    ): Promise<AgentTaskRow | undefined>;
  };

  await expect(internal.resolveMailboxAgentTask(message, directTask)).rejects.toBeInstanceOf(
    AgentMessageRecipientMetadataError,
  );

  const mismatchedDirectTask: AgentTaskRow = {
    ...directTask,
    childSessionId: "session_direct_owner" as SessionId,
  };
  const soleSessionOwner: AgentTaskRow = {
    ...otherTask,
    path: message.path,
  };
  const mismatchService = new AgentTreeControlService({
    store: {
      agentTasks: async () => [soleSessionOwner],
    } as never,
  });
  const mismatchInternal = mismatchService as unknown as typeof internal;

  await expect(
    mismatchInternal.resolveMailboxAgentTask(message, mismatchedDirectTask),
  ).rejects.toBeInstanceOf(AgentMessageRecipientMetadataError);
});

async function seedMessageTask(
  store: SqliteEventStore,
  input: {
    taskId: TaskId;
    path: AgentPath;
    taskName: string;
    parentSessionId: SessionId;
    status: "running" | "completed";
  },
): Promise<void> {
  const childSessionId = `child_${input.taskId}` as SessionId;
  await store.append({
    id: `created_${input.taskId}`,
    type: "agent.task_created",
    time: 1 as TimestampMs,
    sessionId: input.parentSessionId,
    payload: {
      taskId: input.taskId,
      path: input.path,
      parentPath: "/root" as AgentPath,
      parentSessionId: input.parentSessionId,
      childSessionId,
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

const AGENT_TREE_HOSTILE_SECRET = "sk-agent-tree-secret-123456789";

function hostileAgentTreeError(label: string): Error {
  const error = new Error(
    `${label}\nAuthorization: Bearer ${AGENT_TREE_HOSTILE_SECRET}\n`
      + `http://127.0.0.1:4555/private?token=${AGENT_TREE_HOSTILE_SECRET}\n`
      + "\u0000\"\\\n".repeat(Math.ceil((5 * 1024 * 1024) / 4)),
  ) as Error & { code?: string };
  error.name = "MailboxDeliveryFailure";
  error.code = "TOKEN_INVALIDATED";
  return error;
}

function expectAgentTreeSafeDiagnostic(value: string | undefined): void {
  expect(value).toBeDefined();
  expect(value).toContain("[REDACTED]");
  expect(value).not.toContain(AGENT_TREE_HOSTILE_SECRET);
  expect(value).not.toContain("127.0.0.1");
  expect(new TextEncoder().encode(value ?? "").byteLength).toBeLessThanOrEqual(16 * 1024);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

class FakeMailboxRuntime {
  readonly messages: Array<{ sessionId: SessionId; text: string }> = [];
  readonly prompts: SubmitPromptInput[] = [];

  constructor(private readonly error?: Error) {}

  async appendUserMessage(input: { sessionId: SessionId; text: string }): Promise<MessageId> {
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
  readonly messages: Array<{ sessionId: SessionId; text: string }> = [];
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

  async appendUserMessage(input: { sessionId: SessionId; text: string }): Promise<MessageId> {
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
