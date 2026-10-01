import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliEvent, SessionId, TaskId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { LocalSubagentManager } from "./subagent.js";
import { AgentTaskControlService } from "./task-control.js";

// Stable PRNG and logical lease clock make every action reproducible. The
// runner is a barrier: no provider, process, or external resource is involved.
for (const seed of [0x5eed2026, 0xc0ffee]) {
  test(`admission lifecycle soak seed=${seed}: 250 tasks, reopen, cancel, recover and drain`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "chili-admission-soak-"));
    const filename = join(directory, "state.sqlite");
    const store = new SqliteEventStore(filename);
    let reader = new SqliteEventStore(filename);
    let now = 1_000;
    let renewals = 0;
    const renew = store.renewAgentTaskLease.bind(store);
    store.renewAgentTaskLease = (input) => { renewals++; return renew(input); };
    const random = seeded(seed);
    const calls = new Map<string, number>();
    let manager: LocalSubagentManager | undefined;
    try {
      for (const name of ["legacy", "team"]) await store.append(pendingIntent(name));
      for (let batch = 0; batch < 10; batch++) {
        const controllers = Array.from({ length: 25 }, () => new AbortController());
        const releases = new Map<string, () => void>();
        const started = new Map<string, number>();
        const clock = () => now as TimestampMs;
        manager = new LocalSubagentManager({
          store, now: clock, maxActiveRuns: 4, leaseTtlMs: 100, leaseHeartbeatIntervalMs: 5,
          runner: { async run(input) {
            calls.set(input.runId, (calls.get(input.runId) ?? 0) + 1);
            const index = Number(input.taskName);
            started.set(input.taskId, index);
            await new Promise<void>((resolve, reject) => {
              const abort = () => { cleanup(); reject(new DOMException("seeded cancellation", "AbortError")); };
              const cleanup = () => { releases.delete(input.taskId); input.signal?.removeEventListener("abort", abort); };
              releases.set(input.taskId, () => { cleanup(); resolve(); });
              input.signal?.addEventListener("abort", abort, { once: true });
              if (input.signal?.aborted) abort();
            });
            return { status: "completed", summary: "seeded fake runner" };
          } },
        });
        const handles = await Promise.all(controllers.map((controller, index) => manager!.spawnTask({
          parentSessionId: `session_${seed}_${batch}` as SessionId, cwd: directory,
          taskName: String(index), prompt: "fake barrier", mode: "background", signal: controller.signal,
        })));
        await waitFor(() => started.size === 4);
        // Exercise real heartbeat scheduling against a controlled lease clock.
        const before = renewals;
        now += 30;
        await waitFor(() => renewals >= before + 25);
        reader.close();
        reader = new SqliteEventStore(filename);
        const recovery = new AgentTaskControlService({ store: reader, now: clock,
          runtime: { async submitPrompt() { throw new Error("soak recovery cannot submit"); } } });
        expect((await recovery.reconcileStaleTasks({ staleAfterMs: 0, requireLeaseEvidence: true })).closed).toHaveLength(0);
        // Input-signal cancellation is different from interruptTask: it must
        // still persist a terminal row after the running provider unwinds.
        const firstActive = [...started.values()][0]!;
        controllers[firstActive]!.abort();
        const stoppedId = handles[firstActive]!.taskId;
        await waitFor(() => !releases.has(stoppedId));
        await waitFor(async () => (await reader.agentTask(stoppedId))!.status !== "running");
        const order = shuffle(handles.map((handle, index) => ({ handle, index })), random);
        for (const { handle, index } of order.slice(0, 8)) {
          if (random() < 0.5) controllers[index]!.abort();
          else await manager.interruptTask(handle.taskId);
        }
        if (batch % 3 === 0) {
          now += 200;
          await recovery.reconcileStaleTasks({ staleAfterMs: 0, requireLeaseEvidence: true, limit: 1_000 });
        }
        if (batch % 3 === 1) {
          await manager.shutdown("seeded shutdown");
        } else {
          while (manager.runStats().backgroundTasks > 0) {
            for (const id of shuffle([...releases.keys()], random)) releases.get(id)?.();
            await Bun.sleep(1);
          }
          await manager.shutdown();
        }
        expect(manager.runStats().activeRuns).toBe(0);
        expect(manager.runStats().queuedRuns).toBe(0);
        expect(manager.runStats().backgroundTasks).toBe(0);
        expect(manager.liveTaskIds()).toEqual([]);
        expect(releases.size).toBe(0);
        for (const handle of handles) {
          const row = (await reader.agentTask(handle.taskId))!;
          expect(["completed", "cancelled", "failed", "incomplete"]).toContain(row.status);
          expect(row.leaseOwner).toBeUndefined();
          expect((await reader.agentRuns({ taskId: handle.taskId })).length).toBeLessThanOrEqual(1);
        }
        const afterDrain = renewals;
        await Bun.sleep(15);
        expect(renewals).toBe(afterDrain);
        await recovery.shutdown();
      }
      reader.close();
      reader = new SqliteEventStore(filename);
      expect(await reader.agentTask("intent_legacy" as TaskId)).toMatchObject({ status: "pending", generation: 0 });
      expect(await reader.agentTask("intent_team" as TaskId)).toMatchObject({ status: "pending", generation: 0 });
      expect([...calls.values()].every((count) => count === 1)).toBe(true);
      expect(await reader.agentTasks({ limit: 1_000 })).toHaveLength(252);
    } finally {
      await manager?.shutdown();
      reader.close(); store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
}

function seeded(seed: number) {
  let value = seed >>> 0;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 0x1_0000_0000; };
}
function shuffle<T>(values: T[], random: () => number): T[] {
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other]!, values[index]!];
  }
  return values;
}
function pendingIntent(name: string): Extract<ChiliEvent, { type: "agent.task_created" }> {
  return { id: `create_${name}`, type: "agent.task_created", time: 1 as TimestampMs, sessionId: "session_intent" as SessionId,
    payload: { taskId: `intent_${name}` as TaskId, path: `/root/intent_${name}` as never, parentPath: "/root" as never,
      parentSessionId: "session_intent" as SessionId, childSessionId: `child_${name}` as SessionId,
      taskName: name, cwd: "/fixture", prompt: "retained intent", mode: "background",
      ...(name === "team" ? { workerPolicy: { teamId: "team_keep", taskId: "team_task_keep" } } : {}) } };
}
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("seeded fixture did not settle");
    await Bun.sleep(1);
  }
}

for (const recoverFirst of [false, true]) {
  test(`a delayed successful follow-up lease receipt cannot start an expired run (recovered=${recoverFirst})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "chili-followup-receipt-"));
    const filename = join(directory, "state.sqlite");
    const store = new SqliteEventStore(filename);
    const reader = new SqliteEventStore(filename);
    let now = 1_000;
    const clock = () => now as TimestampMs;
    const manager = new LocalSubagentManager({ store, now: clock,
      runner: { async run() { return { status: "completed" }; } } });
    let release!: () => void;
    let entered!: () => void;
    const receipt = new Promise<void>((resolve) => { release = resolve; });
    const committed = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const control = new AgentTaskControlService({ store, now: clock, leaseTtlMs: 100,
      runtime: { async submitPrompt() { calls++; throw new Error("stale follow-up started"); } } });
    const recovery = new AgentTaskControlService({ store: reader, now: clock,
      runtime: { async submitPrompt() { throw new Error("recovery cannot submit"); } } });
    try {
      const task = await manager.spawnTask({ parentSessionId: "receipt_parent" as SessionId,
        cwd: directory, taskName: "follow-up", prompt: "fake" });
      const renew = store.renewAgentTaskLease.bind(store);
      let delayed = false;
      store.renewAgentTaskLease = async (input) => {
        if (!delayed && input.owner.startsWith("task-followup:")) now += 10;
        const result = await renew({ ...input, now });
        if (!delayed && input.owner.startsWith("task-followup:") && result.acquired) {
          delayed = true; entered(); await receipt;
        }
        return result;
      };
      const attempt = control.followupTask({ taskId: task.taskId, text: "continue" }).catch((error: unknown) => error);
      await committed;
      now += 200;
      if (recoverFirst) expect((await recovery.reconcileStaleTasks({ staleAfterMs: 0, requireLeaseEvidence: true, modes: ["one_shot"] })).closed).toHaveLength(1);
      release();
      await attempt;
      expect(calls).toBe(0);
      expect((await reader.agentTask(task.taskId))!.status).toBe(recoverFirst ? "cancelled" : "incomplete");
      expect((await reader.agentTask(task.taskId))!.leaseOwner).toBeUndefined();
    } finally {
      release();
      await control.shutdown(); await recovery.shutdown(); await manager.shutdown();
      reader.close(); store.close(); await rm(directory, { recursive: true, force: true });
    }
  });

}

test("caller abort while provider-entry lease acknowledgement is pending settles without running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-admission-abort-receipt-"));
  const store = new SqliteEventStore(join(directory, "state.sqlite"));
  const controller = new AbortController();
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const committed = new Promise<void>((resolve) => { entered = resolve; });
  const renew = store.renewAgentTaskLease.bind(store);
  let delayed = false;
  store.renewAgentTaskLease = async (input) => {
    const result = await renew(input);
    if (!delayed && input.generation === 1 && result.acquired) {
      delayed = true; entered(); await barrier;
    }
    return result;
  };
  const manager = new LocalSubagentManager({ store, leaseHeartbeatIntervalMs: 100_000,
    runner: { async run() { calls++; return { status: "completed" }; } } });
  try {
    const pending = manager.spawnTask({ parentSessionId: "abort_receipt_parent" as SessionId,
      cwd: directory, taskName: "abort receipt", prompt: "fake", signal: controller.signal });
    await committed;
    controller.abort(); release();
    const task = await pending;
    expect(calls).toBe(0);
    expect(task.status).toBe("cancelled");
    expect((await store.agentTask(task.taskId))!.status).toBe("cancelled");
    expect((await store.agentTask(task.taskId))!.leaseOwner).toBeUndefined();
  } finally {
    release(); await manager.shutdown(); store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
