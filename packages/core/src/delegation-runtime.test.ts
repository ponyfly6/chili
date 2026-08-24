import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId, ThreadId, TimestampMs } from "@chili/protocol";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import { DelegationPolicyGate } from "./delegation.js";
import type { AgentRunner } from "./runner.js";
import { RuntimeService } from "./runtime-service.js";
import { LocalSubagentManager } from "./subagent.js";

test("delegation policy reads the durable latest value across runtime instances and event pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-delegation-runtime-"));
  const path = join(dir, "events.sqlite");
  const firstStore = new SqliteEventStore(path);
  const secondStore = new SqliteEventStore(path);
  const sessionId = "session_shared_delegation" as SessionId;
  const threadId = "thread_shared_delegation" as ThreadId;
  const first = runtimeService(firstStore);
  const second = runtimeService(secondStore);

  try {
    expect((await first.getDelegationConfig(sessionId)).policy).toBe("explicit");

    await second.setDelegationPolicy({ sessionId, threadId, policy: "off" });
    expect(await first.getDelegationConfig(sessionId)).toMatchObject({
      sessionId,
      policy: "off",
      source: "session",
    });

    const laterEvents = Array.from({ length: 501 }, (_, index): ChiliEvent => ({
      id: `event_delegation_page_${index}`,
      type: "session.delegation_changed",
      time: (index + 10) as TimestampMs,
      sessionId,
      threadId,
      payload: {
        sessionId,
        policy: index === 500 ? "proactive" : index % 2 === 0 ? "explicit" : "off",
      },
    }));
    await secondStore.appendMany(laterEvents);

    expect(await first.getDelegationConfig(sessionId)).toMatchObject({
      sessionId,
      policy: "proactive",
      source: "session",
    });
  } finally {
    firstStore.close();
    secondStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a task cancelled during the post-permit delegation check never spawns a ghost run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-delegation-cancel-race-"));
  const store = new SqliteEventStore(join(dir, "events.sqlite"));
  let gateCalls = 0;
  let releasePostPermitGate: (() => void) | undefined;
  const postPermitGate = new Promise<void>((resolve) => {
    releasePostPermitGate = resolve;
  });
  let runnerCalls = 0;
  const manager = new LocalSubagentManager({
    store,
    assertDelegationEnabled: async () => {
      gateCalls += 1;
      if (gateCalls === 2) await postPermitGate;
    },
    runner: {
      async run() {
        runnerCalls += 1;
        return { status: "completed", summary: "must not run" };
      },
    },
  });

  try {
    const task = await manager.spawnTask({
      parentSessionId: "session_cancel_race" as SessionId,
      parentThreadId: "thread_cancel_race" as ThreadId,
      cwd: "/repo",
      taskName: "cancel during delegation gate",
      prompt: "must not run",
      mode: "background",
    });
    await waitUntil(() => gateCalls === 2);

    expect(await manager.interruptTask(task.taskId)).toBe(true);
    releasePostPermitGate?.();
    await manager.waitForBackgroundTasks();

    expect(runnerCalls).toBe(0);
    expect(await store.events({ type: "agent.spawned", limit: 10 })).toEqual([]);
    expect(await store.agentTask(task.taskId)).toMatchObject({
      id: task.taskId,
      status: "cancelled",
    });
    expect((await store.agentTask(task.taskId))?.currentRunId).toBeUndefined();
  } finally {
    releasePostPermitGate?.();
    await manager.waitForBackgroundTasks();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a durable off written by another runtime after spawn prevents the local runner call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-delegation-post-spawn-"));
  const path = join(dir, "events.sqlite");
  const managerStoreBase = new SqliteEventStore(path);
  const managerStore = new ObservableEventStore(managerStoreBase);
  const policyWriterStore = new SqliteEventStore(path);
  const policyReader = runtimeService(managerStoreBase);
  const policyWriter = runtimeService(policyWriterStore);
  const parentSessionId = "session_post_spawn_policy" as SessionId;
  const parentThreadId = "thread_post_spawn_policy" as ThreadId;
  const gate = new DelegationPolicyGate({
    store: managerStore,
    getDelegationConfig: (sessionId) => policyReader.getDelegationConfig(sessionId),
  });
  let policyWrite: Promise<unknown> | undefined;
  let gateChecks = 0;
  let runnerCalls = 0;
  managerStore.subscribe((event) => {
    if (event.type === "agent.spawned") {
      policyWrite = policyWriter.setDelegationPolicy({
        sessionId: parentSessionId,
        threadId: parentThreadId,
        policy: "off",
      });
    }
  });
  const manager = new LocalSubagentManager({
    store: managerStore,
    assertDelegationEnabled: async (input) => {
      gateChecks += 1;
      if (policyWrite) await policyWrite;
      await gate.assertEnabled(input);
    },
    runner: {
      async run() {
        runnerCalls += 1;
        return { status: "completed", summary: "must not run" };
      },
    },
  });

  try {
    const task = await manager.spawnTask({
      parentSessionId,
      parentThreadId,
      cwd: "/repo",
      taskName: "post-spawn policy fence",
      prompt: "must not run",
      mode: "background",
    });
    await manager.waitForBackgroundTasks();

    expect(gateChecks).toBe(3);
    expect(runnerCalls).toBe(0);
    expect((await policyReader.getDelegationConfig(parentSessionId)).policy).toBe("off");
    expect(await managerStore.events({ type: "agent.spawned", limit: 10 })).toHaveLength(1);
    expect(await managerStore.agentTask(task.taskId)).toMatchObject({
      id: task.taskId,
      status: "failed",
      error: expect.stringContaining("Delegation policy is off"),
    });
    expect(await managerStore.events({ type: "agent.completed", limit: 10 })).toHaveLength(1);
  } finally {
    await policyWrite;
    await manager.waitForBackgroundTasks();
    managerStoreBase.close();
    policyWriterStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function runtimeService(store: SqliteEventStore): RuntimeService {
  return new RuntimeService({
    runtime: {} as AgentRunner,
    store,
    cwd: "/repo",
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for delegation race checkpoint");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
