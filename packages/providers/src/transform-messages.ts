import type { Message, MessageId, MessagePart, PartId, TimestampMs, ToolCallId } from "@chili/protocol";

export interface MessageTransformOptions {
  normalizeToolCallId?: (id: string) => string;
  insertMissingToolResults?: boolean;
  missingToolResultText?: string;
  dropRedactedReasoning?: boolean;
  now?: () => number;
}

interface PendingToolCall {
  callId: ToolCallId;
  toolName: string;
  source: Message;
}

const ANTHROPIC_TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_MISSING_TOOL_RESULT = "No result provided";

export function transformModelMessages(
  messages: readonly Message[],
  options: MessageTransformOptions = {},
): Message[] {
  const normalized = hoistAssistantToolResults(normalizeMessageParts(messages, options));
  if (options.insertMissingToolResults === false) return normalized;
  return insertMissingToolResults(normalized, options);
}

export function normalizeAnthropicToolCallId(id: string): string {
  if (ANTHROPIC_TOOL_CALL_ID.test(id)) return id;

  const hash = stableHash(id);
  const sanitized = id.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  const base = sanitized ? `tool_${sanitized}` : "tool_call";
  const maxBaseLength = 64 - hash.length - 1;
  return `${base.slice(0, maxBaseLength)}_${hash}`;
}

function normalizeMessageParts(messages: readonly Message[], options: MessageTransformOptions): Message[] {
  const callIdMap = new Map<string, ToolCallId>();
  const result: Message[] = [];
  const dropRedactedReasoning = options.dropRedactedReasoning ?? true;

  for (const message of messages) {
    let changed = false;
    const parts: MessagePart[] = [];

    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const normalized = normalizeToolCallId(part.callId, options.normalizeToolCallId);
        callIdMap.set(String(part.callId), normalized);
        if (normalized === part.callId) {
          parts.push(part);
        } else {
          changed = true;
          parts.push({ ...part, callId: normalized });
        }
        continue;
      }

      if (part.type === "tool_result") {
        const normalized = callIdMap.get(String(part.callId));
        if (!normalized || normalized === part.callId) {
          parts.push(part);
        } else {
          changed = true;
          parts.push({ ...part, callId: normalized });
        }
        continue;
      }

      if (part.type === "reasoning" && part.redacted && dropRedactedReasoning) {
        changed = true;
        continue;
      }

      parts.push(part);
    }

    if (parts.length === 0) continue;
    result.push(changed ? { ...message, parts } : message);
  }

  return result;
}

function normalizeToolCallId(
  callId: ToolCallId,
  normalize: ((id: string) => string) | undefined,
): ToolCallId {
  return (normalize ? normalize(String(callId)) : String(callId)) as ToolCallId;
}

function hoistAssistantToolResults(messages: readonly Message[]): Message[] {
  const result: Message[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") {
      result.push(message);
      continue;
    }

    const toolResults = message.parts.filter(
      (part): part is Extract<MessagePart, { type: "tool_result" }> => part.type === "tool_result",
    );
    if (toolResults.length === 0) {
      result.push(message);
      continue;
    }

    const assistantParts = message.parts.filter((part) => part.type !== "tool_result");
    if (assistantParts.length > 0) {
      result.push({ ...message, parts: assistantParts });
    }

    const messageId = `msg_tool_result_${stableHash(
      toolResults.map((part) => `${String(part.id)}:${String(part.callId)}`).join("|"),
    )}` as MessageId;
    result.push({
      id: messageId,
      sessionId: message.sessionId,
      role: "user",
      parts: toolResults.map((part) => ({ ...part, messageId })),
      createdAt: message.createdAt,
    });
  }

  return result;
}

function insertMissingToolResults(messages: readonly Message[], options: MessageTransformOptions): Message[] {
  const result: Message[] = [];
  let pending: PendingToolCall[] = [];
  let resultIds = new Set<string>();

  const flushMissingResults = (reference?: Message) => {
    const missing = pending.filter((toolCall) => !resultIds.has(String(toolCall.callId)));
    if (missing.length > 0) {
      result.push(createSyntheticToolResultMessage(missing, reference, options));
    }
    pending = [];
    resultIds = new Set();
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      flushMissingResults(message);
      result.push(message);
      pending = toolCallsIn(message);
      resultIds = new Set();
      continue;
    }

    for (const part of message.parts) {
      if (part.type === "tool_result") resultIds.add(String(part.callId));
    }

    if (pending.length > 0 && hasNonToolResultPart(message)) {
      flushMissingResults(message);
    }

    result.push(message);
  }

  flushMissingResults(messages.at(-1));
  return result;
}

function toolCallsIn(message: Message): PendingToolCall[] {
  return message.parts
    .filter((part): part is Extract<MessagePart, { type: "tool_call" }> => part.type === "tool_call")
    .map((part) => ({ callId: part.callId, toolName: part.toolName, source: message }));
}

function hasNonToolResultPart(message: Message): boolean {
  return message.parts.some((part) => part.type !== "tool_result");
}

function createSyntheticToolResultMessage(
  missing: readonly PendingToolCall[],
  reference: Message | undefined,
  options: MessageTransformOptions,
): Message {
  const source = reference ?? missing[0]?.source;
  if (!source) throw new Error("Cannot create synthetic tool result without a source message");

  const createdAt = (options.now?.() ?? Date.now()) as TimestampMs;
  const suffix = stableHash(missing.map((toolCall) => `${toolCall.toolName}:${String(toolCall.callId)}`).join("|"));
  const messageId = `msg_synthetic_tool_result_${suffix}` as MessageId;

  return {
    id: messageId,
    sessionId: source.sessionId,
    role: "user",
    parts: missing.map((toolCall, index) => ({
      id: `part_synthetic_tool_result_${suffix}_${index}` as PartId,
      messageId,
      sessionId: source.sessionId,
      type: "tool_result",
      callId: toolCall.callId,
      output: options.missingToolResultText ?? DEFAULT_MISSING_TOOL_RESULT,
      error: options.missingToolResultText ?? DEFAULT_MISSING_TOOL_RESULT,
      synthetic: true,
    })),
    createdAt,
  };
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
