import type {
  Message,
  ToolCallPart,
  ToolResultPart,
  TurnId,
} from "@chili/protocol";

export const FAILURE_CHECKPOINT_MAX_CHARS = 4_000;

const MAX_PROGRESS_ITEMS = 3;
const MAX_PROGRESS_ITEM_CHARS = 1_200;
const MAX_TOOL_ACTIVITY_ITEMS = 12;
const MAX_TOOL_NAME_CHARS = 80;
const MAX_TOOL_TARGET_CHARS = 160;

const CHECKPOINT_HEADER =
  "Incomplete partial result saved before the model request failed. This is not a complete answer.";
const CHECKPOINT_FOOTER =
  "The task remains incomplete. Continue after the model service recovers.";

const TOOL_TARGET_KEYS = [
  "filePath",
  "path",
  "directory",
  "cwd",
  "pattern",
  "glob",
  "target",
] as const;

export interface FailureCheckpointInput {
  messages: readonly Message[];
  completedTurnIds: readonly TurnId[];
  failedTurnId: TurnId;
}

/**
 * Builds a user-visible, deterministic fallback from already persisted data.
 *
 * The builder deliberately ignores user messages, reasoning, tool output/error
 * bodies, and text produced by the failed turn. Callers are responsible for
 * persisting the returned text as a synthetic assistant part.
 */
export function buildFailureCheckpoint(input: FailureCheckpointInput): string | undefined {
  const orderedMessages = [...input.messages].sort(compareMessages);
  if (failedTurnHasAssistantText(orderedMessages, input.failedTurnId)) return undefined;

  const completedTurnIds = new Set<TurnId>(input.completedTurnIds);
  const completedMessages = orderedMessages.filter((message) => (
    message.role === "assistant"
    && message.turnId !== undefined
    && completedTurnIds.has(message.turnId)
  ));
  const progress = priorAssistantProgress(completedMessages);
  const toolActivity = summarizeToolActivity(completedMessages);
  if (progress.length === 0 && toolActivity.length === 0) return undefined;

  const sections: string[] = [];
  if (progress.length > 0) {
    sections.push([
      "Previously saved assistant progress:",
      ...progress.map((item) => `- ${indentContinuationLines(item)}`),
    ].join("\n"));
  }
  if (toolActivity.length > 0) {
    sections.push([
      "Tool activity completed before the failure:",
      ...toolActivity,
    ].join("\n"));
  }

  return frameCheckpoint(sections.join("\n\n"));
}

function failedTurnHasAssistantText(messages: readonly Message[], failedTurnId: TurnId): boolean {
  return messages.some((message) => (
    message.role === "assistant"
    && message.turnId === failedTurnId
    && message.parts.some((part) => (
      part.type === "text"
      && part.synthetic !== true
      && part.text.trim().length > 0
    ))
  ));
}

function priorAssistantProgress(messages: readonly Message[]): string[] {
  const candidates = messages.flatMap((message) => message.parts.flatMap((part) => {
    if (part.type !== "text" || part.synthetic === true) return [];
    const sanitized = sanitizeAssistantProgress(part.text);
    return sanitized ? [sanitized] : [];
  }));

  const deduplicated: string[] = [];
  const seen = new Set<string>();
  for (let index = candidates.length - 1; index >= 0 && deduplicated.length < MAX_PROGRESS_ITEMS; index--) {
    const candidate = candidates[index];
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    deduplicated.unshift(candidate);
  }
  return deduplicated;
}

function sanitizeAssistantProgress(value: string): string | undefined {
  if (looksLikeRawHtml(value) || looksLikeProviderFailure(value)) return undefined;
  const sanitized = value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (!sanitized) return undefined;
  return truncateText(sanitized, MAX_PROGRESS_ITEM_CHARS);
}

function summarizeToolActivity(messages: readonly Message[]): string[] {
  const results = new Map<string, ToolResultPart>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_result") results.set(part.callId, part);
    }
  }

  const calls: Array<{ call: ToolCallPart; result: ToolResultPart }> = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool_call" || seen.has(part.callId)) continue;
      const result = results.get(part.callId);
      if (!result) continue;
      seen.add(part.callId);
      calls.push({ call: part, result });
    }
  }

  const visible = calls.slice(0, MAX_TOOL_ACTIVITY_ITEMS).map(({ call, result }) => {
    const toolName = sanitizeInline(call.toolName, MAX_TOOL_NAME_CHARS) || "tool";
    const status = toolActivityStatus(result);
    const target = toolTarget(call.input);
    return `- ${toolName}: ${status}${target ? ` (${target})` : ""}`;
  });
  const omitted = calls.length - visible.length;
  if (omitted > 0) visible.push(`- ${omitted} additional tool activities omitted.`);
  return visible;
}

function toolActivityStatus(result: ToolResultPart): string {
  if (result.executionContext?.aborted) return "cancelled";
  if (
    result.error
    || result.executionContext?.timedOut
    || (typeof result.executionContext?.exitCode === "number" && result.executionContext.exitCode !== 0)
  ) {
    return "failed";
  }
  return "completed";
}

function toolTarget(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of TOOL_TARGET_KEYS) {
    const value = input[key];
    if (typeof value === "string") {
      const target = sanitizeInline(value, MAX_TOOL_TARGET_CHARS);
      if (target) return target;
    }
    if (Array.isArray(value)) {
      const target = value
        .filter((item): item is string => typeof item === "string")
        .slice(0, 3)
        .map((item) => sanitizeInline(item, Math.floor(MAX_TOOL_TARGET_CHARS / 3)))
        .filter(Boolean)
        .join(", ");
      if (target) return truncateText(target, MAX_TOOL_TARGET_CHARS);
    }
  }
  return undefined;
}

function frameCheckpoint(body: string): string {
  const separator = "\n\n";
  const fixedChars = CHECKPOINT_HEADER.length + CHECKPOINT_FOOTER.length + separator.length * 2;
  const boundedBody = truncateText(body, FAILURE_CHECKPOINT_MAX_CHARS - fixedChars);
  return `${CHECKPOINT_HEADER}${separator}${boundedBody}${separator}${CHECKPOINT_FOOTER}`;
}

function sanitizeInline(value: string, maxChars: number): string | undefined {
  if (looksLikeRawHtml(value) || looksLikeProviderFailure(value)) return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? truncateText(normalized, maxChars) : undefined;
}

function looksLikeRawHtml(value: string): boolean {
  return /<!doctype\s+html|<\/?(?:html|head|body|title|script|style)(?:\s[^>]*)?>/i.test(value);
}

function looksLikeProviderFailure(value: string): boolean {
  return (
    /\bmodel request failed\b/i.test(value)
    || /\b(?:provider|gateway|parent execution|response stream).{0,48}\b(?:failed|error|closed)\b/i.test(value)
    || /\bhttp\s*5\d\d\b/i.test(value)
    || /\b502\s+bad gateway\b/i.test(value)
    || /\bcloudflare\b/i.test(value)
  );
}

function truncateText(value: string, maxChars: number): string {
  const limit = Math.max(1, Math.floor(maxChars));
  if (value.length <= limit) return value;
  if (limit === 1) return "…";
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function indentContinuationLines(value: string): string {
  return value.replaceAll("\n", "\n  ");
}

function compareMessages(left: Message, right: Message): number {
  return Number(left.createdAt) - Number(right.createdAt) || left.id.localeCompare(right.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
