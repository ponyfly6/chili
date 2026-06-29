import { createHash } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ChiliEvent, MessageId, MessagePart, MessageRole, SessionId, ThreadId, TimestampMs, TurnId } from "@chili/protocol";
import type { EventMirror } from "./types.js";

export class JsonlMirror implements EventMirror {
  constructor(private readonly path: string) {}

  async write(event: ChiliEvent): Promise<void> {
    await appendJsonLine(this.path, event);
  }
}

export interface SessionJsonlMirrorOptions {
  filePrefix?: string;
  groupByCwd?: boolean;
  resolveSessionCwd?: (sessionId: SessionId) => Promise<string | undefined> | string | undefined;
}

export class SessionJsonlMirror implements EventMirror {
  private static readonly maxSegmentLength = 160;
  private readonly filePrefix: string;
  private readonly groupByCwd: boolean;
  private readonly resolveSessionCwd:
    | ((sessionId: SessionId) => Promise<string | undefined> | string | undefined)
    | undefined;
  private readonly pathsBySessionId = new Map<string, string>();

  constructor(
    private readonly rootDir: string,
    options: SessionJsonlMirrorOptions = {},
  ) {
    this.filePrefix = options.filePrefix ?? "";
    this.groupByCwd = options.groupByCwd ?? false;
    this.resolveSessionCwd = options.resolveSessionCwd;
  }

  async write(event: ChiliEvent): Promise<void> {
    const sessionId = sessionIdForEvent(event);
    if (!sessionId) return;
    const path = await this.pathForEvent(sessionId, event);
    await appendJsonLine(path, {
      timestamp: new Date(event.time).toISOString(),
      ...event,
    });
  }

  private async pathForEvent(sessionId: SessionId, event: ChiliEvent): Promise<string> {
    const fileName = `${this.filePrefix}${safePathSegment(sessionId)}.jsonl`;
    if (this.groupByCwd && event.type === "session.created") {
      const path = this.pathForCwd(event.payload.cwd, fileName);
      this.pathsBySessionId.set(sessionId, path);
      return path;
    }
    const knownPath = this.pathsBySessionId.get(sessionId);
    if (knownPath) return knownPath;
    if (this.groupByCwd && this.resolveSessionCwd) {
      const cwd = await this.resolveSessionCwd(sessionId);
      if (cwd) {
        const path = this.pathForCwd(cwd, fileName);
        this.pathsBySessionId.set(sessionId, path);
        return path;
      }
    }
    return join(this.rootDir, fileName);
  }

  private pathForCwd(cwd: string, fileName: string): string {
    const projectDir = safePathSegment(resolve(cwd), SessionJsonlMirror.maxSegmentLength);
    return join(this.rootDir, projectDir, fileName);
  }

  async rememberSession(event: Extract<ChiliEvent, { type: "session.created" }>): Promise<void> {
    await this.pathForEvent(event.payload.sessionId, event);
  }

  async writeTranscriptLine(sessionId: SessionId, line: unknown): Promise<void> {
    await appendJsonLine(await this.pathForSessionId(sessionId), line);
  }

  private async pathForSessionId(sessionId: SessionId): Promise<string> {
    const knownPath = this.pathsBySessionId.get(sessionId);
    if (knownPath) return knownPath;
    const fileName = `${this.filePrefix}${safePathSegment(sessionId)}.jsonl`;
    if (this.groupByCwd && this.resolveSessionCwd) {
      const cwd = await this.resolveSessionCwd(sessionId);
      if (cwd) {
        const path = this.pathForCwd(cwd, fileName);
        this.pathsBySessionId.set(sessionId, path);
        return path;
      }
    }
    return join(this.rootDir, fileName);
  }
}

interface TranscriptMessageState {
  messageId: MessageId;
  sessionId: SessionId;
  threadId?: ThreadId;
  turnId?: TurnId;
  role: MessageRole;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
  parts: MessagePart[];
  flushed: boolean;
}

export class SessionTranscriptJsonlMirror implements EventMirror {
  private readonly paths: SessionJsonlMirror;
  private readonly messages = new Map<string, TranscriptMessageState>();

  constructor(rootDir: string, options: SessionJsonlMirrorOptions = {}) {
    this.paths = new SessionJsonlMirror(rootDir, options);
  }

  async write(event: ChiliEvent): Promise<void> {
    if (event.type === "session.created") {
      await this.paths.rememberSession(event);
      return;
    }

    if (event.type === "message.created") {
      if (!event.sessionId) return;
      const state: TranscriptMessageState = {
        messageId: event.payload.messageId,
        sessionId: event.sessionId,
        role: event.payload.role,
        createdAt: event.time,
        updatedAt: event.time,
        parts: [],
        flushed: false,
      };
      if (event.threadId) state.threadId = event.threadId;
      if (event.payload.turnId) state.turnId = event.payload.turnId;
      this.messages.set(event.payload.messageId, state);
      return;
    }

    if (event.type === "message.part_added") {
      const state = this.messages.get(event.payload.messageId);
      if (!state) return;
      state.parts.push(event.payload.part);
      state.updatedAt = event.time;
      return;
    }

    if (event.type === "message.part_delta") {
      const state = this.messages.get(event.payload.messageId);
      if (!state) return;
      const part = state.parts.find((item) => item.id === event.payload.partId);
      if (!part) return;
      applyTranscriptPartDelta(part, event.payload.field, event.payload.delta);
      state.updatedAt = event.time;
      return;
    }

    if (event.type === "turn.started" || event.type === "turn.completed") {
      await this.flushReadyMessages(event);
    }
  }

  private async flushReadyMessages(event: ChiliEvent): Promise<void> {
    const sessionId = sessionIdForEvent(event);
    if (!sessionId) return;
    for (const message of this.messages.values()) {
      if (message.flushed || message.sessionId !== sessionId) continue;
      if (event.threadId && message.threadId && event.threadId !== message.threadId) continue;
      if (event.type === "turn.started" && message.role === "assistant") continue;
      await this.writeMessage(message);
      message.flushed = true;
    }
  }

  private async writeMessage(message: TranscriptMessageState): Promise<void> {
    await this.paths.writeTranscriptLine(message.sessionId, {
      timestamp: new Date(message.createdAt).toISOString(),
      type: "message",
      sessionId: message.sessionId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.turnId ? { turnId: message.turnId } : {}),
      messageId: message.messageId,
      role: message.role,
      text: messageText(message.parts),
      parts: message.parts,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    });
  }
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function sessionIdForEvent(event: ChiliEvent): SessionId | undefined {
  if (event.sessionId) return event.sessionId;
  if (event.type === "session.created" || event.type === "session.archived") return event.payload.sessionId;
  if (event.type === "session.model_changed" || event.type === "session.reasoning_changed" || event.type === "session.service_tier_changed") {
    return event.payload.sessionId;
  }
  return undefined;
}

function safePathSegment(value: string, maxLength = Number.POSITIVE_INFINITY): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "-");
  const segment = safe.length > 0 ? safe : "session";
  if (segment.length <= maxLength) return segment;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${segment.slice(0, maxLength - hash.length - 1)}-${hash}`;
}

function applyTranscriptPartDelta(part: MessagePart, field: string, delta: string): void {
  const record = part as unknown as Record<string, unknown>;
  const value = record[field];
  record[field] = typeof value === "string" ? `${value}${delta}` : delta;
}

function messageText(parts: readonly MessagePart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.displayText ?? part.text;
      if (part.type === "image") return part.displayText ?? `[image ${part.mimeType}${part.filename ? ` ${part.filename}` : ""}]`;
      if (part.type === "reasoning") return part.text;
      if (part.type === "tool_call") return `[${part.toolName}]`;
      if (part.type === "tool_result") return part.output || part.error || "";
      if (part.type === "compaction") return part.summary ?? "";
      if (part.type === "agent_handoff") return part.summary;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
