import type { MessageRole } from "./message.js";

/** Display records are independent of model messages and event replay. */
export interface HistoryPart {
  id: string;
  type: string;
  text: string;
  hasMore: boolean;
  callId?: string;
  toolName?: string;
  status?: string;
  completion?: "completed" | "cancelled" | "failed";
  filename?: string;
  mimeType?: string;
  phase?: "commentary" | "final_answer";
  process?: boolean;
  subject?: string;
  errorSummary?: string;
}
export interface HistoryMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  createdAt: number;
  turnId?: string;
  workId?: string;
  inputId?: string;
  submissionId?: string;
  readAt?: number;
  parts: HistoryPart[];
  partCount?: number;
  nextPartOffset?: number;
}
export interface ConversationPage {
  sessionId: string;
  messages: HistoryMessage[];
  nextBeforeMessageId?: string;
}
export interface HistoryTool {
  id: string;
  name: string;
  status: string;
  startedAt: number;
  updatedAt: number;
  subject?: string;
  errorSummary?: string;
}
export interface HistoryToolPage {
  sessionId: string;
  parentCallId: string;
  tools: HistoryTool[];
  nextAfterToolId?: string;
}
export interface HistoryContent {
  sessionId: string;
  id: string;
  field: "text" | "input" | "output" | "error";
  offset: number;
  text: string;
  nextOffset?: number;
}

export function parseConversationPage(value: unknown): ConversationPage {
  const page = record(value);
  string(page.sessionId);
  if (!Array.isArray(page.messages) || page.messages.length > 50) throw new TypeError("Invalid history messages");
  for (const message of page.messages) {
    parseHistoryMessage(message);
    if (message.sessionId !== page.sessionId) throw new TypeError("History message belongs to another session");
  }
  if (page.nextBeforeMessageId !== undefined) string(page.nextBeforeMessageId);
  return value as ConversationPage;
}
export function parseHistoryMessage(value: unknown): HistoryMessage {
  const message = record(value);
  string(message.id); string(message.sessionId); number(message.createdAt);
  if (!["user", "assistant", "tool", "system"].includes(String(message.role))) throw new TypeError("Invalid history role");
  if (message.turnId !== undefined) string(message.turnId);
  if (message.workId !== undefined) string(message.workId);
  if (message.inputId !== undefined) string(message.inputId);
  if (message.submissionId !== undefined) string(message.submissionId);
  if (message.readAt !== undefined) number(message.readAt);
  if (message.partCount !== undefined) number(message.partCount);
  if (message.nextPartOffset !== undefined) number(message.nextPartOffset);
  if (!Array.isArray(message.parts) || message.parts.length > 32) throw new TypeError("Invalid history parts");
  for (const value of message.parts) {
    const part = record(value);
    string(part.id); string(part.type); string(part.text, 8000, true);
    if (typeof part.hasMore !== "boolean") throw new TypeError("Invalid history part completeness");
    for (const name of ["callId", "toolName", "status", "filename", "mimeType", "subject", "errorSummary"]) if (part[name] !== undefined) string(part[name]);
    if (part.process !== undefined && typeof part.process !== "boolean") throw new TypeError("Invalid history process flag");
    if (part.phase !== undefined && !["commentary", "final_answer"].includes(String(part.phase))) throw new TypeError("Invalid history phase");
    if (part.completion !== undefined && !["completed", "cancelled", "failed"].includes(String(part.completion))) throw new TypeError("Invalid part completion");
  }
  return value as HistoryMessage;
}
export function parseHistoryContent(value: unknown): HistoryContent {
  const content = record(value);
  string(content.sessionId); string(content.id); number(content.offset);
  string(content.text, 32768, true);
  if (!["text", "input", "output", "error"].includes(String(content.field))) throw new TypeError("Invalid history field");
  if (content.nextOffset !== undefined) {
    number(content.nextOffset);
    if (Number(content.nextOffset) <= Number(content.offset)) throw new TypeError("History content cursor did not advance");
  }
  return value as HistoryContent;
}
export function parseHistoryToolPage(value: unknown): HistoryToolPage {
  const page = record(value);
  string(page.sessionId); string(page.parentCallId);
  if (!Array.isArray(page.tools) || page.tools.length > 50) throw new TypeError("Invalid history tools");
  for (const value of page.tools) {
    const tool = record(value);
    string(tool.id); string(tool.name); string(tool.status); number(tool.startedAt); number(tool.updatedAt);
    for (const name of ["subject", "errorSummary"]) if (tool[name] !== undefined) string(tool[name]);
  }
  if (page.nextAfterToolId !== undefined) string(page.nextAfterToolId);
  return value as HistoryToolPage;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid history record");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 512, empty = false): void {
  if (typeof value !== "string" || (!empty && !value) || value.length > max) throw new TypeError("Invalid history string");
}
function number(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid history number");
}
