import { Database } from "bun:sqlite";
import { access, writeFile } from "node:fs/promises";
import type { SessionId, TimestampMs } from "@chili/protocol";
import { SqliteEventStore } from "../sqlite-event-store.js";

const [
  databasePath,
  workerId,
  writeCountText,
  readyPath,
  startPath,
  firstWritePath,
  peerFirstWritePath,
] = process.argv.slice(2);
if (
  !databasePath
  || !workerId
  || !writeCountText
  || !readyPath
  || !startPath
  || !firstWritePath
  || !peerFirstWritePath
) {
  throw new Error("Expected database, worker, count, and barrier path arguments");
}

const writeCount = Number(writeCountText);
if (!Number.isSafeInteger(writeCount) || writeCount < 1) {
  throw new Error("Invalid writeCount argument");
}

const store = new SqliteEventStore(databasePath, {
  busyTimeoutMs: 10_000,
  writeRetryAttempts: 10,
});
const db = (store as unknown as { db: Database }).db;
const sqliteVersion = scalarString(db, "select sqlite_version() as value");
const journalMode = pragmaString(db, "journal_mode");
let checkpoints = 0;

try {
  await writeFile(readyPath, String(process.pid), "utf8");
  await waitForFile(startPath);

  for (let index = 0; index < writeCount; index += 1) {
    if (index % 4 === 0) {
      db.query("pragma wal_checkpoint(PASSIVE)").all();
      checkpoints += 1;
    }
    const sessionId = `session_dual_process_${workerId}_${index}` as SessionId;
    await store.append({
      id: `event_dual_process_${workerId}_${index}`,
      type: "session.created",
      time: (Date.now() + index) as TimestampMs,
      sessionId,
      payload: {
        sessionId,
        cwd: `/dual-process/${workerId}/${index}`,
      },
    });
    if (index === 0) {
      await writeFile(firstWritePath, String(process.pid), "utf8");
      await waitForFile(peerFirstWritePath);
    }
    if (index % 8 === 0) await Bun.sleep(1);
  }

  const integrity = scalarString(db, "pragma integrity_check");
  const persistedRows = Number(db.query<{ rows: number }, []>(
    "select count(*) as rows from events where id like 'event_dual_process_%'",
  ).get()?.rows ?? 0);
  console.log(JSON.stringify({
    workerId,
    pid: process.pid,
    sqliteVersion,
    journalMode,
    checkpoints,
    integrity,
    persistedRows,
  }));
} finally {
  store.close();
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await access(path).then(() => true, () => false)) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for process barrier: ${path}`);
}
