import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliEvent, SessionId, TaskId, TimestampMs } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore, type EventMirror } from "@chili/store";
import { LocalSubagentManager, type LocalSubagentRunLimiter } from "./subagent.js";
import { AgentTaskControlService } from "./task-control.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

for (const barrierType of ["agent.task_created", "agent.spawned"] as const) {
  test(`admission keeps ownership while ${barrierType} mirror is blocked`, async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let blocked = false;
    const mirror: EventMirror = {
      async write(event) {
        if (!blocked && event.type === barrierType) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
      },
    };
    const fixture = await setup({ mirror });
    let runnerCalls = 0;
    const manager = new LocalSubagentManager({
      store: new ObservableEventStore(fixture.store),
      leaseTtlMs: 150,
      leaseHeartbeatIntervalMs: 15,
      runner: { async run() { runnerCalls++; return { status: "completed", summary: "done" }; } },
    });
    cleanups.push(async () => { release.resolve(); await manager.shutdown(); });
    const pending = manager.spawnTask(taskInput());
    await entered.promise;
    const before = (await fixture.reader.agentTasks())[0]!;
    expect(before.status).toBe(barrierType === "agent.task_created" ? "pending" : "running");
    expect(before.generation).toBe(barrierType === "agent.task_created" ? 0 : 1);
    expect(before.leaseOwner).toMatch(/^admission:v1:[0-9a-f-]{36}$/);
    const initialExpiry = before.leaseExpiresAt!;
    await waitFor(async () => Date.now() > initialExpiry && (await fixture.reader.agentTask(before.id))!.leaseExpiresAt! > Date.now());
    const after = (await fixture.reader.agentTask(before.id))!;
    expect(after.leaseOwner).toBe(before.leaseOwner);
    expect(after.leaseExpiresAt!).toBeGreaterThan(initialExpiry);
    expect((await fixture.recovery.reconcileStaleTasks({ staleAfterMs: 0, requireLeaseEvidence: true })).closed).toEqual([]);
    expect(runnerCalls).toBe(0);
    release.resolve();
    await pending;
    await manager.waitForBackgroundTasks();
    expect(runnerCalls).toBe(1);
    expect((await fixture.reader.agentTask(before.id))!.status).toBe("completed");
    expect(await fixture.reader.agentRuns({ taskId: before.id })).toHaveLength(1);
  });
}

test("a delayed gen0 renewal receipt cannot cancel its successfully claimed gen1", async () => {
  const spawnMirrorEntered = deferred<void>();
  const releaseSpawnMirror = deferred<void>();
  const renewalEntered = deferred<void>();
  const releaseRenewal = deferred<void>();
  const fixture = await setup({ mirror: { async write(event) {
    if (event.type === "agent.spawned") {
      spawnMirrorEntered.resolve();
      await releaseSpawnMirror.promise;
    }
  } } });
  const renew = fixture.store.renewAgentTaskLease.bind(fixture.store);
  let delayed = false;
  fixture.store.renewAgentTaskLease = async (input) => {
    const result = await renew(input);
    if (!delayed && input.generation === 0 && !result.acquired && result.task?.generation === 1) {
      delayed = true;
      renewalEntered.resolve();
      await releaseRenewal.promise;
    }
    return result;
  };
  let runnerCalls = 0;
  const manager = new LocalSubagentManager({
    store: fixture.store, leaseTtlMs: 1_000, leaseHeartbeatIntervalMs: 10,
    runner: { async run() { runnerCalls++; return { status: "completed" }; } },
  });
  cleanups.push(async () => { releaseSpawnMirror.resolve(); releaseRenewal.resolve(); await manager.shutdown(); });
  const task = await manager.spawnTask(taskInput());
  await spawnMirrorEntered.promise;
  await renewalEntered.promise;
  releaseSpawnMirror.resolve();
  // Let initial-CAS delivery finish while the old-generation renewal receipt
  // remains parked. The runner's final lease check is waiting on that receipt.
  await Bun.sleep(20);
  releaseRenewal.resolve();
  await manager.waitForBackgroundTasks();
  expect(runnerCalls).toBe(1);
  expect((await fixture.reader.agentTask(task.taskId))!.status).toBe("completed");
});

test("lease loss waits for delayed admission commit before finalizing its row", async () => {
  let now = 1_000;
  const clock = () => ++now as TimestampMs;
  const fixture = await setup({ now: clock });
  const admissionEntered = deferred<void>();
  const releaseAdmission = deferred<void>();
  const renewObservedNoTask = deferred<void>();
  const admit = fixture.store.admitAgentTask.bind(fixture.store);
  fixture.store.admitAgentTask = async (input) => {
    admissionEntered.resolve();
    await releaseAdmission.promise;
    return admit(input);
  };
  const renew = fixture.store.renewAgentTaskLease.bind(fixture.store);
  fixture.store.renewAgentTaskLease = async (input) => {
    const result = await renew(input);
    if (!result.task) renewObservedNoTask.resolve();
    return result;
  };
  let runnerCalls = 0;
  const manager = new LocalSubagentManager({
    store: fixture.store, now: clock, leaseTtlMs: 1_000, leaseHeartbeatIntervalMs: 10,
    runner: { async run() { runnerCalls++; return { status: "completed" }; } },
  });
  cleanups.push(async () => { releaseAdmission.resolve(); await manager.shutdown(); });
  const attempt = manager.spawnTask(taskInput());
  await admissionEntered.promise;
  await renewObservedNoTask.promise;
  await Bun.sleep(10);
  releaseAdmission.resolve();
  const task = await attempt;
  await manager.waitForBackgroundTasks();
  expect(runnerCalls).toBe(0);
  expect((await fixture.reader.agentTask(task.taskId))!.status).toBe("cancelled");
});

for (const barrierType of ["agent.task_created", "agent.spawned"] as const) {
  test(`interrupt retains ownership while ${barrierType} mirror drains beyond the original TTL`, async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const fixture = await setup({ mirror: { async write(event) {
      if (event.type === barrierType) { entered.resolve(); await release.promise; }
    } } });
    let runnerCalls = 0;
    const manager = new LocalSubagentManager({
      store: fixture.store, leaseTtlMs: 150, leaseHeartbeatIntervalMs: 15,
      runner: { async run() { runnerCalls++; return { status: "completed" }; } },
    });
    cleanups.push(async () => { release.resolve(); await manager.shutdown(); });
    const attempt = manager.spawnTask(taskInput());
    await entered.promise;
    const initial = (await fixture.reader.agentTasks())[0]!;
    const interruption = manager.interruptTask(initial.id);
    await waitFor(() => Date.now() > initial.leaseExpiresAt! + 150);
    const pendingClose = (await fixture.reader.agentTask(initial.id))!;
    expect(pendingClose.leaseOwner).toBe(initial.leaseOwner);
    expect(pendingClose.leaseExpiresAt!).toBeGreaterThan(Date.now());
    release.resolve();
    await attempt;
    expect(await interruption).toBe(true);
    await manager.waitForBackgroundTasks();
    expect((await fixture.reader.agentTask(initial.id))!.status).toBe("cancelled");
    expect((await fixture.reader.agentTask(initial.id))!.leaseOwner).toBeUndefined();
    expect(runnerCalls).toBe(0);
  });
}

for (const receiptGeneration of [0, 1]) {
  test(`a delayed successful gen${receiptGeneration} renewal cannot authorize an expired runner`, async () => {
    let now = 1_000;
    const fixture = await setup({ now: () => now as TimestampMs });
    const gate = new GateLimiter();
    const afterSpawn = deferred<void>();
    const renewalEntered = deferred<void>();
    const releaseRenewal = deferred<void>();
    const renew = fixture.store.renewAgentTaskLease.bind(fixture.store);
    let delayed = false;
    fixture.store.renewAgentTaskLease = async (input) => {
      const result = await renew(input);
      if (!delayed && input.generation === receiptGeneration && result.acquired) {
        delayed = true;
        renewalEntered.resolve();
        await releaseRenewal.promise;
      }
      return result;
    };
    let checks = 0;
    let runnerCalls = 0;
    const manager = new LocalSubagentManager({
      store: fixture.store, now: () => now as TimestampMs, leaseTtlMs: 100, leaseHeartbeatIntervalMs: 10,
      ...(receiptGeneration === 0 ? { runLimiter: gate } : {}),
      assertDelegationEnabled: async () => { if (++checks === 3 && receiptGeneration === 1) await afterSpawn.promise; },
      runner: { async run() { runnerCalls++; return { status: "completed" }; } },
    });
    cleanups.push(async () => { gate.open(); afterSpawn.resolve(); releaseRenewal.resolve(); await manager.shutdown(); });
    const task = await manager.spawnTask(taskInput());
    await renewalEntered.promise;
    gate.open();
    await waitFor(async () => (await fixture.reader.agentTask(task.taskId))!.status === "running");
    now = 1_200;
    expect((await fixture.recovery.reconcileStaleTasks({ staleAfterMs: 0, requireLeaseEvidence: true })).closed).toHaveLength(1);
    afterSpawn.resolve();
    releaseRenewal.resolve();
    await manager.waitForBackgroundTasks();
    expect(runnerCalls).toBe(0);
    expect((await fixture.reader.agentTask(task.taskId))!.status).toBe("cancelled");
  });
}

test("a valid queued admission survives another connection's scan; shutdown closes it without spawning", async () => {
  const fixture = await setup();
  const gate = new GateLimiter();
  let runnerCalls = 0;
  const manager = new LocalSubagentManager({
    store: fixture.store, runLimiter: gate, leaseTtlMs: 150, leaseHeartbeatIntervalMs: 15,
    runner: { async run() { runnerCalls++; return { status: "completed" }; } },
  });
  cleanups.push(() => manager.shutdown());
  const handle = await manager.spawnTask(taskInput());
  const initial = (await fixture.reader.agentTask(handle.taskId))!;
  await waitFor(async () => Date.now() > initial.leaseExpiresAt! && (await fixture.reader.agentTask(handle.taskId))!.leaseExpiresAt! > Date.now());
  expect((await fixture.recovery.reconcileStaleTasks({ staleAfterMs: 0, requireLeaseEvidence: true })).closed).toEqual([]);
  expect((await fixture.reader.agentTask(handle.taskId))!.status).toBe("pending");
  await manager.shutdown("queued admission stopped");
  expect((await fixture.reader.agentTask(handle.taskId))!.status).toBe("cancelled");
  expect(await fixture.reader.agentRuns({ taskId: handle.taskId })).toEqual([]);
  expect(runnerCalls).toBe(0);
});

test("a rejected close retains the lease so the pending task remains recoverable", async () => {
  let now = 1_000;
  const fixture = await setup({ now: () => now as TimestampMs });
  const close = fixture.store.closeAgentTaskCas.bind(fixture.store);
  fixture.store.closeAgentTaskCas = async (input) => ({ applied: false, events: [], task: (await fixture.store.agentTask(input.taskId))! });
  const manager = new LocalSubagentManager({
    store: fixture.store, runLimiter: new GateLimiter(), now: () => now as TimestampMs,
    leaseTtlMs: 100, leaseHeartbeatIntervalMs: 100_000,
    runner: { async run() { throw new Error("closed admission must not run"); } },
  });
  cleanups.push(() => manager.shutdown());
  const task = await manager.spawnTask(taskInput());
  await manager.interruptTask(task.taskId);
  await manager.waitForBackgroundTasks();
  const remaining = (await fixture.reader.agentTask(task.taskId))!;
  expect(remaining.status).toBe("pending");
  expect(remaining.leaseOwner).toMatch(/^admission:v1:/);
  fixture.store.closeAgentTaskCas = close;
  now = 1_200;
  expect((await fixture.recovery.reconcileStaleTasks({ staleAfterMs: 0, requireLeaseEvidence: true })).closed).toHaveLength(1);
});

test("expired admission is recovered ahead of live running rows; its old owner never enters the runner", async () => {
  let now = 1_000;
  const fixture = await setup({ now: () => now as TimestampMs });
  const gate = new GateLimiter();
  let runnerCalls = 0;
  const manager = new LocalSubagentManager({
    store: fixture.store, runLimiter: gate, now: () => now as TimestampMs,
    leaseTtlMs: 100, leaseHeartbeatIntervalMs: 100_000,
    runner: { async run() { runnerCalls++; return { status: "completed" }; } },
  });
  cleanups.push(() => manager.shutdown());
  const handle = await manager.spawnTask(taskInput());
  const token = (await fixture.reader.agentTask(handle.taskId))!.leaseOwner!;
  for (let index = 0; index < 8; index++) {
    const event = taskCreated(`live_${index}`);
    await fixture.store.admitAgentTask({ event, owner: `admission:v1:other_${index}`, ttlMs: 10_000, now });
    await fixture.store.beginAgentTaskRunCas({
      taskId: event.payload.taskId, expectedGeneration: 0, expectedRunId: null,
      expectedLeaseOwner: `admission:v1:other_${index}`, runId: `run_live_${index}` as never, generation: 1,
      leaseOwner: `admission:v1:other_${index}`, leaseTtlMs: 10_000, spawnEventId: `spawn_live_${index}`,
      admittedInitial: true, time: now,
    });
  }
  // Legacy pending and team dispatch intents have no admission owner. Even
  // ancient timestamps and a one-row scan budget must not authorize deletion.
  await fixture.store.append(taskCreated("legacy"));
  const team = taskCreated("team");
  team.payload.dispatchId = "dispatch_keep";
  team.payload.reservedRunId = "run_keep" as never;
  await fixture.store.append(team);
  now = 1_500;
  const recovered = await fixture.recovery.reconcileStaleTasks({ staleAfterMs: 0, requireLeaseEvidence: true, limit: 1 });
  expect(recovered.closed.map((task) => task.id)).toEqual([handle.taskId]);
  expect((await fixture.reader.agentTask("task_legacy" as TaskId))!.status).toBe("pending");
  expect((await fixture.reader.agentTask("task_team" as TaskId))!.status).toBe("pending");
  expect((await fixture.reader.agentTasks({ status: "running" })).length).toBe(8);
  const denied = await fixture.store.beginAgentTaskRunCas({
    taskId: handle.taskId, expectedGeneration: 0, expectedRunId: null, expectedLeaseOwner: token,
    runId: handle.runId, generation: 1, leaseOwner: token, leaseTtlMs: 100,
    spawnEventId: "stale_spawn", admittedInitial: true, time: now,
  });
  expect(denied.applied).toBe(false);
  gate.open();
  await manager.waitForBackgroundTasks();
  expect(runnerCalls).toBe(0);
  expect(await fixture.reader.agentRuns({ taskId: handle.taskId })).toEqual([]);
});

test("a legacy team-policy task keeps its existing lifecycle without ordinary admission", async () => {
  const fixture = await setup();
  let owner: string | undefined;
  const manager = new LocalSubagentManager({
    store: fixture.store,
    runner: { async run(input) {
      owner = (await fixture.reader.agentTask(input.taskId))?.leaseOwner;
      return { status: "completed" };
    } },
  });
  cleanups.push(() => manager.shutdown());
  const task = await manager.spawnTask({ ...taskInput(), workerPolicy: { teamId: "team_legacy" as never, taskId: "team_task_legacy" as TaskId } });
  await manager.waitForBackgroundTasks();
  expect(owner).toBe(`local:${task.runId}`);
  expect((await fixture.reader.agentTask(task.taskId))!.status).toBe("completed");
});

for (const failureType of ["agent.task_created", "agent.spawned"] as const) {
  test(`a lost ${failureType} acknowledgement settles the owned row without running`, async () => {
    const fixture = await setup();
    if (failureType === "agent.task_created") {
      const admit = fixture.store.admitAgentTask.bind(fixture.store);
      fixture.store.admitAgentTask = async (input) => {
        await admit(input);
        throw new Error("fixture acknowledgement lost");
      };
    } else {
      const begin = fixture.store.beginAgentTaskRunCas.bind(fixture.store);
      fixture.store.beginAgentTaskRunCas = async (input) => {
        await begin(input);
        throw new Error("fixture acknowledgement lost");
      };
    }
    let runnerCalls = 0;
    const manager = new LocalSubagentManager({
      store: fixture.store,
      runner: { async run() { runnerCalls++; return { status: "completed" }; } },
    });
    cleanups.push(() => manager.shutdown());
    const attempt = manager.spawnTask(taskInput());
    if (failureType === "agent.task_created") await expect(attempt).rejects.toThrow("acknowledgement lost");
    else await attempt;
    await manager.waitForBackgroundTasks();
    const task = (await fixture.reader.agentTasks())[0]!;
    expect(task.status).toBe("failed");
    expect(task.error).toContain("acknowledgement lost");
    expect(runnerCalls).toBe(0);
    const runs = await fixture.reader.agentRuns({ taskId: task.id });
    expect(runs).toHaveLength(failureType === "agent.spawned" ? 1 : 0);
    if (runs.length) expect(runs[0]!.status).toBe("failed");
  });
}

async function setup(options: { mirror?: EventMirror; now?: () => TimestampMs } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "chili-task-admission-"));
  const filename = join(directory, "state.sqlite");
  const store = new SqliteEventStore(filename, options.mirror ? { mirror: options.mirror } : {});
  const reader = new SqliteEventStore(filename);
  const recovery = new AgentTaskControlService({
    store: reader,
    runtime: { async submitPrompt() { throw new Error("fixture recovery must not submit a prompt"); } },
    ...(options.now ? { now: options.now } : {}),
  });
  cleanups.push(async () => { reader.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, reader, recovery };
}

function taskInput() {
  return { parentSessionId: "session_admission" as SessionId, cwd: "/fixture", taskName: "queued task", prompt: "fake runner only", mode: "background" as const };
}

function taskCreated(name: string): Extract<ChiliEvent, { type: "agent.task_created" }> {
  return { id: `create_${name}`, type: "agent.task_created", time: 1 as TimestampMs, sessionId: "session_admission" as SessionId,
    payload: { taskId: `task_${name}` as TaskId, path: `/root/task_${name}` as never, parentPath: "/root" as never,
      parentSessionId: "session_admission" as SessionId, childSessionId: `child_${name}` as SessionId,
      taskName: name, cwd: "/fixture", prompt: "fake", mode: "background" } };
}

class GateLimiter implements LocalSubagentRunLimiter {
  private readonly ready = deferred<void>();
  open() { this.ready.resolve(); }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([this.ready.promise, new Promise<never>((_, reject) => {
        onAbort = () => reject(signal?.reason ?? new Error("aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
      })]);
      return () => undefined;
    } finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("admission fixture did not settle");
    await Bun.sleep(10);
  }
}
