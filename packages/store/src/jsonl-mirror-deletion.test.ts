import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, MessageId, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { SessionJsonlMirror, SessionTranscriptJsonlMirror } from "./jsonl-mirror.js";
import type { SessionRow } from "./types.js";

const session = (id: string, cwd: string): SessionRow => ({ id: id as SessionId, cwd, status: "active", createdAt: 1, updatedAt: 1 });
const created = (row: SessionRow): ChiliEvent => ({
  id: `created_${row.id}`, type: "session.created", time: 1 as TimestampMs,
  sessionId: row.id, payload: { sessionId: row.id, cwd: row.cwd },
});
const messageCreated = (row: SessionRow, messageId: string): ChiliEvent => ({
  id: `created_${messageId}`, type: "message.created", time: 2 as TimestampMs,
  sessionId: row.id, payload: { messageId: messageId as MessageId, role: "assistant" },
});
const completed = (row: SessionRow): ChiliEvent => ({
  id: `completed_${row.id}`, type: "turn.completed", time: 3 as TimestampMs,
  sessionId: row.id, payload: { turnId: `turn_${row.id}` as TurnId, status: "completed" },
});

test("session mirror deletion uses saved cwd metadata after restart and only removes its session files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-mirror-delete-"));
  const root = join(directory, "mirrors");
  const project = join(directory, "project");
  const deleted = session("session_deleted", project);
  const kept = session("session_kept", project);
  const options = { groupByCwd: true, filePrefix: "session-" };
  try {
    await mkdir(project);
    const projectFile = join(project, "source.ts");
    await writeFile(projectFile, "source");
    const writer = new SessionJsonlMirror(root, options);
    await writer.write(created(deleted));
    await writer.write(created(kept));
    const groupedRoot = join(root, project.replace(/[^A-Za-z0-9._-]/g, "-"));
    const mirror = new SessionJsonlMirror(root, { ...options, resolveSessionCwd: () => { throw new Error("session already deleted"); } });

    await mirror.deleteSessions([deleted]);
    await mirror.deleteSessions([deleted]);

    expect(existsSync(join(groupedRoot, "session-session_deleted.jsonl"))).toBe(false);
    expect(existsSync(join(groupedRoot, "session-session_kept.jsonl"))).toBe(true);
    expect(await readFile(projectFile, "utf8")).toBe("source");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session mirror deletion waits for pending path resolution and append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-mirror-delete-pending-"));
  const deleted = session("session_deleted", "/project");
  let resolveCwd!: (cwd: string) => void;
  const cwd = new Promise<string>((resolve) => { resolveCwd = resolve; });
  const mirror = new SessionJsonlMirror(directory, { groupByCwd: true, resolveSessionCwd: () => cwd });
  try {
    const writing = mirror.write(messageCreated(deleted, "message_pending"));
    const deleting = mirror.deleteSessions([deleted]);
    resolveCwd(deleted.cwd);
    await Promise.all([writing, deleting]);

    expect(existsSync(join(directory, "-project", "session_deleted.jsonl"))).toBe(false);
    const recreated = { ...deleted, cwd: "/new-project" };
    await mirror.write(created(recreated));
    expect(existsSync(join(directory, "-new-project", "session_deleted.jsonl"))).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transcript deletion removes prior exports and clears unflushed message state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chili-transcript-delete-"));
  const deleted = session("session_deleted", "/project");
  const kept = session("session_kept", "/project");
  const mirror = new SessionTranscriptJsonlMirror(directory);
  try {
    const pending = [
      mirror.write(messageCreated(deleted, "message_exported")),
      mirror.write(completed(deleted)),
      mirror.write(messageCreated(deleted, "message_unflushed")),
      mirror.write(messageCreated(kept, "message_kept")),
      mirror.write(completed(kept)),
    ];
    const deleting = mirror.deleteSessions([deleted]);
    await Promise.all([...pending, deleting]);
    await mirror.write(completed(deleted));

    expect(existsSync(join(directory, "session_deleted.jsonl"))).toBe(false);
    expect(JSON.parse((await readFile(join(directory, "session_kept.jsonl"), "utf8")).trim())).toMatchObject({
      sessionId: kept.id, messageId: "message_kept",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
