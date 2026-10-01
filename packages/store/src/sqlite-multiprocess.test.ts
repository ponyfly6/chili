import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SqliteEventStore } from "./sqlite-event-store.js";
import { sqliteJournalPolicy } from "./sqlite-journal-policy.js";

interface WorkerResult {
  workerId: string;
  pid: number;
  sqliteVersion: string;
  journalMode: string;
  checkpoints: number;
  integrity: string;
  persistedRows: number;
}

test("two processes use the safe journal policy across concurrent writes and checkpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-store-multiprocess-"));
  const databasePath = join(directory, "events.sqlite");
  const fixturePath = fileURLToPath(new URL("./fixtures/sqlite-concurrent-writer.ts", import.meta.url));
  const writeCount = 160;

  try {
    const initialStore = new SqliteEventStore(databasePath);
    initialStore.close();

    const startPath = join(directory, "start");
    const readyPaths = [join(directory, "alpha.ready"), join(directory, "beta.ready")];
    const firstWritePaths = [join(directory, "alpha.first"), join(directory, "beta.first")];
    const workers = ["alpha", "beta"].map((workerId) => spawnSqliteWorker([
      fixturePath,
      databasePath,
      workerId,
      String(writeCount),
      readyPaths[workerId === "alpha" ? 0 : 1]!,
      startPath,
      firstWritePaths[workerId === "alpha" ? 0 : 1]!,
      firstWritePaths[workerId === "alpha" ? 1 : 0]!,
    ]));

    try {
      await waitForFiles(readyPaths);
      await writeFile(startPath, "go", "utf8");

      const results = await Promise.all(workers.map(readWorkerResult));

      const versions = [...new Set(results.map((result) => result.sqliteVersion))];
      expect(versions).toHaveLength(1);
      const policy = sqliteJournalPolicy(versions[0] ?? "unknown");
      expect(results.map((result) => result.journalMode)).toEqual([
        policy.journalMode,
        policy.journalMode,
      ]);
      if (!policy.walResetSafe) {
        expect(results.map((result) => result.journalMode)).toEqual(["delete", "delete"]);
      }
      expect(new Set(results.map((result) => result.pid)).size).toBe(2);
      expect(results.every((result) => result.checkpoints === writeCount / 4)).toBe(true);
      expect(results.every((result) => result.integrity === "ok")).toBe(true);
      // Each child waits after its first commit until the peer has also
      // committed, so this proves the processes overlapped rather than merely
      // producing the right final total through serial execution.
      expect(results.every((result) => result.persistedRows > writeCount)).toBe(true);

      const reopened = new SqliteEventStore(databasePath);
      try {
        const db = (reopened as unknown as { db: Database }).db;
        expect(pragmaString(db, "journal_mode")).toBe(policy.journalMode);
        expect(scalarString(db, "pragma integrity_check")).toBe("ok");
        expect(db.query<{ rows: number }, []>(
          "select count(*) as rows from events where id like 'event_dual_process_%'",
        ).get()?.rows).toBe(writeCount * 2);
      } finally {
        reopened.close();
      }
    } finally {
      for (const worker of workers) {
        if (worker.exitCode === null) worker.kill(9);
      }
      await Promise.allSettled(workers.map((worker) => withTimeout(
        worker.exited,
        2_000,
        "Timed out reaping SQLite worker",
      )));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function spawnSqliteWorker(args: readonly string[]) {
  return Bun.spawn([process.execPath, ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function readWorkerResult(
  worker: ReturnType<typeof spawnSqliteWorker>,
): Promise<WorkerResult> {
  const [exitCode, stdout, stderr] = await Promise.all([
    withTimeout(worker.exited, 20_000, "Timed out waiting for SQLite worker"),
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`SQLite worker exited ${exitCode}: ${stderr || stdout}`);
  }
  return JSON.parse(stdout.trim()) as WorkerResult;
}

function pragmaString(db: Database, name: string): string {
  const row = db.query<Record<string, unknown>, []>(`pragma ${name}`).get();
  const value = row ? Object.values(row)[0] : undefined;
  if (value === undefined) throw new Error(`Missing PRAGMA value: ${name}`);
  return String(value);
}

function scalarString(db: Database, sql: string): string {
  const row = db.query<Record<string, unknown>, []>(sql).get();
  const value = row ? Object.values(row)[0] : undefined;
  if (value === undefined) throw new Error(`Missing scalar value for: ${sql}`);
  return String(value);
}

async function waitForFiles(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const present = await Promise.all(paths.map((path) =>
      access(path).then(() => true, () => false)
    ));
    if (present.every(Boolean)) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for SQLite workers: ${paths.join(", ")}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
