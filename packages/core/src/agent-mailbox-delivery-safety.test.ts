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
  TeamId,
  ThreadId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { AgentMailboxDeliveryPump } from "./agent-mailbox-delivery-pump.js";
import { AgentTreeControlService } from "./agent-tree.js";
import type { SubmitPromptInput, SubmitPromptResult } from "./runtime-service.js";
import { AgentTaskControlService } from "./task-control.js";

test("observable wrappers fall back to append events when the inner mailbox projection has no CAS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-projection-only-"));
  const sqlite = new SqliteEventStore(join(dir, "events.sqlite"));
  const projectionOnly = {
    append: sqlite.append.bind(sqlite),
    appendMany: sqlite.appendMany.bind(sqlite),
    events: sqlite.events.bind(sqlite),
    sessions: sqlite.sessions.bind(sqlite),
    messages: sqlite.messages.bind(sqlite),
    pendingApprovals: sqlite.pendingApprovals.bind(sqlite),
    agentTasks: sqlite.agentTasks.bind(sqlite),
    agentTask: sqlite.agentTask.bind(sqlite),
    agentRuns: sqlite.agentRuns.bind(sqlite),
    agentMailbox: sqlite.agentMailbox.bind(sqlite),
  };
  const inner = new ObservableEventStore(projectionOnly);
  const store = new ObservableEventStore(inner);
  const runtime = new ScriptedRuntime();

  try {
    expect(inner.supportsAgentMailboxCapability("delivery")).toBe(false);
    expect(store.supportsAgentMailboxCapability("delivery")).toBe(false);
    await store.append(mailboxEvent(
      "message_projection_only",
      "/root/projection_only" as AgentPath,
      "session_projection_only",
      "thread_projection_only",
      1,
    ));
    const agents = new AgentTreeControlService({ store, runtime, createId: sequentialId() });

    const consumed = await agents.consumeMailbox({ messageId: "message_projection_only" });

    expect(consumed.status).toBe("consumed");
    expect(runtime.inputs).toHaveLength(1);
    expect(await sqlite.events({ type: "agent.message_claimed", limit: 10 })).toEqual([]);
    expect(await sqlite.events({ type: "agent.message_consumed", limit: 10 })).toHaveLength(1);
  } finally {
    sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("outer mailbox consumption is idempotent when the task turn atomically consumed the same source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-atomic-consume-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_atomic_consume" as TaskId;
  const path = "/root/atomic_consume" as AgentPath;
  let turns = 0;

  try {
    await store.appendMany([
      taskCreatedEvent(taskId, path, "session_atomic", "thread_atomic", 1),
      {
        id: "event_atomic_initial_completed",
        type: "agent.task_completed",
        time: 2 as TimestampMs,
        payload: { taskId, path, status: "completed", generation: 1, summary: "initial result" },
      },
      mailboxEvent(
        "message_atomic_source",
        path,
        "session_atomic",
        "thread_atomic",
        3,
        { taskId },
      ),
    ]);
    const agents = new AgentTreeControlService({
      store,
      runtime: new ScriptedRuntime(),
      taskTurns: {
        async followupTask() {
          turns += 1;
          const consumed = await store.consumeAgentMailboxMessage({
            messageId: "message_atomic_source",
            eventId: "event_atomic_task_consumed",
            consumedBy: path,
            time: 5,
          });
          expect(consumed.applied).toBe(true);
          const task = await store.agentTask(taskId);
          if (!task) throw new Error("missing atomic task");
          return { task, result: completedResult() };
        },
      },
      createId: sequentialId(),
      now: () => 4 as TimestampMs,
    });

    const consumed = await agents.consumeMailbox({ messageId: "message_atomic_source" });

    expect(consumed.status).toBe("consumed");
    expect(turns).toBe(1);
    expect(await store.events({ type: "agent.message_consumed", limit: 10 })).toHaveLength(1);
    expect(await store.agentMailbox({ messageId: "message_atomic_source" })).toMatchObject([
      { status: "consumed" },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled tasks and closed team members discard stale trigger turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-discard-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const runtime = new ScriptedRuntime();
  const taskId = "task_cancelled" as TaskId;
  const taskPath = "/root/cancelled" as AgentPath;
  const memberPath = "/root/closed" as AgentPath;
  const teamId = "team_closed" as TeamId;

  try {
    await store.appendMany([
      taskCreatedEvent(taskId, taskPath, "session_cancelled", "thread_cancelled", 1),
      {
        id: "event_task_cancelled",
        type: "agent.task_completed",
        time: 2 as TimestampMs,
        payload: { taskId, path: taskPath, status: "cancelled", generation: 1 },
      },
      mailboxEvent(
        "message_cancelled_task",
        taskPath,
        "session_cancelled",
        "thread_cancelled",
        3,
        { taskId },
      ),
      {
        id: "event_team_created",
        type: "team.created",
        time: 4 as TimestampMs,
        payload: { teamId, name: "closed team", leadPath: "/root" as AgentPath },
      },
      {
        id: "event_member_added",
        type: "team.member_added",
        time: 5 as TimestampMs,
        payload: {
          teamId,
          path: memberPath,
          name: "closed",
          role: "worker",
          status: "idle",
          childSessionId: "session_closed" as SessionId,
          childThreadId: "thread_closed" as ThreadId,
        },
      },
      {
        id: "event_member_closed",
        type: "team.member_status_changed",
        time: 6 as TimestampMs,
        payload: { teamId, path: memberPath, status: "closed", reason: "removed" },
      },
      mailboxEvent(
        "message_closed_member",
        memberPath,
        "session_closed",
        "thread_closed",
        7,
        { metadata: { teamId, teamMessageId: "team_message_closed" } },
      ),
    ]);
    const agents = new AgentTreeControlService({
      store,
      runtime,
      createId: sequentialId(),
      now: () => 20 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({ agents, events: store });

    pump.start();
    await pump.waitForIdle();
    await pump.stop();

    expect(runtime.inputs).toEqual([]);
    expect(await agents.mailbox({ status: "discarded", limit: 10 })).toMatchObject([
      { id: "message_cancelled_task" },
      { id: "message_closed_member" },
    ]);
    const discarded = await store.events({ type: "agent.message_discarded", limit: 10 });
    expect(discarded).toHaveLength(2);
    expect(discarded.map((event) => JSON.stringify(event.payload))).toEqual([
      expect.stringContaining("recipient task is cancelled"),
      expect.stringContaining("recipient team member is closed"),
    ]);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a task cancelled between mailbox preparation and run claim is discarded without a provider turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-cancel-claim-race-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const runtime = new ScriptedRuntime();
  const taskId = "task_cancel_claim_race" as TaskId;
  const path = "/root/cancel_claim_race" as AgentPath;
  const originalBegin = store.beginAgentTaskRunCas.bind(store);
  let cancelledAtClaim = false;
  let statusAtClaim: string | undefined;
  let beginApplied: boolean | undefined;

  store.beginAgentTaskRunCas = async (input) => {
    if (!cancelledAtClaim) {
      cancelledAtClaim = true;
      const competingRunId = "agent_cancel_claim_competitor" as AgentRunId;
      const competingMessageId = "message_cancel_claim_competitor";
      const competing = await baseStore.beginAgentTaskRunCas({
        taskId,
        expectedGeneration: input.expectedGeneration,
        expectedRunId: input.expectedRunId,
        expectedLeaseOwner: input.expectedLeaseOwner,
        runId: competingRunId,
        generation: input.expectedGeneration + 1,
        leaseOwner: "task-followup:agent_cancel_claim_competitor",
        leaseTtlMs: 100,
        spawnEventId: "event_cancel_claim_competitor_spawn",
        messageEventId: competingMessageId,
        messageClaimEventId: "event_cancel_claim_competitor_claim",
        from: "/root" as AgentPath,
        message: { role: "user", content: "competing follow-up" },
        time: 5,
      });
      expect(competing.applied).toBe(true);
      const competingTask = competing.task;
      if (!competingTask) throw new Error("missing competing task generation");
      expect((await baseStore.closeAgentTaskCas({
        taskId,
        status: "cancelled",
        eventId: "event_cancel_claim_competitor_closed",
        agentEventId: "event_cancel_claim_competitor_agent_closed",
        expectedGeneration: competingTask.generation,
        expectedRunId: competingRunId,
        expectedLeaseOwner: competingTask.leaseOwner ?? null,
        mailboxMessageId: competingMessageId,
        mailboxEventId: "event_cancel_claim_competitor_consumed",
        mailboxDisposition: "consume",
        time: 6,
      })).applied).toBe(true);
      statusAtClaim = (await store.agentTask(taskId))?.status;
    }
    const result = await originalBegin(input);
    beginApplied = result.applied;
    return result;
  };

  try {
    await store.appendMany([
      taskCreatedEvent(taskId, path, "session_cancel_claim", "thread_cancel_claim", 1),
      {
        id: "event_cancel_claim_initial_completed",
        type: "agent.task_completed",
        time: 2 as TimestampMs,
        payload: { taskId, path, status: "completed", generation: 1, summary: "initial result" },
      },
      mailboxEvent(
        "message_cancel_claim_race",
        path,
        "session_cancel_claim",
        "thread_cancel_claim",
        3,
        { taskId },
      ),
    ]);
    const tasks = new AgentTaskControlService({ store, runtime, createId: sequentialId() });
    const agents = new AgentTreeControlService({
      store,
      runtime,
      taskTurns: tasks,
      createId: sequentialId(),
      now: () => 6 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({ agents, events: store });

    pump.start();
    await pump.waitForIdle();
    await pump.stop();

    expect(cancelledAtClaim).toBe(true);
    expect({ statusAtClaim, beginApplied }).toEqual({ statusAtClaim: "cancelled", beginApplied: false });
    expect(runtime.inputs).toEqual([]);
    expect(await store.agentTask(taskId)).toMatchObject({ status: "cancelled", generation: 3 });
    expect(await store.agentMailbox({ messageId: "message_cancel_claim_race" })).toMatchObject([
      { status: "discarded" },
    ]);
    expect(await store.events({ type: "agent.message_discarded", limit: 10 })).toHaveLength(1);
    expect(await store.events({ type: "agent.message_requeued", limit: 10 })).toEqual([]);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup reclaims an interrupted delivering trigger in a single-process store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-recover-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new ScriptedRuntime();

  try {
    await store.append(mailboxEvent(
      "message_interrupted",
      "/root/worker" as AgentPath,
      "session_worker",
      "thread_worker",
      1,
    ));
    const claim = await store.claimAgentMailboxMessage({
      messageId: "message_interrupted",
      eventId: "event_old_claim",
      claimedBy: "/root/worker" as AgentPath,
      time: 2,
    });
    expect(claim.applied).toBe(true);
    expect(claim.message?.status).toBe("delivering");

    const agents = new AgentTreeControlService({
      store,
      runtime,
      createId: sequentialId(),
      now: () => 10 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({ agents });
    pump.start();
    await pump.waitForIdle();
    await pump.stop();

    expect(runtime.inputs).toHaveLength(1);
    expect(await agents.mailbox({ messageId: "message_interrupted" })).toMatchObject([
      { status: "consumed" },
    ]);
    const requeued = await store.events({ type: "agent.message_requeued", limit: 10 });
    expect(requeued).toHaveLength(1);
    expect(JSON.stringify(requeued[0]?.payload)).toContain("mailbox_delivery_recovered_after_restart");
    expect(await store.events({ type: "agent.message_claimed", limit: 10 })).toHaveLength(2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-completed prompt results requeue and honor retryAfter before succeeding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-backoff-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const retryError = Object.assign(new Error("provider circuit open"), { retryAfterMs: 45 });
  const runtime = new ScriptedRuntime([
    { status: "failed", turns: [], error: retryError },
    completedResult(),
  ]);

  try {
    await store.append(mailboxEvent(
      "message_retry",
      "/root/worker" as AgentPath,
      "session_worker",
      "thread_worker",
      1,
    ));
    const agents = new AgentTreeControlService({
      store,
      runtime,
      createId: sequentialId(),
      now: () => 10 as TimestampMs,
    });
    const pump = new AgentMailboxDeliveryPump({
      agents,
      retryPolicy: { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 100, factor: 2 },
    });

    pump.start();
    await pump.waitForIdle();
    await pump.stop();

    expect(runtime.inputs).toHaveLength(2);
    expect((runtime.startedAt[1] ?? 0) - (runtime.startedAt[0] ?? 0)).toBeGreaterThanOrEqual(35);
    expect(await agents.mailbox({ messageId: "message_retry" })).toMatchObject([{ status: "consumed" }]);
    expect(await store.events({ type: "agent.message_requeued", limit: 10 })).toHaveLength(1);
    expect(await store.events({ type: "agent.message_consumed", limit: 10 })).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicitly non-retryable prompt failures stay parked for the pump lifetime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-nonretryable-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new ScriptedRuntime([{
    status: "failed",
    turns: [],
    error: Object.assign(new Error("MiniMax plan capacity 2062"), { retryable: false, code: "2062" }),
  }]);

  try {
    await store.append(mailboxEvent(
      "message_nonretryable",
      "/root/worker" as AgentPath,
      "session_worker",
      "thread_worker",
      1,
    ));
    const agents = new AgentTreeControlService({ store, runtime, createId: sequentialId() });
    const pump = new AgentMailboxDeliveryPump({
      agents,
      retryPolicy: { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 5 },
    });

    pump.start();
    await pump.waitForIdle();
    await pump.stop();

    expect(runtime.inputs).toHaveLength(1);
    expect(await agents.mailbox({ messageId: "message_nonretryable" })).toMatchObject([{ status: "queued" }]);
    expect(await store.events({ type: "agent.message_requeued", limit: 10 })).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime idle events do not reset retry attempts or defeat max-attempt parking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-idle-retry-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const retryableFailure = (): SubmitPromptResult => ({
    status: "failed",
    turns: [],
    error: Object.assign(new Error("temporary provider failure"), { retryable: true }),
  });
  let idleSequence = 0;
  const runtime = new ScriptedRuntime(
    Array.from({ length: 5 }, retryableFailure),
    async (input) => {
      idleSequence += 1;
      await store.append({
        id: `event_runtime_idle_${idleSequence}`,
        type: "session.status_changed",
        time: (10 + idleSequence) as TimestampMs,
        sessionId: input.sessionId,
        threadId: input.threadId,
        payload: { sessionId: input.sessionId, status: "idle" },
      });
    },
  );

  try {
    await store.append(mailboxEvent(
      "message_idle_retry",
      "/root/worker" as AgentPath,
      "session_worker",
      "thread_worker",
      1,
    ));
    const agents = new AgentTreeControlService({ store, runtime, createId: sequentialId() });
    const pump = new AgentMailboxDeliveryPump({
      agents,
      events: store,
      retryPolicy: { maxAttempts: 2, initialDelayMs: 5, maxDelayMs: 5, factor: 1 },
    });

    pump.start();
    await pump.waitForIdle();
    await pump.stop();

    expect(runtime.inputs).toHaveLength(2);
    expect(await agents.mailbox({ messageId: "message_idle_retry" })).toMatchObject([{ status: "queued" }]);
    expect(await store.events({ type: "agent.message_requeued", limit: 10 })).toHaveLength(2);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("aborting a mailbox-owned task turn leaves it incomplete and retryable, not cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-agent-mailbox-task-abort-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const taskId = "task_mailbox_abort" as TaskId;
  const path = "/root/mailbox_abort" as AgentPath;
  const runtime = new AbortBlockingRuntime();
  const abortController = new AbortController();
  const createId = sequentialId();

  try {
    await store.appendMany([
      taskCreatedEvent(taskId, path, "session_abort", "thread_abort", 1),
      {
        id: "event_initial_completed",
        type: "agent.task_completed",
        time: 2 as TimestampMs,
        payload: { taskId, path, status: "completed", generation: 1, summary: "initial result" },
      },
      mailboxEvent(
        "message_abort",
        path,
        "session_abort",
        "thread_abort",
        3,
        { taskId },
      ),
    ]);
    const claimed = await store.claimAgentMailboxMessage({
      messageId: "message_abort",
      eventId: "event_message_abort_claimed",
      claimedBy: path,
      time: 4,
    });
    expect(claimed.applied).toBe(true);
    const tasks = new AgentTaskControlService({ store, runtime, createId });
    const outcome = tasks.followupTask({
      taskId,
      text: "mailbox retryable follow-up",
      sourceMailboxMessageId: "message_abort",
      signal: abortController.signal,
    });
    await runtime.started.promise;
    const abort = new Error("mailbox pump stopped");
    abort.name = "AbortError";
    abortController.abort(abort);

    await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
    expect(await store.agentTask(taskId)).toMatchObject({ status: "incomplete" });
    expect(await store.agentMailbox({ messageId: "message_abort" })).toMatchObject([{ status: "queued" }]);

    const retryClaim = await store.claimAgentMailboxMessage({
      messageId: "message_abort",
      eventId: "event_message_abort_retry_claimed",
      claimedBy: path,
      time: 5,
    });
    expect(retryClaim.applied).toBe(true);

    const retryRuntime = new ScriptedRuntime();
    const retryTasks = new AgentTaskControlService({ store, runtime: retryRuntime, createId });
    await retryTasks.followupTask({
      taskId,
      text: "retry after pump restart",
      sourceMailboxMessageId: "message_abort",
    });
    expect(retryRuntime.inputs).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function taskCreatedEvent(
  taskId: TaskId,
  path: AgentPath,
  childSessionId: string,
  childThreadId: string,
  time: number,
): Extract<ChiliEvent, { type: "agent.task_created" }> {
  return {
    id: "event_task_created",
    type: "agent.task_created",
    time: time as TimestampMs,
    payload: {
      taskId,
      path,
      parentPath: "/root" as AgentPath,
      parentSessionId: "session_parent" as SessionId,
      parentThreadId: "thread_parent" as ThreadId,
      childSessionId: childSessionId as SessionId,
      childThreadId: childThreadId as ThreadId,
      taskName: "cancelled",
      cwd: "/repo",
      prompt: "run",
      mode: "resumable",
      completionPolicy: "join",
    },
  };
}

function mailboxEvent(
  id: string,
  path: AgentPath,
  childSessionId: string,
  childThreadId: string,
  time: number,
  options: {
    taskId?: TaskId;
    metadata?: Record<string, unknown>;
  } = {},
): Extract<ChiliEvent, { type: "agent.message_queued" }> {
  return {
    id,
    type: "agent.message_queued",
    time: time as TimestampMs,
    payload: {
      ...(options.taskId ? { taskId: options.taskId } : {}),
      path,
      from: "/root" as AgentPath,
      childSessionId: childSessionId as SessionId,
      childThreadId: childThreadId as ThreadId,
      triggerTurn: true,
      message: {
        role: "user",
        content: `deliver ${id}`,
        ...(options.metadata ? { metadata: options.metadata } : {}),
      },
    },
  };
}

class ScriptedRuntime {
  readonly inputs: SubmitPromptInput[] = [];
  readonly startedAt: number[] = [];

  constructor(
    private readonly results: SubmitPromptResult[] = [],
    private readonly onSubmit?: (input: SubmitPromptInput) => Promise<void> | void,
  ) {}

  async appendUserMessage(): Promise<MessageId> {
    return "message_user" as MessageId;
  }

  async submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult> {
    this.inputs.push(input);
    this.startedAt.push(Date.now());
    await this.onSubmit?.(input);
    return this.results.shift() ?? completedResult();
  }
}

class AbortBlockingRuntime {
  readonly started = deferred<void>();

  async submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult> {
    this.started.resolve();
    const signal = input.signal;
    if (!signal) throw new Error("expected mailbox abort signal");
    return new Promise<SubmitPromptResult>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

function completedResult(): SubmitPromptResult {
  return {
    status: "completed",
    turns: [{
      status: "completed",
      turnId: "turn_mailbox" as TurnId,
      assistantMessageId: "message_assistant" as MessageId,
      finishReason: "stop",
    }],
    finishReason: "stop",
  };
}

function sequentialId(): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}_${++sequence}`;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
