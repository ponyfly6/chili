import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, MessageId, PartId, SessionId, TimestampMs, TurnId } from "@chili/protocol";
import { JsonlMirror, SessionJsonlMirror, SessionTranscriptJsonlMirror } from "./jsonl-mirror.js";

test("JsonlMirror appends raw events to one JSONL file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-jsonl-mirror-"));
  const path = join(dir, "events.jsonl");
  const mirror = new JsonlMirror(path);
  const event = sessionCreatedEvent("session_static" as SessionId);

  try {
    await mirror.write(event);

    expect(JSON.parse((await readFile(path, "utf8")).trim())).toEqual(event);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionJsonlMirror appends timestamped events to per-session JSONL files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-session-jsonl-mirror-"));
  const sessionId = "session_with/slash" as SessionId;
  const mirror = new SessionJsonlMirror(join(dir, "sessions"), { filePrefix: "session-" });
  const messageId = "message_jsonl" as MessageId;

  try {
    await mirror.write(sessionCreatedEvent(sessionId));
    await mirror.write({
      id: "event_part",
      type: "message.part_added",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        messageId,
        part: {
          id: "part_jsonl" as PartId,
          messageId,
          sessionId,
          type: "text",
          text: "hello jsonl",
        },
      },
    });

    const text = await readFile(join(dir, "sessions", "session-session_with-slash.jsonl"), "utf8");
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      timestamp: "1970-01-01T00:00:00.001Z",
      id: "event_session",
      type: "session.created",
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    });
    expect(lines[1]).toMatchObject({
      timestamp: "1970-01-01T00:00:00.002Z",
      id: "event_part",
      type: "message.part_added",
      payload: {
        part: {
          type: "text",
          text: "hello jsonl",
        },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionJsonlMirror can group session files under a home root by cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-session-jsonl-cwd-"));
  const homeSessionsRoot = join(dir, "home", ".chili", "sessions");
  const project = join(dir, "project");
  const sessionId = "session_cwd" as SessionId;
  const mirror = new SessionJsonlMirror(homeSessionsRoot, { groupByCwd: true });

  try {
    const sessionEvent: ChiliEvent = {
      id: "event_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: project },
    };
    await mirror.write(sessionEvent);
    await mirror.write({
      id: "event_user",
      type: "message.created",
      time: 2 as TimestampMs,
      sessionId,
      payload: { messageId: "message_cwd" as MessageId, role: "user" },
    });

    const path = join(homeSessionsRoot, safeProjectSegment(project), "session_cwd.jsonl");
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    expect(lines.map((line) => line.type)).toEqual(["session.created", "message.created"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionJsonlMirror can resolve cwd for resumed sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-session-jsonl-resume-"));
  const homeSessionsRoot = join(dir, "home", ".chili", "sessions");
  const project = join(dir, "project");
  const sessionId = "session_resumed" as SessionId;
  const mirror = new SessionJsonlMirror(homeSessionsRoot, {
    groupByCwd: true,
    resolveSessionCwd: (requestedSessionId) => requestedSessionId === sessionId ? project : undefined,
  });

  try {
    await mirror.write({
      id: "event_user_resumed",
      type: "message.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { messageId: "message_resumed" as MessageId, role: "user" },
    });

    const path = join(homeSessionsRoot, safeProjectSegment(project), "session_resumed.jsonl");
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    expect(lines).toMatchObject([{ type: "message.created", sessionId }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionJsonlMirror falls back to the sessions root when cwd is unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-session-jsonl-fallback-"));
  const sessionId = "session_unknown" as SessionId;
  const mirror = new SessionJsonlMirror(join(dir, "sessions"), {
    groupByCwd: true,
    resolveSessionCwd: () => undefined,
  });

  try {
    await mirror.write({
      id: "event_unknown",
      type: "message.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { messageId: "message_unknown" as MessageId, role: "user" },
    });

    expect(JSON.parse((await readFile(join(dir, "sessions", "session_unknown.jsonl"), "utf8")).trim())).toMatchObject({
      type: "message.created",
      sessionId,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionTranscriptJsonlMirror writes one JSONL line per completed message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-transcript-jsonl-"));
  const root = join(dir, "sessions");
  const sessionId = "session_transcript" as SessionId;
  const userMessageId = "message_user" as MessageId;
  const assistantMessageId = "message_assistant" as MessageId;
  const assistantPartId = "part_assistant" as PartId;
  const mirror = new SessionTranscriptJsonlMirror(root);

  try {
    await mirror.write({
      id: "event_user_created",
      type: "message.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { messageId: userMessageId, role: "user" },
    });
    await mirror.write({
      id: "event_user_part",
      type: "message.part_added",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        messageId: userMessageId,
        part: {
          id: "part_user" as PartId,
          messageId: userMessageId,
          sessionId,
          type: "text",
          text: "hello",
        },
      },
    });
    await mirror.write({
      id: "event_turn_started",
      type: "turn.started",
      time: 3 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_transcript" as TurnId },
    });
    await mirror.write({
      id: "event_assistant_created",
      type: "message.created",
      time: 4 as TimestampMs,
      sessionId,
      payload: { messageId: assistantMessageId, role: "assistant" },
    });
    await mirror.write({
      id: "event_assistant_part",
      type: "message.part_added",
      time: 5 as TimestampMs,
      sessionId,
      payload: {
        messageId: assistantMessageId,
        part: {
          id: assistantPartId,
          messageId: assistantMessageId,
          sessionId,
          type: "text",
          text: "hel",
        },
      },
    });
    await mirror.write({
      id: "event_assistant_delta",
      type: "message.part_delta",
      time: 6 as TimestampMs,
      sessionId,
      payload: { messageId: assistantMessageId, partId: assistantPartId, field: "text", delta: "lo" },
    });
    await mirror.write({
      id: "event_turn_completed",
      type: "turn.completed",
      time: 7 as TimestampMs,
      sessionId,
      payload: { turnId: "turn_transcript" as TurnId, status: "completed" },
    });

    const lines = (await readFile(join(root, "session_transcript.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.sessionId === sessionId && !("threadId" in line))).toBe(true);
    expect(lines.map((line) => [line.type, line.role, line.text])).toEqual([
      ["message", "user", "hello"],
      ["message", "assistant", "hello"],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SessionTranscriptJsonlMirror exports committed blocks in original order without stream duplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-transcript-committed-"));
  const sessionId = "session_committed" as SessionId;
  const messageId = "message_committed" as MessageId;
  const textId = "part_text" as PartId;
  const mirror = new SessionTranscriptJsonlMirror(dir);

  try {
    await mirror.write({
      id: "message_created", type: "message.created", time: 1 as TimestampMs, sessionId,
      payload: { messageId, role: "assistant" },
    });
    await mirror.write({
      id: "text_delta", type: "message.part_stream_delta", time: 2 as TimestampMs, sessionId,
      payload: { messageId, partId: textId, partType: "text", delta: "partial reply", offset: 0, ordinal: 1 },
    });
    const textCommit: ChiliEvent = {
      id: "text_commit", type: "message.part_committed", time: 3 as TimestampMs, sessionId,
      payload: { messageId, part: {
        id: textId, messageId, sessionId, type: "text", text: "partial reply", ordinal: 1, completion: "cancelled",
      } },
    };
    await mirror.write(textCommit);
    await mirror.write(textCommit);
    await mirror.write({
      id: "reasoning_commit", type: "message.part_committed", time: 4 as TimestampMs, sessionId,
      payload: { messageId, part: {
        id: "part_reasoning" as PartId, messageId, sessionId, type: "reasoning", text: "thinking", ordinal: 0, completion: "completed",
      } },
    });
    await mirror.write({
      id: "turn_completed", type: "turn.completed", time: 5 as TimestampMs, sessionId,
      payload: { turnId: "turn_committed" as TurnId, status: "cancelled" },
    });

    const lines = (await readFile(join(dir, `${sessionId}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      text: "thinking\npartial reply",
      parts: [
        { type: "reasoning", text: "thinking", completion: "completed" },
        { type: "text", text: "partial reply", completion: "cancelled" },
      ],
    });
    expect(lines[0].parts).toHaveLength(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function sessionCreatedEvent(sessionId: SessionId): ChiliEvent {
  return {
    id: "event_session",
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    payload: { sessionId, cwd: "/repo" },
  };
}

function safeProjectSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-") || "session";
}
