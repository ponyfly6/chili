import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import type { ChiliEvent, SessionId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { GoalService } from "./goal.js";

const ROUNDS = 6;
type Scenario = "distinct" | "duplicate" | "pause";
type GoalUpdatedEvent = Extract<ChiliEvent, { type: "goal.updated" }>;

test("GoalService accumulates distinct turns from two processes without losing usage", async () => {
  await withWorkers("distinct", async (store, sessionPrefix, results) => {
    const sessionId = sessionPrefix as SessionId;
    const goal = await store.sessionGoal(sessionId);
    expect(goal).toMatchObject({ status: "active", tokensUsed: ROUNDS * (3 + 7), timeUsedSeconds: ROUNDS * 3 });
    if (!goal) throw new Error("Expected the committed Goal projection");
    const events = await store.events({ sessionId, type: "goal.updated" }) as GoalUpdatedEvent[];
    const receipts = events.filter((event) => event.payload.usageDelta);
    expect(receipts).toHaveLength(ROUNDS * 2);
    expect(new Set(receipts.map((event) => event.payload.usageDelta?.turnId)).size).toBe(ROUNDS * 2);
    expect(receipts.reduce((sum, event) => sum + (event.payload.usageDelta?.tokens ?? 0), 0))
      .toBe(goal.tokensUsed);
    expect(results.reduce((sum, result) => sum + result.accounted, 0)).toBe(ROUNDS * 2);
    expect(events.at(-1)?.payload.goal).toEqual(goal);
  });
}, 20_000);

test("GoalService records one receipt when two processes settle the same turn", async () => {
  await withWorkers("duplicate", async (store, sessionPrefix, results) => {
    const sessionId = sessionPrefix as SessionId;
    const goal = await store.sessionGoal(sessionId);
    expect(goal).toMatchObject({ status: "active", tokensUsed: ROUNDS * 11, timeUsedSeconds: ROUNDS });
    const events = await store.events({ sessionId, type: "goal.updated" }) as GoalUpdatedEvent[];
    const receipts = events.filter((event) => event.payload.usageDelta);
    expect(receipts).toHaveLength(ROUNDS);
    expect(new Set(receipts.map((event) => event.payload.usageDelta?.turnId)).size).toBe(ROUNDS);
    expect(results.reduce((sum, result) => sum + result.accounted, 0)).toBe(ROUNDS);
    expect(events.at(-1)?.payload.goal).toEqual(goal);
  });
}, 20_000);

test("GoalService preserves pause and in-flight accounting when different processes race", async () => {
  await withWorkers("pause", async (store, sessionPrefix, results) => {
    for (let index = 0; index < ROUNDS; index += 1) {
      const sessionId = `${sessionPrefix}_${index}` as SessionId;
      const goal = await store.sessionGoal(sessionId);
      expect(goal).toMatchObject({ status: "paused", tokensUsed: 5, timeUsedSeconds: 1 });
      const events = await store.events({ sessionId, type: "goal.updated" }) as GoalUpdatedEvent[];
      expect(events.filter((event) => event.payload.reason === "pause")).toHaveLength(1);
      expect(events.filter((event) => event.payload.usageDelta)).toHaveLength(1);
      expect(events.at(-1)?.payload.goal).toEqual(goal);
    }
    expect(results.reduce((sum, result) => sum + result.accounted, 0)).toBe(ROUNDS);
  });
}, 20_000);

interface WorkerResult {
  pid: number;
  workerId: string;
  rounds: number;
  accounted: number;
}

function spawnWorker(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    process: child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}

type Worker = ReturnType<typeof spawnWorker>;

async function withWorkers(
  scenario: Scenario,
  verify: (store: SqliteEventStore, sessionPrefix: string, results: WorkerResult[]) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `chili-goal-process-${scenario}-`));
  const databasePath = join(directory, "events.sqlite");
  const fixturePath = fileURLToPath(new URL("./fixtures/goal-concurrent-writer.ts", import.meta.url));
  const sessionPrefix = `session_goal_process_${scenario}`;
  const workers: Worker[] = [];
  try {
    const initialStore = new SqliteEventStore(databasePath);
    try {
      const service = new GoalService({ store: initialStore });
      for (let index = 0; index < (scenario === "pause" ? ROUNDS : 1); index += 1) {
        await service.setGoal({
          sessionId: (scenario === "pause" ? `${sessionPrefix}_${index}` : sessionPrefix) as SessionId,
          objective: "account concurrent process work",
          tokenBudget: 10_000,
        });
      }
    } finally {
      initialStore.close();
    }

    // Initialize connections one at a time, then release both operations from
    // the same barrier each round. This isolates the test from schema startup.
    for (const workerId of ["alpha", "beta"]) {
      const worker = spawnWorker([
        fixturePath, databasePath, directory, scenario, workerId, sessionPrefix, String(ROUNDS),
      ]);
      workers.push(worker);
      await waitForReady([join(directory, `${workerId}.0.ready`)], workers);
    }
    for (let index = 0; index < ROUNDS; index += 1) {
      await waitForReady(["alpha", "beta"].map((workerId) => join(directory, `${workerId}.${index}.ready`)), workers);
      await writeFile(join(directory, `${index}.start`), "go", "utf8");
    }

    const results = await Promise.all(workers.map(readWorkerResult));
    expect(new Set(results.map((result) => result.pid)).size).toBe(2);
    expect(results.every((result) => result.pid !== process.pid)).toBe(true);
    expect(results.map((result) => result.rounds)).toEqual([ROUNDS, ROUNDS]);
    const reopened = new SqliteEventStore(databasePath);
    try {
      await verify(reopened, sessionPrefix, results);
    } finally {
      reopened.close();
    }
  } finally {
    for (const worker of workers) {
      if (worker.process.exitCode === null) worker.process.kill(9);
    }
    await Promise.allSettled(workers.map((worker) => withTimeout(worker.process.exited, 2_000)));
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForReady(paths: readonly string[], workers: readonly Worker[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await Promise.all(paths.map((path) => access(path).then(() => true, () => false)));
    if (ready.every(Boolean)) return;
    for (const worker of workers) {
      if (worker.process.exitCode !== null) {
        throw new Error(`Goal worker exited before its barrier: ${await worker.stderr || await worker.stdout}`);
      }
    }
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for Goal process barriers: ${paths.join(", ")}`);
}

async function readWorkerResult(worker: Worker): Promise<WorkerResult> {
  const [exitCode, stdout, stderr] = await withTimeout(Promise.all([
    worker.process.exited, worker.stdout, worker.stderr,
  ]), 10_000);
  if (exitCode !== 0) throw new Error(`Goal worker exited ${exitCode}: ${stderr || stdout}`);
  return JSON.parse(stdout.trim()) as WorkerResult;
}

async function withTimeout<T>(promise: Promise<T>, durationMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for Goal worker")), durationMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
