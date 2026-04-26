import type { Message, MessageId, MessagePart, ToolResultPart } from "@chili/protocol";

export interface ContextBudgetOptions {
  maxInputChars?: number;
  compactionThresholdRatio?: number;
  maxToolResultChars?: number;
  preserveRecentMessages?: number;
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
  omittedMessages: number;
}

export interface CompactionBoundary {
  boundaryMessageId: MessageId;
  reason: "token_budget";
  estimatedChars: number;
  budgetChars: number;
}

const DEFAULT_MAX_INPUT_CHARS = 160_000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 24_000;
const DEFAULT_THRESHOLD_RATIO = 0.85;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 4;

export class ContextWindowBuilder {
  private readonly maxInputChars: number;
  private readonly maxToolResultChars: number;
  private readonly compactionThresholdRatio: number;
  private readonly preserveRecentMessages: number;

  constructor(options: ContextBudgetOptions = {}) {
    this.maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    this.compactionThresholdRatio = options.compactionThresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
    this.preserveRecentMessages = options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES;
  }

  build(messages: readonly Message[]): ContextBuildResult {
    const rawChars = estimateMessages(messages);
    const truncated = messages.map((message) => this.truncateMessage(message));
    const truncatedToolResults = truncated.reduce((count, message) => count + countTruncatedToolResults(message), 0);
    const threshold = Math.floor(this.maxInputChars * this.compactionThresholdRatio);
    const truncatedChars = estimateMessages(truncated);

    if (truncatedChars <= this.maxInputChars) {
      const firstMessage = truncated[0];
      return {
        messages: truncated,
        usage: {
          rawChars,
          contextChars: truncatedChars,
          budgetChars: this.maxInputChars,
          truncatedToolResults,
          omittedMessages: 0,
        },
        ...(truncatedChars >= threshold && firstMessage
          ? {
              compactionBoundary: {
                boundaryMessageId: firstMessage.id,
                reason: "token_budget",
                estimatedChars: truncatedChars,
                budgetChars: this.maxInputChars,
              },
            }
          : {}),
      };
    }

    const selected: Message[] = [];
    let used = 0;
    for (let index = truncated.length - 1; index >= 0; index--) {
      const message = truncated[index];
      if (!message) continue;
      const cost = estimateMessage(message);
      const remainingMessages = truncated.length - index;
      const mustPreserve = remainingMessages <= this.preserveRecentMessages;
      if (!mustPreserve && used + cost > this.maxInputChars) break;
      selected.unshift(message);
      used += cost;
    }

    const omittedMessages = truncated.length - selected.length;
    const boundaryMessage = omittedMessages > 0 ? truncated[omittedMessages - 1] : selected[0];
    const boundaryMessageId = boundaryMessage?.id;
    const result: ContextBuildResult = {
      messages: selected,
      usage: {
        rawChars,
        contextChars: estimateMessages(selected),
        budgetChars: this.maxInputChars,
        truncatedToolResults,
        omittedMessages,
      },
    };

    if (boundaryMessageId) {
      result.compactionBoundary = {
        boundaryMessageId,
        reason: "token_budget",
        estimatedChars: truncatedChars,
        budgetChars: this.maxInputChars,
      };
    }

    return result;
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
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...part }) as MessagePart),
  };
}

function estimateMessages(messages: readonly Message[]): number {
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
    case "tool_result":
      return part.output.length + (part.error?.length ?? 0) + 64;
    case "tool_call":
      return JSON.stringify(part.input).length + part.toolName.length + 64;
    case "patch":
      return part.files.join("\n").length + 64;
    case "artifact":
      return part.artifactId.length + 32;
    case "compaction":
      return part.boundaryMessageId.length + part.reason.length + 64;
    case "agent_handoff":
      return part.agentPath.length + part.summary.length + 64;
  }
}

function countTruncatedToolResults(message: Message): number {
  return message.parts.filter((part) => part.type === "tool_result" && part.output.includes("[tool result omitted from context")).length;
}
