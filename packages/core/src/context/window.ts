import type { Message, MessageId, MessagePart, ToolResultPart } from "@chili/protocol";

export interface ContextBudgetOptions {
  maxInputChars?: number;
  compactionThresholdRatio?: number;
  maxToolResultChars?: number;
  maxTotalToolResultChars?: number;
  compactedToolResultChars?: number;
  preserveRecentMessages?: number;
  preserveRecentToolResults?: number;
}

export interface ContextBuildResult {
  messages: Message[];
  usage: ContextUsage;
  compactionBoundary?: CompactionBoundary;
}

export interface ContextUsage {
  rawChars: number;
  contextChars: number;
  budgetChars: number;
  truncatedToolResults: number;
  compactedToolResults: number;
  omittedMessages: number;
}

export interface CompactionBoundary {
  boundaryMessageId: MessageId;
  reason: "manual" | "token_budget" | "recovery";
  estimatedChars: number;
  budgetChars: number;
}

const DEFAULT_MAX_INPUT_CHARS = 160_000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 24_000;
const DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS = 64_000;
const DEFAULT_COMPACTED_TOOL_RESULT_CHARS = 2_400;
const DEFAULT_THRESHOLD_RATIO = 0.85;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 4;
const DEFAULT_PRESERVE_RECENT_TOOL_RESULTS = 3;
const IMAGE_CONTEXT_ESTIMATE_CHARS = 4096;

export class ContextWindowBuilder {
  private readonly maxInputChars: number;
  private readonly maxToolResultChars: number;
  private readonly maxTotalToolResultChars: number;
  private readonly compactedToolResultChars: number;
  private readonly compactionThresholdRatio: number;
  private readonly preserveRecentMessages: number;
  private readonly preserveRecentToolResults: number;

  constructor(options: ContextBudgetOptions = {}) {
    this.maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    this.maxTotalToolResultChars = options.maxTotalToolResultChars ?? DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS;
    this.compactedToolResultChars = options.compactedToolResultChars ?? DEFAULT_COMPACTED_TOOL_RESULT_CHARS;
    this.compactionThresholdRatio = options.compactionThresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
    this.preserveRecentMessages = options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES;
    this.preserveRecentToolResults = options.preserveRecentToolResults ?? DEFAULT_PRESERVE_RECENT_TOOL_RESULTS;
  }

  build(messages: readonly Message[]): ContextBuildResult {
    const rawChars = estimateMessages(messages);
    const compactedMessages = compactedMessageView(messages).filter(hasContextParts);
    const compactedMessagesOmitted = messages.length - compactedMessages.length;
    const truncated = compactedMessages.map((message) => this.truncateMessage(message));
    const truncatedToolResults = truncated.reduce((count, message) => count + countTruncatedToolResults(message), 0);
    const toolCompacted = this.compactToolResultsByBudget(truncated);
    const budgeted = toolCompacted.messages;
    const threshold = Math.floor(this.maxInputChars * this.compactionThresholdRatio);
    const truncatedChars = estimateMessages(budgeted);

    if (truncatedChars <= this.maxInputChars) {
      const boundary = this.chooseBoundary(budgeted, "token_budget", truncatedChars);
      return {
        messages: budgeted,
        usage: {
          rawChars,
          contextChars: truncatedChars,
          budgetChars: this.maxInputChars,
          truncatedToolResults,
          compactedToolResults: toolCompacted.compactedToolResults,
          omittedMessages: compactedMessagesOmitted,
        },
        ...(truncatedChars >= threshold && boundary
          ? { compactionBoundary: boundary }
          : {}),
      };
    }

    const selected: Message[] = [];
    let used = 0;
    for (let index = budgeted.length - 1; index >= 0; index--) {
      const message = budgeted[index];
      if (!message) continue;
      const cost = estimateMessage(message);
      const remainingMessages = budgeted.length - index;
      const mustPreserve = remainingMessages <= this.preserveRecentMessages;
      if (!mustPreserve && used + cost > this.maxInputChars) break;
      selected.unshift(message);
      used += cost;
    }

    const budgetOmittedMessages = budgeted.length - selected.length;
    const omittedMessages = compactedMessagesOmitted + budgetOmittedMessages;
    const boundary = this.chooseBoundary(
      budgeted,
      "token_budget",
      truncatedChars,
      budgetOmittedMessages > 0 ? budgetOmittedMessages - 1 : 0,
    );
    const result: ContextBuildResult = {
      messages: selected,
      usage: {
        rawChars,
        contextChars: estimateMessages(selected),
        budgetChars: this.maxInputChars,
        truncatedToolResults,
        compactedToolResults: toolCompacted.compactedToolResults,
        omittedMessages,
      },
    };

    if (boundary) result.compactionBoundary = boundary;

    return result;
  }

  compactionBoundary(messages: readonly Message[], reason: CompactionBoundary["reason"]): CompactionBoundary | undefined {
    const compactedMessages = compactedMessageView(messages).filter(hasContextParts);
    const estimatedChars = estimateMessages(compactedMessages);
    const preferredIndex = reason === "manual" ? compactedMessages.length - 1 : undefined;
    return this.chooseBoundary(compactedMessages, reason, estimatedChars, preferredIndex);
  }

  private truncateMessage(message: Message): Message {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool_result") return part;
      const next = this.truncateToolResult(part);
      if (next !== part) changed = true;
      return next;
    });
    if (!changed) return cloneMessage(message);
    return { ...cloneMessage(message), parts };
  }

  private truncateToolResult(part: ToolResultPart): ToolResultPart {
    if (part.output.length <= this.maxToolResultChars) return part;
    const result: ToolResultPart = {
      ...part,
      output: `${part.output.slice(0, this.maxToolResultChars)}\n[tool result omitted from context after ${this.maxToolResultChars} chars]`,
    };
    if (part.synthetic !== undefined) result.synthetic = part.synthetic;
    return result;
  }

  private compactToolResultsByBudget(messages: readonly Message[]): {
    messages: Message[];
    compactedToolResults: number;
  } {
    if (this.maxTotalToolResultChars <= 0) {
      return { messages: messages.map((message) => this.compactAllToolResults(message)), compactedToolResults: countToolResults(messages) };
    }

    let used = 0;
    let seenToolResults = 0;
    const compactPartIds = new Set<string>();

    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
      const message = messages[messageIndex];
      if (!message) continue;
      for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = message.parts[partIndex];
        if (part?.type !== "tool_result") continue;
        seenToolResults++;
        const cost = estimateToolResultPayload(part);
        const mustPreserve = seenToolResults <= this.preserveRecentToolResults;
        if (mustPreserve || used + cost <= this.maxTotalToolResultChars) {
          used += cost;
          continue;
        }
        compactPartIds.add(part.id);
      }
    }

    if (compactPartIds.size === 0) {
      return { messages: [...messages], compactedToolResults: 0 };
    }

    return {
      messages: messages.map((message) => this.compactSelectedToolResults(message, compactPartIds)),
      compactedToolResults: compactPartIds.size,
    };
  }

  private compactAllToolResults(message: Message): Message {
    return this.compactSelectedToolResults(message, new Set(message.parts.map((part) => part.id)));
  }

  private compactSelectedToolResults(message: Message, compactPartIds: ReadonlySet<string>): Message {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool_result" || !compactPartIds.has(part.id)) return part;
      changed = true;
      return this.compactToolResult(part);
    });
    if (!changed) return cloneMessage(message);
    return { ...cloneMessage(message), parts };
  }

  private compactToolResult(part: ToolResultPart): ToolResultPart {
    const { content: _content, ...rest } = part;
    const result: ToolResultPart = {
      ...rest,
      output: compactToolResultOutput(part.output, this.compactedToolResultChars),
      synthetic: part.synthetic ?? true,
    };
    if (part.error !== undefined) result.error = part.error;
    if (part.artifactIds !== undefined) result.artifactIds = part.artifactIds;
    return result;
  }

  private chooseBoundary(
    messages: readonly Message[],
    reason: CompactionBoundary["reason"],
    estimatedChars: number,
    preferredIndex?: number,
  ): CompactionBoundary | undefined {
    if (messages.length === 0) return undefined;
    const boundaryIndex = preferredIndex ?? Math.max(0, messages.length - this.preserveRecentMessages - 1);
    if (wouldCompactOnlySummary(messages, boundaryIndex)) return undefined;
    const boundaryMessage = messages[boundaryIndex];
    if (!boundaryMessage) return undefined;
    return {
      boundaryMessageId: boundaryMessage.id,
      reason,
      estimatedChars,
      budgetChars: this.maxInputChars,
    };
  }
}

function wouldCompactOnlySummary(messages: readonly Message[], boundaryIndex: number): boolean {
  if (boundaryIndex !== 0) return false;
  const onlySourceMessage = messages[0];
  return onlySourceMessage?.parts.some((part) => part.type === "compaction") ?? false;
}

function hasContextParts(message: Message): boolean {
  return message.parts.length > 0;
}

export function compactedMessageView(messages: readonly Message[]): Message[] {
  const compactedAt = findLatestCompaction(messages);
  if (!compactedAt) return [...messages];

  const compactionMessage = messages[compactedAt.messageIndex];
  if (!compactionMessage) return [...messages];

  const boundaryIndex = messages.findIndex((message) => message.id === compactedAt.boundaryMessageId);
  if (boundaryIndex >= 0) {
    return [
      compactionMessage,
      ...messages
        .slice(boundaryIndex + 1)
        .filter((message) => message.id !== compactionMessage.id),
    ];
  }

  return messages.slice(compactedAt.messageIndex);
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...part }) as MessagePart),
  };
}

export function estimateMessages(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessage(message), 0);
}

function estimateMessage(message: Message): number {
  return message.parts.reduce((total, part) => total + estimatePart(part), message.role.length + 32);
}

function estimatePart(part: MessagePart): number {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text.length;
    case "image":
      return IMAGE_CONTEXT_ESTIMATE_CHARS + part.mimeType.length + (part.filename?.length ?? 0) + (part.sourcePath?.length ?? 0) + 64;
    case "tool_result":
      return part.output.length + (part.error?.length ?? 0) + estimateToolResultContent(part.content) + 64;
    case "tool_call":
      return JSON.stringify(part.input).length + part.toolName.length + 64;
    case "patch":
      return part.files.join("\n").length + 64;
    case "artifact":
      return part.artifactId.length + 32;
    case "compaction":
      return part.boundaryMessageId.length + part.reason.length + (part.summary?.length ?? 0) + 64;
    case "agent_handoff":
      return part.agentPath.length + part.summary.length + 64;
  }
}

function estimateToolResultPayload(part: ToolResultPart): number {
  return part.output.length + (part.error?.length ?? 0) + estimateToolResultContent(part.content);
}

function estimateToolResultContent(content: ToolResultPart["content"]): number {
  return (content ?? []).reduce((total, item) => {
    if (item.type === "text") return total + item.text.length;
    return total + IMAGE_CONTEXT_ESTIMATE_CHARS + item.mimeType.length + 64;
  }, 0);
}

function compactToolResultOutput(output: string, maxChars: number): string {
  const marker = `[tool result compacted from context; original output was ${output.length} chars]`;
  if (maxChars <= marker.length + 2 || output.length === 0) return marker;
  if (output.length <= maxChars) return output;

  const remaining = maxChars - marker.length - 8;
  const headChars = Math.max(0, Math.floor(remaining / 2));
  const tailChars = Math.max(0, remaining - headChars);
  return `${marker}\n${output.slice(0, headChars)}\n...\n${output.slice(-tailChars)}`;
}

function findLatestCompaction(messages: readonly Message[]): { messageIndex: number; boundaryMessageId: MessageId } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const part = message?.parts.find((candidate) => candidate.type === "compaction");
    if (part?.type === "compaction") {
      return { messageIndex: index, boundaryMessageId: part.boundaryMessageId };
    }
  }
  return undefined;
}

function countTruncatedToolResults(message: Message): number {
  return message.parts.filter((part) => part.type === "tool_result" && part.output.includes("[tool result omitted from context")).length;
}

function countToolResults(messages: readonly Message[]): number {
  return messages.reduce(
    (count, message) => count + message.parts.filter((part) => part.type === "tool_result").length,
    0,
  );
}
