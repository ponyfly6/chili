import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChiliEvent, MessageId, SessionId, ThreadId, TimestampMs, ToolCallId, TurnId } from "@chili/protocol";
import { inspectSqliteEventStore } from "./sqlite-diagnostics.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

test("inspectSqliteEventStore reports files and the largest storage rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-store-doctor-"));
  const dbPath = join(dir, "chili.sqlite");
  const store = new SqliteEventStore(dbPath);
  const sessionId = "session_doctor" as SessionId;
  const threadId = "thread_doctor" as ThreadId;
  const turnId = "turn_doctor" as TurnId;
  const messageId = "message_doctor" as MessageId;
  const toolCallId = "toolcall_doctor" as ToolCallId;

  try {
    await mkdir(join(dir, "tool-results"), { recursive: true });
    await writeFile(join(dir, "tool-results", "toolcall_doctor.txt"), "z".repeat(3_000), "utf8");
    await writeFile(join(dir, "tool-results", "toolcall_small.txt"), "tiny", "utf8");

    await store.appendMany([
      event("event_session", "session.created", sessionId, threadId, { sessionId, cwd: "/repo" }),
      event("event_message", "message.created", sessionId, threadId, { messageId, role: "assistant", turnId }),
      event("event_tool_started", "tool.call_started", sessionId, threadId, {
        turnId,
        callId: toolCallId,
        toolName: "bash",
        input: { command: "printf large" },
      }),
      event("event_tool_finished", "tool.call_finished", sessionId, threadId, {
        callId: toolCallId,
        status: "completed",
        output: "x".repeat(2_048),
      }),
      event("event_tool_result", "message.part_added", sessionId, threadId, {
        messageId,
        part: {
          id: "part_tool_result" as never,
          messageId,
          sessionId,
          type: "tool_result",
          callId: toolCallId,
          output: "x".repeat(2_048),
        },
      }),
    ] as ChiliEvent[]);

    const report = await inspectSqliteEventStore(dbPath);

    expect(report.path).toBe(dbPath);
    expect(report.files.database.bytes).toBeGreaterThan(0);
    expect(report.files.wal.path).toBe(`${dbPath}-wal`);
    expect(report.toolResultFiles).toMatchObject({
      path: join(dir, "tool-results"),
      exists: true,
      files: 2,
      totalBytes: 3_004,
    });
    expect(report.toolResultFiles.largestFiles[0]).toMatchObject({
      path: join(dir, "tool-results", "toolcall_doctor.txt"),
      bytes: 3_000,
    });
    expect(report.configuredWal).toEqual({
      autoCheckpointPages: 256,
      journalSizeLimitBytes: 16 * 1024 * 1024,
    });
    expect(report.pragmas.journalMode).toBe("wal");
    expect(report.pragmas.pageSize).toBeGreaterThan(0);
    expect(report.events.rows).toBe(5);
    expect(report.events.totalPayloadBytes).toBeGreaterThan(4_000);
    expect(report.events.byType.find((row) => row.type === "tool.call_finished")).toMatchObject({ rows: 1 });
    expect(report.events.bySession[0]).toMatchObject({ sessionId, rows: 5 });
    expect(report.events.largestPayloads[0]).toMatchObject({ id: "event_tool_result" });
    expect(report.messageParts).toMatchObject({ rows: 1 });
    expect(report.messageParts.toolResultsByTool).toEqual([
      { toolName: "bash", rows: 1, outputBytes: 2_048 },
    ]);
    expect(report.toolCalls).toMatchObject({ rows: 1, totalOutputBytes: 2_048 });
    expect(report.toolCalls.byTool).toEqual([
      { toolName: "bash", rows: 1, outputBytes: 2_048 },
    ]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function event<TType extends ChiliEvent["type"]>(
  id: string,
  type: TType,
  sessionId: SessionId,
  threadId: ThreadId,
  payload: Extract<ChiliEvent, { type: TType }>["payload"],
): Extract<ChiliEvent, { type: TType }> {
  return {
    id,
    type,
    time: 1 as TimestampMs,
    sessionId,
    threadId,
    payload,
  } as Extract<ChiliEvent, { type: TType }>;
}
