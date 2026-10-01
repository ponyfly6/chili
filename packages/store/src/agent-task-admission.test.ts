import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { AgentPath, AgentRunId, ChiliEvent, SessionId, TaskId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore, SessionRunClaimConflictError } from "./sqlite-event-store.js";
import type { AgentTaskBeginRunCasInput, EventMirror } from "./types.js";

const owner = "admission:v1:creator";
type CreatedEvent = Extract<ChiliEvent, { type: "agent.task_created" }>;

function created(name = "initial"): CreatedEvent {
  return {
    id: `event_${name}`,
    type: "agent.task_created",
    time: 100 as TimestampMs,
    sessionId: "session_parent" as SessionId,
    payload: {
      taskId: `task_${name}` as TaskId,
      path: `/root/${name}` as AgentPath,
      parentPath: "/root" as AgentPath,
      parentSessionId: "session_parent" as SessionId,
      childSessionId: `session_${name}` as SessionId,
      taskName: name,
      cwd: "/repo",
      prompt: "Inspect the project",
      mode: "background",
    },
  };
}

function begin(event: CreatedEvent, overrides: Partial<AgentTaskBeginRunCasInput> = {}): AgentTaskBeginRunCasInput {
  return {
    taskId: event.payload.taskId,
    expectedGeneration: 0,
    expectedRunId: null,
    expectedLeaseOwner: owner,
    runId: `run_${event.payload.taskId}` as AgentRunId,
    generation: 1,
    leaseOwner: owner,
    leaseTtlMs: 100,
    spawnEventId: `spawn_${event.payload.taskId}`,
    admittedInitial: true,
    time: 120,
    ...overrides,
  };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withStores(run: (writer: SqliteEventStore, peer: SqliteEventStore) => Promise<void>, mirror?: EventMirror) {
  const directory = await mkdtemp(join(tmpdir(), "chili-task-admission-"));
  const path = join(directory, "events.sqlite");
  const writer = new SqliteEventStore(path, mirror ? { mirror } : {});
  const peer = new SqliteEventStore(path);
  try {
    await run(writer, peer);
  } finally {
    peer.close();
    writer.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("admission publishes its lease atomically before a blocked mirror and returns authoritative state", async () => {
  const entered = gate();
  const release = gate();
  await withStores(async (writer, peer) => {
    const event = created();
    const pending = writer.admitAgentTask({ event, owner, ttlMs: 100, now: 100 });
    try {
      await entered.promise;
      expect(await peer.agentTask(event.payload.taskId)).toMatchObject({
        status: "pending", generation: 0, leaseOwner: owner, leaseExpiresAt: 200, leaseHeartbeatAt: 100,
      });
      expect((await peer.agentTask(event.payload.taskId))?.currentRunId).toBeUndefined();
      expect(await peer.events({ type: "agent.task_created" })).toEqual([event]);
      expect((await peer.renewAgentTaskLease({ taskId: event.payload.taskId, owner, generation: 0, now: 150, ttlMs: 100 })).acquired).toBe(true);
      const started = await peer.beginAgentTaskRunCas(begin(event, { time: 160 }));
      expect(started).toMatchObject({ applied: true, task: { status: "running", generation: 1, leaseOwner: owner } });
    } finally {
      release.resolve();
      await pending;
    }
    expect(await pending).toMatchObject({ applied: true, task: { status: "running", generation: 1, leaseOwner: owner } });
  }, { async write(event) { if (event.type === "agent.task_created") { entered.resolve(); await release.promise; } } });
});

test("duplicates never renew, replace owners, or upgrade an existing unowned pending task", async () => {
  await withStores(async (writer, peer) => {
    const event = created();
    expect((await writer.admitAgentTask({ event, owner, ttlMs: 100, now: 100 })).applied).toBe(true);
    const snapshot = await peer.agentTask(event.payload.taskId);
    if (!snapshot) throw new Error("admitted task was not persisted");
    for (const candidate of [
      { event, owner, now: 110 },
      { event: { ...event, id: "duplicate" }, owner: "admission:v1:other", now: 120 },
      { event: { ...event, payload: { ...event.payload, taskName: "conflicting identity" } }, owner, now: 300 },
    ]) {
      expect(await peer.admitAgentTask({ ...candidate, ttlMs: 500 })).toEqual({ applied: false, task: snapshot, events: [] });
    }
    expect(await peer.events({ type: "agent.task_created" })).toEqual([event]);
    const legacy = created("legacy");
    await writer.append(legacy);
    expect(await peer.admitAgentTask({ event: legacy, owner, ttlMs: 100, now: 150 })).toMatchObject({ applied: false, events: [] });
    expect((await peer.agentTask(legacy.payload.taskId))?.leaseOwner).toBeUndefined();
  });
});

test("initial run CAS rejects wrong owners, expiry and unadmitted paths without publishing a run", async () => {
  await withStores(async (writer, peer) => {
    const event = created();
    await writer.admitAgentTask({ event, owner, ttlMs: 100, now: 100 });
    for (const override of [
      { expectedLeaseOwner: "admission:v1:other", leaseOwner: "admission:v1:other" },
      { leaseOwner: "admission:v1:replacement" },
      { expectedLeaseOwner: null },
      { expectedGeneration: 1, generation: 2 },
      { expectedRunId: "run_other" as AgentRunId },
      { admittedInitial: false },
      { time: 200 },
      { time: 201 },
    ]) {
      expect(await peer.beginAgentTaskRunCas(begin(event, override))).toMatchObject({ applied: false, events: [] });
    }
    await expect(peer.beginAgentTaskRunCas(begin(event, { reservedInitial: true }))).rejects.toThrow();
    await expect(peer.beginAgentTaskRunCas(begin(event, { spawnEventId: event.id }))).rejects.toThrow();
    expect(await peer.agentTask(event.payload.taskId)).toMatchObject({ status: "pending", generation: 0, leaseOwner: owner, leaseExpiresAt: 200 });
    expect(await peer.agentRuns({ taskId: event.payload.taskId })).toEqual([]);
    expect(await peer.events({ type: "agent.spawned" })).toEqual([]);
    const started = await peer.beginAgentTaskRunCas(begin(event, { time: 199 }));
    expect(started).toMatchObject({ applied: true, task: { generation: 1, leaseOwner: owner, leaseExpiresAt: 299 } });
    expect(await writer.beginAgentTaskRunCas(begin(event))).toMatchObject({ applied: false, events: [] });
  });
});

test("pending renewal and stale closure stay fenced across renewal and the first generation", async () => {
  await withStores(async (writer, peer) => {
    const event = created();
    const taskId = event.payload.taskId;
    await writer.admitAgentTask({ event, owner, ttlMs: 100, now: 100 });
    for (const override of [{ owner: "admission:v1:other" }, { generation: 1 }, { now: 200 }]) {
      expect((await peer.renewAgentTaskLease({ taskId, owner, generation: 0, now: 150, ttlMs: 100, ...override })).acquired).toBe(false);
    }
    expect((await writer.renewAgentTaskLease({ taskId, owner, generation: 0, now: 150, ttlMs: 100 })).acquired).toBe(true);
    const staleClose = {
      taskId, status: "cancelled" as const, eventId: "stale_close", expectedGeneration: 0,
      expectedRunId: null, expectedLeaseOwner: owner, expectedLeaseExpiresAt: 200,
      requireExpiredLease: true, requireLeaseEvidence: true, time: 251,
    };
    expect(await peer.closeAgentTaskCas(staleClose)).toMatchObject({ applied: false, events: [] });
    const claim = begin(event, { time: 249 });
    await writer.beginAgentTaskRunCas(claim);
    expect(await peer.closeAgentTaskCas({ ...staleClose, expectedLeaseExpiresAt: 250 })).toMatchObject({ applied: false, events: [] });
    expect((await peer.renewAgentTaskLease({ taskId, owner, generation: 0, now: 260, ttlMs: 100 })).acquired).toBe(false);
    expect((await writer.renewAgentTaskLease({ taskId, owner, generation: 1, now: 260, ttlMs: 100 })).acquired).toBe(true);
    expect(await peer.agentTask(taskId)).toMatchObject({ status: "running", generation: 1, currentRunId: claim.runId, leaseOwner: owner, leaseExpiresAt: 360 });
    const expired = created("expired");
    await writer.admitAgentTask({ event: expired, owner, ttlMs: 100, now: 100 });
    expect(await peer.closeAgentTaskCas({ ...staleClose, taskId: expired.payload.taskId, eventId: "expired_close", time: 200 })).toMatchObject({
      applied: true, task: { status: "cancelled" },
    });
  });
});

test("a blocked spawn mirror exposes the complete run and lease transition to another connection", async () => {
  const entered = gate();
  const release = gate();
  await withStores(async (writer, peer) => {
    const event = created();
    await writer.admitAgentTask({ event, owner, ttlMs: 100, now: 100 });
    const claim = begin(event);
    const pending = writer.beginAgentTaskRunCas(claim);
    try {
      await entered.promise;
      expect(await peer.agentTask(event.payload.taskId)).toMatchObject({ status: "running", currentRunId: claim.runId, generation: 1, leaseOwner: owner });
      expect(await peer.agentRuns({ taskId: event.payload.taskId })).toHaveLength(1);
      expect((await peer.renewAgentTaskLease({ taskId: event.payload.taskId, owner, generation: 0, ttlMs: 100, now: 130 })).acquired).toBe(false);
      expect((await peer.renewAgentTaskLease({ taskId: event.payload.taskId, owner, generation: 1, ttlMs: 100, now: 130 })).acquired).toBe(true);
    } finally {
      release.resolve();
      await pending;
    }
    expect(await pending).toMatchObject({ applied: true, task: { generation: 1, leaseExpiresAt: 230 } });
  }, { async write(event) { if (event.type === "agent.spawned") { entered.resolve(); await release.promise; } } });
});

test("invalid admissions and reserved or team tasks leave no event or lease behind", async () => {
  await withStores(async (writer, peer) => {
    for (const invalidOwner of ["", "worker", "admission:v1:", "admission:v1:   "]) {
      await expect(writer.admitAgentTask({ event: created(), owner: invalidOwner, ttlMs: 100, now: 100 })).rejects.toThrow();
    }
    for (const invalidWindow of [{ ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: Infinity }, { ttlMs: NaN }, { now: Infinity }, { now: NaN }]) {
      await expect(writer.admitAgentTask({ event: created(), owner, ttlMs: 100, now: 100, ...invalidWindow })).rejects.toThrow();
    }
    for (const payload of [
      { dispatchId: "dispatch_reserved" },
      { reservedRunId: "run_reserved" as AgentRunId },
      { workerPolicy: { teamId: "team_reserved", taskId: "team_task_reserved" } },
    ]) {
      const event = created();
      event.payload = { ...event.payload, ...payload };
      await expect(writer.admitAgentTask({ event, owner, ttlMs: 100, now: 100 })).rejects.toThrow();
    }
    expect(await peer.agentTasks()).toEqual([]);
    expect(await peer.events({ type: "agent.task_created" })).toEqual([]);
    const legacy = created("legacy");
    await writer.append(legacy);
    expect((await peer.renewAgentTaskLease({ taskId: legacy.payload.taskId, owner, generation: 0, ttlMs: 100, now: 100 })).acquired).toBe(false);
  });
});

test("admission respects the parent session run claim and rolls back on a stale fence", async () => {
  await withStores(async (writer, peer) => {
    const event = created();
    const sessionId = event.sessionId!;
    await writer.append({
      id: "parent_created", type: "session.created", sessionId, time: 1 as TimestampMs,
      payload: { sessionId, cwd: "/repo" },
    });
    expect(writer.claimSessionRun({ sessionId, claimId: "claim_live", allowSubagentSessions: false, time: Date.now(), leaseDurationMs: 60_000 })).toEqual({ status: "claimed" });
    await expect(peer.admitAgentTask({
      event, owner, ttlMs: 100, now: 100, runClaim: { sessionId, claimId: "claim_stale" },
    })).rejects.toBeInstanceOf(SessionRunClaimConflictError);
    expect(await peer.agentTask(event.payload.taskId)).toBeUndefined();
    expect(await peer.events({ type: "agent.task_created" })).toEqual([]);
    expect((await writer.admitAgentTask({
      event, owner, ttlMs: 100, now: 100, runClaim: { sessionId, claimId: "claim_live" },
    })).applied).toBe(true);
  });
});
