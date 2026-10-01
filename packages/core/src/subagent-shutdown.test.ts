import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, TaskId, TimestampMs } from "@chili/protocol";
import type {
  AgentTaskAdmissionInput,
  AgentTaskAdmissionResult,
  AgentTaskBeginRunCasInput,
  AgentTaskBeginRunResult,
  EventAppendOptions,
} from "@chili/store";
import { SqliteEventStore } from "@chili/store";
import {
  LocalSubagentManager,
  type LocalSubagentRunInput,
  type LocalSubagentRunResult,
  type LocalSubagentRunner,
} from "./subagent.js";

test("LocalSubagentManager shutdown cancels and drains active and limiter-queued background tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-shutdown-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  const runner = new AbortAwareSlowSubagentRunner();
  const manager = new LocalSubagentManager({
    store,
    runner,
    createId: createSequentialId(),
    now: () => 100 as TimestampMs,
    maxActiveRuns: 1,
  });
  const shutdowns: Promise<void>[] = [];

  try {
    const active = await manager.spawnTask({
      parentSessionId: "session_shutdown_parent" as SessionId,
      cwd: "/repo",
      taskName: "active background",
      prompt: "Wait until shutdown",
      mode: "background",
    });
    await runner.started.promise;

    const queued = await manager.spawnTask({
      parentSessionId: "session_shutdown_parent" as SessionId,
      cwd: "/repo",
      taskName: "queued background",
      prompt: "Stay behind the limiter",
      mode: "background",
    });
    await waitUntil(() => manager.runStats().queuedRuns === 1);

    expect(manager.runStats()).toMatchObject({
      maxActiveRuns: 1,
      activeRuns: 1,
      queuedRuns: 1,
      peakActiveRuns: 1,
      backgroundTasks: 2,
    });
    expect(runner.startedNames).toEqual(["active background"]);

    const firstShutdown = manager.shutdown("test_shutdown");
    shutdowns.push(firstShutdown);
    const secondShutdown = manager.shutdown("ignored_duplicate_reason");
    shutdowns.push(secondShutdown);

    const rejectedSpawn = manager.spawnTask({
      parentSessionId: "session_shutdown_parent" as SessionId,
      cwd: "/repo",
      taskName: "rejected after shutdown",
      prompt: "Must not be admitted",
      mode: "background",
    });
    await expect(rejectedSpawn).rejects.toThrow();

    await runner.abortObserved.promise;
    await waitUntil(() => manager.runStats().queuedRuns === 0);
    let shutdownSettled = false;
    void firstShutdown.then(
      () => {
        shutdownSettled = true;
      },
      () => {
        shutdownSettled = true;
      },
    );
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);
    expect(runner.startedNames).toEqual(["active background"]);
    expect(runner.abortEvents).toBe(1);

    runner.finish.resolve();
    await Promise.all([firstShutdown, secondShutdown]);
    await manager.shutdown("ignored_after_closed");

    await expect(manager.spawnTask({
      parentSessionId: "session_shutdown_parent" as SessionId,
      cwd: "/repo",
      taskName: "rejected after closure",
      prompt: "Must remain closed",
      mode: "background",
    })).rejects.toThrow();

    expect(await store.agentTask(active.taskId)).toMatchObject({ status: "cancelled" });
    expect(await store.agentTask(queued.taskId)).toMatchObject({ status: "cancelled" });
    expect(await store.agentRuns({ taskId: active.taskId })).toEqual([
      expect.objectContaining({ status: "cancelled" }),
    ]);
    expect(await store.agentRuns({ taskId: queued.taskId })).toEqual([]);

    const taskCreated = await store.events({ type: "agent.task_created", limit: 20 });
    const taskCompleted = await store.events({ type: "agent.task_completed", limit: 20 });
    const agentCompleted = await store.events({ type: "agent.completed", limit: 20 });
    expect(taskCreated).toHaveLength(2);
    expect(taskCompleted.filter((event) => (
      event.type === "agent.task_completed"
      && (event.payload as { taskId?: string }).taskId === active.taskId
      && (event.payload as { status?: string }).status === "cancelled"
    ))).toHaveLength(1);
    expect(taskCompleted.filter((event) => (
      event.type === "agent.task_completed"
      && (event.payload as { taskId?: string }).taskId === queued.taskId
      && (event.payload as { status?: string }).status === "cancelled"
    ))).toHaveLength(1);
    expect(agentCompleted.filter((event) => (
      event.type === "agent.completed" && (event.payload as { taskId?: string }).taskId === active.taskId
    ))).toHaveLength(1);
    expect(agentCompleted.filter((event) => (
      event.type === "agent.completed" && (event.payload as { taskId?: string }).taskId === queued.taskId
    ))).toHaveLength(0);

    expect(runner.startedNames).toEqual(["active background"]);
    expect(runner.abortEvents).toBe(1);
    expect(manager.runStats()).toMatchObject({
      maxActiveRuns: 1,
      activeRuns: 0,
      queuedRuns: 0,
      peakActiveRuns: 1,
      backgroundTasks: 0,
    });
  } finally {
    runner.finish.resolve();
    await Promise.allSettled([...shutdowns, manager.waitForBackgroundTasks()]);
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown fences a task_created append that commits after admission closes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-shutdown-create-fence-"));
  const store = new TaskCreatedAppendBarrierStore(join(dir, "events.sqlite"));
  let runnerCalls = 0;
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 200 as TimestampMs,
    runner: {
      async run() {
        runnerCalls++;
        return { status: "completed", summary: "must not run after shutdown" };
      },
    },
  });
  const taskId = "task_1" as TaskId;
  const spawnAttempt = manager.spawnTask({
    parentSessionId: "session_create_fence_parent" as SessionId,
    cwd: "/repo",
    taskName: "commit after shutdown",
    prompt: "Do not escape the shutdown fence",
    mode: "background",
  });
  const spawnSettlement = spawnAttempt.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  let shutdown: Promise<void> | undefined;

  try {
    await store.appendEntered.promise;
    expect(await store.agentTask(taskId)).toBeUndefined();

    shutdown = manager.shutdown("create_append_fence_shutdown");
    let shutdownSettled = false;
    void shutdown.finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);
    expect(await store.agentTask(taskId)).toBeUndefined();

    store.allowAppend.resolve();
    await store.taskCreatedCommitted.promise;
    expect(await store.agentTask(taskId)).toMatchObject({
      status: expect.stringMatching(/^(pending|cancelled)$/),
      generation: expect.any(Number),
    });

    await Promise.all([spawnSettlement, shutdown]);

    expect(await store.agentTask(taskId)).toMatchObject({
      status: "cancelled",
      generation: 1,
    });
    expect(await store.agentRuns({ taskId })).toEqual([]);
    expect(await store.events({ type: "agent.task_created" })).toHaveLength(1);
    expect(await store.events({ type: "agent.spawned" })).toHaveLength(0);
    const taskCompleted = await store.events({ type: "agent.task_completed" });
    expect(taskCompleted).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          taskId,
          status: "cancelled",
          generation: 1,
        }),
      }),
    ]);
    expect(await store.events({ type: "agent.completed" })).toHaveLength(0);
    expect(runnerCalls).toBe(0);
    expect(manager.liveTaskIds()).toEqual([]);
    expect(manager.runStats()).toMatchObject({
      activeRuns: 0,
      queuedRuns: 0,
      backgroundTasks: 0,
    });
  } finally {
    store.allowAppend.resolve();
    await Promise.allSettled([
      spawnSettlement,
      shutdown ?? manager.shutdown("create_append_fence_cleanup"),
      manager.waitForBackgroundTasks(),
    ]);
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown waits for a committed reserved begin-run CAS and closes its authoritative lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-subagent-shutdown-reserved-cas-fence-"));
  const store = new CommittedBeginRunBarrierStore(join(dir, "events.sqlite"));
  let runnerCalls = 0;
  const reserved = {
    dispatchId: "dispatch_shutdown_reserved_cas",
    taskId: "task_shutdown_reserved_cas" as TaskId,
    runId: "agent_shutdown_reserved_cas" as never,
    childSessionId: "session_shutdown_reserved_cas_child" as SessionId,
    parentSessionId: "session_shutdown_reserved_cas_parent" as SessionId,
    parentPath: "/root" as const,
    cwd: "/repo",
    taskName: "reserved CAS shutdown fence",
    prompt: "Do not begin provider work after shutdown",
    mode: "background" as const,
  };
  const manager = new LocalSubagentManager({
    store,
    createId: createSequentialId(),
    now: () => 300 as TimestampMs,
    leaseTtlMs: 30_000,
    runner: {
      async run() {
        runnerCalls++;
        return { status: "completed", summary: "must not run after shutdown" };
      },
    },
  });
  let shutdown: Promise<void> | undefined;

  try {
    await store.append({
      id: "event_seed_shutdown_reserved_cas",
      type: "agent.task_created",
      time: 100 as TimestampMs,
      sessionId: reserved.parentSessionId,
      payload: {
        taskId: reserved.taskId,
        dispatchId: reserved.dispatchId,
        reservedRunId: reserved.runId,
        path: "/root/task_shutdown_reserved_cas" as never,
        parentPath: reserved.parentPath,
        parentSessionId: reserved.parentSessionId,
        childSessionId: reserved.childSessionId,
        taskName: reserved.taskName,
        cwd: reserved.cwd,
        prompt: reserved.prompt,
        mode: reserved.mode,
      },
    });
    const pending = await store.agentTask(reserved.taskId);
    expect(pending).toMatchObject({
      status: "pending",
      generation: 0,
    });
    expect(pending?.currentRunId).toBeUndefined();
    expect(pending?.leaseOwner).toBeUndefined();

    const handle = await manager.spawnTask(reserved);
    expect(handle).toMatchObject({ taskId: reserved.taskId, status: "pending" });

    const committed = await store.beginCommitted.promise;
    expect(committed).toMatchObject({
      applied: true,
      task: {
        status: "running",
        generation: 1,
        currentRunId: reserved.runId,
        leaseOwner: `local:${reserved.runId}`,
      },
    });
    expect(await store.agentTask(reserved.taskId)).toMatchObject({
      status: "running",
      generation: 1,
      currentRunId: reserved.runId,
      leaseOwner: `local:${reserved.runId}`,
      leaseExpiresAt: 30_300,
    });
    expect(await store.agentRuns({ taskId: reserved.taskId })).toEqual([
      expect.objectContaining({
        id: reserved.runId,
        status: "running",
      }),
    ]);

    shutdown = manager.shutdown("reserved_cas_fence_shutdown");
    let shutdownSettled = false;
    void shutdown.finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);
    expect(await store.agentTask(reserved.taskId)).toMatchObject({
      status: "running",
      generation: 1,
      currentRunId: reserved.runId,
      leaseOwner: `local:${reserved.runId}`,
    });

    store.allowBeginReturn.resolve();
    await shutdown;

    const terminal = await store.agentTask(reserved.taskId);
    expect(terminal).toMatchObject({
      status: "cancelled",
      generation: 2,
      currentRunId: reserved.runId,
    });
    expect(terminal?.leaseOwner).toBeUndefined();
    expect(terminal?.leaseExpiresAt).toBeUndefined();
    expect(await store.agentRuns({ taskId: reserved.taskId })).toEqual([
      expect.objectContaining({
        id: reserved.runId,
        status: "cancelled",
      }),
    ]);
    const taskCompleted = await store.events({ type: "agent.task_completed" });
    expect(taskCompleted).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          taskId: reserved.taskId,
          runId: reserved.runId,
          status: "cancelled",
          generation: 2,
        }),
      }),
    ]);
    const agentCompleted = await store.events({ type: "agent.completed" });
    expect(agentCompleted).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          taskId: reserved.taskId,
          runId: reserved.runId,
          status: "cancelled",
          generation: 2,
        }),
      }),
    ]);
    expect(runnerCalls).toBe(0);
    expect(manager.liveTaskIds()).toEqual([]);
    expect(manager.runStats()).toMatchObject({
      activeRuns: 0,
      queuedRuns: 0,
      backgroundTasks: 0,
    });
  } finally {
    store.allowBeginReturn.resolve();
    await Promise.allSettled([
      shutdown ?? manager.shutdown("reserved_cas_fence_cleanup"),
      manager.waitForBackgroundTasks(),
    ]);
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

class TaskCreatedAppendBarrierStore extends SqliteEventStore {
  readonly appendEntered = deferred<void>();
  readonly allowAppend = deferred<void>();
  readonly taskCreatedCommitted = deferred<void>();
  private interceptTaskCreated = true;

  override async admitAgentTask(input: AgentTaskAdmissionInput): Promise<AgentTaskAdmissionResult> {
    if (!this.interceptTaskCreated) return super.admitAgentTask(input);
    this.interceptTaskCreated = false;
    this.appendEntered.resolve();
    await this.allowAppend.promise;
    const result = await super.admitAgentTask(input);
    this.taskCreatedCommitted.resolve();
    return result;
  }
}

class CommittedBeginRunBarrierStore extends SqliteEventStore {
  readonly beginCommitted = deferred<AgentTaskBeginRunResult>();
  readonly allowBeginReturn = deferred<void>();
  private interceptBeginRun = true;

  override async beginAgentTaskRunCas(
    input: AgentTaskBeginRunCasInput,
  ): Promise<AgentTaskBeginRunResult> {
    const result = await super.beginAgentTaskRunCas(input);
    if (!this.interceptBeginRun) return result;
    this.interceptBeginRun = false;
    this.beginCommitted.resolve(result);
    await this.allowBeginReturn.promise;
    return result;
  }
}

class AbortAwareSlowSubagentRunner implements LocalSubagentRunner {
  readonly started = deferred<void>();
  readonly abortObserved = deferred<void>();
  readonly finish = deferred<void>();
  readonly startedNames: string[] = [];
  abortEvents = 0;

  async run(input: LocalSubagentRunInput): Promise<LocalSubagentRunResult> {
    this.startedNames.push(input.taskName);
    this.started.resolve();
    const signal = requiredSignal(input.signal);
    await this.waitForAbort(signal);
    await this.finish.promise;
    return {
      status: "cancelled",
      error: abortReason(signal),
    };
  }

  private async waitForAbort(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.abortEvents += 1;
      this.abortObserved.resolve();
      return;
    }
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        this.abortEvents += 1;
        this.abortObserved.resolve();
        resolve();
      }, { once: true });
    });
  }
}

function requiredSignal(signal: AbortSignal | undefined): AbortSignal {
  if (!signal) throw new Error("Expected LocalSubagentManager to pass a run signal");
  return signal;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Local subagent shutdown");
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
