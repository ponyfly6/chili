import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  AgentPath,
  AgentRunId,
  ChiliEvent,
  SessionId,
  TaskId,
  TimestampMs,
} from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import type { SubmitPromptInput, SubmitPromptResult } from "./runtime-service.js";
import { LocalSubagentConcurrencyLimiter } from "./subagent-run-limiter.js";
import {
  AgentTaskControlService,
  AgentTaskControlServiceClosedError,
  type AgentTaskPromptRuntime,
} from "./task-control.js";

test("AgentTaskControlService shutdown cancels and drains permit-pending and provider-active follow-ups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-task-control-shutdown-"));
  const store = new CountingSqliteEventStore(join(dir, "events.sqlite"));
  const runtime = new AbortAwareSlowTaskRuntime();
  const limiter = new LocalSubagentConcurrencyLimiter(1);
  const activeTaskId = "task_shutdown_active" as TaskId;
  const pendingTaskId = "task_shutdown_pending" as TaskId;
  const rejectedTaskId = "task_shutdown_rejected" as TaskId;
  const service = new AgentTaskControlService({
    store,
    runtime,
    runLimiter: limiter,
    createId: createSequentialId(),
    now: () => 100 as TimestampMs,
    leaseTtlMs: 1_000,
    leaseHeartbeatIntervalMs: 5,
  });
  const operations: Promise<unknown>[] = [];

  try {
    await seedCompletedTask(store, activeTaskId, "session_shutdown_active" as SessionId);
    await seedCompletedTask(store, pendingTaskId, "session_shutdown_pending" as SessionId);
    await seedCompletedTask(store, rejectedTaskId, "session_shutdown_rejected" as SessionId);

    let activeSettled = false;
    const activeOutcome = service.followupTask({
      taskId: activeTaskId,
      text: "stay in the provider",
    }).then(
      (value) => {
        activeSettled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        activeSettled = true;
        return { ok: false as const, error };
      },
    );
    operations.push(activeOutcome);
    await runtime.started.promise;
    await waitUntil(() => store.renewLeaseCalls >= 2);

    let pendingSettled = false;
    const pendingOutcome = service.followupTask({
      taskId: pendingTaskId,
      text: "wait for a limiter permit",
    }).then(
      (value) => {
        pendingSettled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        pendingSettled = true;
        return { ok: false as const, error };
      },
    );
    operations.push(pendingOutcome);
    await waitUntil(() => limiter.snapshot().queuedRuns === 1);

    expect(limiter.snapshot()).toEqual({
      maxActiveRuns: 1,
      activeRuns: 1,
      queuedRuns: 1,
    });
    expect(await store.agentTask(activeTaskId)).toMatchObject({
      status: "running",
      generation: 1,
      leaseOwner: expect.stringContaining("task-followup:"),
    });
    expect(await store.agentTask(pendingTaskId)).toMatchObject({
      status: "completed",
      generation: 0,
    });

    const firstShutdown = service.shutdown("test_task_control_shutdown");
    operations.push(firstShutdown);
    const secondShutdown = service.shutdown("ignored_duplicate_reason");
    operations.push(secondShutdown);
    expect(secondShutdown).toBe(firstShutdown);

    await expect(service.followupTask({
      taskId: rejectedTaskId,
      text: "must not be admitted",
    })).rejects.toBeInstanceOf(AgentTaskControlServiceClosedError);
    expect(runtime.abortEvents).toBe(1);
    expect(runtime.inputs).toHaveLength(1);

    const pendingResult = await pendingOutcome;
    expect(pendingResult.ok).toBe(false);
    if (!pendingResult.ok) expect(pendingResult.error).toMatchObject({ name: "AbortError" });
    expect(pendingSettled).toBe(true);
    expect(activeSettled).toBe(false);
    expect(limiter.snapshot()).toEqual({
      maxActiveRuns: 1,
      activeRuns: 1,
      queuedRuns: 0,
    });

    let shutdownSettled = false;
    void firstShutdown.then(() => {
      shutdownSettled = true;
    });
    await runtime.abortObserved.promise;
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(await store.agentTask(activeTaskId)).toMatchObject({ status: "running" });

    runtime.finish.resolve();
    await firstShutdown;

    expect(shutdownSettled).toBe(true);
    expect(activeSettled).toBe(true);
    const activeResult = await activeOutcome;
    expect(activeResult.ok).toBe(false);
    if (!activeResult.ok) expect(activeResult.error).toMatchObject({ name: "AbortError" });

    const activeTask = await store.agentTask(activeTaskId);
    expect(activeTask).toMatchObject({
      status: "cancelled",
      generation: 1,
      error: "test_task_control_shutdown",
    });
    expect(activeTask?.leaseOwner).toBeUndefined();
    expect(activeTask?.leaseExpiresAt).toBeUndefined();
    expect((await store.agentRuns({ taskId: activeTaskId })).map((run) => run.status))
      .toEqual(["completed", "cancelled"]);
    expect(await store.agentMailbox({ taskId: activeTaskId })).toMatchObject([
      { status: "consumed", triggerTurn: true },
    ]);

    expect(await store.agentTask(pendingTaskId)).toMatchObject({
      status: "completed",
      generation: 0,
      summary: "initial answer",
    });
    expect((await store.agentRuns({ taskId: pendingTaskId })).map((run) => run.status))
      .toEqual(["completed"]);
    expect(await store.agentMailbox({ taskId: pendingTaskId })).toEqual([]);

    expect(await store.events({ type: "agent.task_completed", limit: 20 })).toMatchObject([
      { payload: { taskId: activeTaskId, status: "cancelled", generation: 1 } },
    ]);
    expect(await store.events({ type: "agent.message_consumed", limit: 20 })).toMatchObject([
      { payload: { taskId: activeTaskId } },
    ]);
    expect(limiter.snapshot()).toEqual({
      maxActiveRuns: 1,
      activeRuns: 0,
      queuedRuns: 0,
    });

    const renewalsAfterShutdown = store.renewLeaseCalls;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.renewLeaseCalls).toBe(renewalsAfterShutdown);

    const thirdShutdown = service.shutdown("ignored_after_closed");
    expect(thirdShutdown).toBe(firstShutdown);
    await thirdShutdown;
    expect(await store.events({ type: "agent.task_completed", limit: 20 })).toHaveLength(1);
    expect(await store.events({ type: "agent.message_consumed", limit: 20 })).toHaveLength(1);
  } finally {
    const cleanupShutdown = service.shutdown("test_cleanup");
    runtime.finish.resolve();
    await Promise.allSettled([...operations, cleanupShutdown]);
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class AbortAwareSlowTaskRuntime implements AgentTaskPromptRuntime {
  readonly started = deferred<void>();
  readonly abortObserved = deferred<void>();
  readonly finish = deferred<void>();
  readonly inputs: SubmitPromptInput[] = [];
  abortEvents = 0;

  async submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult> {
    this.inputs.push(input);
    this.started.resolve();
    const signal = requiredSignal(input.signal);
    if (signal.aborted) {
      this.abortEvents += 1;
      this.abortObserved.resolve();
    } else {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          this.abortEvents += 1;
          this.abortObserved.resolve();
          resolve();
        }, { once: true });
      });
    }
    await this.finish.promise;
    throw abortReason(signal);
  }
}

class CountingSqliteEventStore extends SqliteEventStore {
  renewLeaseCalls = 0;

  override renewAgentTaskLease(
    input: Parameters<SqliteEventStore["renewAgentTaskLease"]>[0],
  ): ReturnType<SqliteEventStore["renewAgentTaskLease"]> {
    this.renewLeaseCalls += 1;
    return super.renewAgentTaskLease(input);
  }
}

async function seedCompletedTask(
  store: SqliteEventStore,
  taskId: TaskId,
  childSessionId: SessionId,
): Promise<void> {
  const parentSessionId = "session_shutdown_parent" as SessionId;
  const runId = `agent_initial_${taskId}` as AgentRunId;
  const path = `/root/${taskId}` as AgentPath;
  const parentPath = "/root" as AgentPath;
  const time = 1 as TimestampMs;
  const events: ChiliEvent[] = [
    {
      id: `event_task_created_${taskId}`,
      type: "agent.task_created",
      time,
      sessionId: parentSessionId,
      payload: {
        taskId,
        path,
        parentPath,
        parentSessionId,
        childSessionId,
        taskName: String(taskId),
        cwd: "/repo",
        prompt: "initial task",
        mode: "background",
      },
    },
    {
      id: `event_spawned_${taskId}`,
      type: "agent.spawned",
      time,
      sessionId: parentSessionId,
      payload: {
        runId,
        taskId,
        path,
        parentPath,
        parentSessionId,
        childSessionId,
        taskName: String(taskId),
        cwd: "/repo",
        mode: "background",
      },
    },
    {
      id: `event_completed_${taskId}`,
      type: "agent.completed",
      time,
      sessionId: parentSessionId,
      payload: {
        runId,
        taskId,
        path,
        status: "completed",
        summary: "initial answer",
      },
    },
  ];
  await store.appendMany(events);
}

function requiredSignal(signal: AbortSignal | undefined): AbortSignal {
  if (!signal) throw new Error("Expected AgentTaskControlService to pass a follow-up signal");
  return signal;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Task follow-up aborted");
  error.name = "AbortError";
  return error;
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T | PromiseLike<T>): void } {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise(value as T | PromiseLike<T>);
    },
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
