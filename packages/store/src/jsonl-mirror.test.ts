import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ChiliEvent, MessageId, PartId, SessionId, ThreadId, TimestampMs, TurnId } from "@chili/protocol";
import { JsonlMirror, SessionJsonlMirror, SessionTranscriptJsonlMirror } from "./jsonl-mirror.js";

test("JsonlMirror appends raw events to one JSONL file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-jsonl-mirror-"));
  const path = join(dir, "events.jsonl");
  const mirror = new JsonlMirror(path);
  const event = sessionCreatedEvent("session_static" as SessionId, "thread_static" as ThreadId);

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
  const threadId = "thread_jsonl" as ThreadId;
  const mirror = new SessionJsonlMirror(join(dir, "sessions"), { filePrefix: "session-" });
  const messageId = "message_jsonl" as MessageId;

  try {
    await mirror.write(sessionCreatedEvent(sessionId, threadId));
    await mirror.write({
      id: "event_part",
      type: "message.part_added",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
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
      threadId,
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
  const threadId = "thread_cwd" as ThreadId;
  const mirror = new SessionJsonlMirror(homeSessionsRoot, { groupByCwd: true });

  try {
    const sessionEvent: ChiliEvent = {
      id: "event_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, cwd: project },
    };
    await mirror.write(sessionEvent);
    await mirror.write({
      id: "event_user",
      type: "message.created",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
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
  const threadId = "thread_resumed" as ThreadId;
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
      threadId,
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
      threadId: "thread_unknown" as ThreadId,
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
  const threadId = "thread_transcript" as ThreadId;
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
      threadId,
      payload: { messageId: userMessageId, role: "user" },
    });
    await mirror.write({
      id: "event_user_part",
      type: "message.part_added",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
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
      threadId,
      payload: { turnId: "turn_transcript" as TurnId },
    });
    await mirror.write({
      id: "event_assistant_created",
      type: "message.created",
      time: 4 as TimestampMs,
      sessionId,
      threadId,
      payload: { messageId: assistantMessageId, role: "assistant" },
    });
    await mirror.write({
      id: "event_assistant_part",
      type: "message.part_added",
      time: 5 as TimestampMs,
      sessionId,
      threadId,
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
      threadId,
      payload: { messageId: assistantMessageId, partId: assistantPartId, field: "text", delta: "lo" },
    });
    await mirror.write({
      id: "event_turn_completed",
      type: "turn.completed",
      time: 7 as TimestampMs,
      sessionId,
      threadId,
      payload: { turnId: "turn_transcript" as TurnId, status: "completed" },
    });

    const lines = (await readFile(join(root, "session_transcript.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => [line.type, line.role, line.text])).toEqual([
      ["message", "user", "hello"],
      ["message", "assistant", "hello"],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function sessionCreatedEvent(sessionId: SessionId, threadId: ThreadId): ChiliEvent {
  return {
    id: "event_session",
    type: "session.created",
    time: 1 as TimestampMs,
    sessionId,
    threadId,
    payload: { sessionId, cwd: "/repo" },
  };
}

function safeProjectSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-") || "session";
}
