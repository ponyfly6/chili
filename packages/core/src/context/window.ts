import type { Message, MessageId, MessagePart, ToolDefinition, ToolResultPart } from "@chili/protocol";

export interface ContextBudgetOptions {
  maxInputChars?: number;
  compactionThresholdRatio?: number;
  maxToolResultChars?: number;
  maxTotalToolResultChars?: number;
  compactedToolResultChars?: number;
  preserveRecentMessages?: number;
  preserveRecentToolResults?: number;
  framingSafetyTokens?: number;
}

export interface ContextRequestSurface {
  contextWindowTokens?: number;
  requestMaxOutputTokens?: number;
  system?: readonly string[];
  developer?: readonly string[];
  contextualUser?: readonly string[];
  tools?: readonly ToolDefinition[];
}

export interface ContextBuildResult {
  messages: Message[];
  usage: ContextUsage;
  compactionBoundary?: CompactionBoundary;
  overflow?: ContextWindowOverflow;
}

export interface ContextUsage {
  rawChars: number;
  contextChars: number;
  budgetChars: number;
  truncatedToolResults: number;
  compactedToolResults: number;
  omittedMessages: number;
  contextTokens?: number;
  fixedInputTokens?: number;
  budgetTokens?: number;
  outputReserveTokens?: number;
}

export interface ContextWindowOverflow {
  reason: "fixed_input_exceeds_window" | "current_message_too_large";
  estimatedTokens: number;
  budgetTokens: number;
}

export class ContextWindowExceededError extends Error {
  constructor(readonly overflow: ContextWindowOverflow) {
    super(
      overflow.reason === "fixed_input_exceeds_window"
        ? `Fixed prompt and output reserve exceed the model context window (${overflow.estimatedTokens} > ${overflow.budgetTokens} tokens)`
        : `Current message exceeds the available model context budget (${overflow.estimatedTokens} > ${overflow.budgetTokens} tokens)`,
    );
    this.name = "ContextWindowExceededError";
  }
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
const IMAGE_CONTEXT_ESTIMATE_TOKENS = 1024;
const DEFAULT_FRAMING_SAFETY_TOKENS = 2048;

export class ContextWindowBuilder {
  private readonly maxInputChars: number;
  private readonly maxToolResultChars: number;
  private readonly maxTotalToolResultChars: number;
  private readonly compactedToolResultChars: number;
  private readonly compactionThresholdRatio: number;
  private readonly preserveRecentMessages: number;
  private readonly preserveRecentToolResults: number;
  private readonly framingSafetyTokens: number;

  constructor(options: ContextBudgetOptions = {}) {
    this.maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    this.maxTotalToolResultChars = options.maxTotalToolResultChars ?? DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS;
    this.compactedToolResultChars = options.compactedToolResultChars ?? DEFAULT_COMPACTED_TOOL_RESULT_CHARS;
    this.compactionThresholdRatio = options.compactionThresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
    this.preserveRecentMessages = options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES;
    this.preserveRecentToolResults = options.preserveRecentToolResults ?? DEFAULT_PRESERVE_RECENT_TOOL_RESULTS;
    this.framingSafetyTokens = Math.max(0, options.framingSafetyTokens ?? DEFAULT_FRAMING_SAFETY_TOKENS);
  }

  build(messages: readonly Message[], surface: ContextRequestSurface = {}): ContextBuildResult {
    const rawChars = estimateMessages(messages);
    const compactedMessages = compactedMessageView(messages).filter(hasContextParts);
    const compactedMessagesOmitted = messages.length - compactedMessages.length;
    const truncated = compactedMessages.map((message) => this.truncateMessage(message));
    const truncatedToolResults = truncated.reduce((count, message) => count + countTruncatedToolResults(message), 0);
    const toolCompacted = this.compactToolResultsByBudget(truncated);
    const budgeted = toolCompacted.messages;
    const threshold = Math.floor(this.maxInputChars * this.compactionThresholdRatio);
    const truncatedChars = estimateMessages(budgeted);
    const surfaceBudget = resolveSurfaceBudget(surface, this.framingSafetyTokens);
    const truncatedTokens = surfaceBudget ? estimateMessagesTokens(budgeted) : undefined;
    const withinTokenBudget = !surfaceBudget || (truncatedTokens ?? 0) <= surfaceBudget.historyBudgetTokens;

    if (truncatedChars <= this.maxInputChars && withinTokenBudget) {
      const boundary = this.chooseBoundary(budgeted, "token_budget", truncatedChars);
      const tokenThresholdReached = surfaceBudget
        && (truncatedTokens ?? 0) >= Math.floor(surfaceBudget.historyBudgetTokens * this.compactionThresholdRatio);
      return {
        messages: budgeted,
        usage: this.contextUsage({
          rawChars,
          contextChars: truncatedChars,
          contextTokens: truncatedTokens,
          surfaceBudget,
          truncatedToolResults,
          compactedToolResults: toolCompacted.compactedToolResults,
          omittedMessages: compactedMessagesOmitted,
        }),
        ...((truncatedChars >= threshold || tokenThresholdReached) && boundary
          ? { compactionBoundary: boundary }
          : {}),
      };
    }

    const selected: Message[] = [];
    let usedChars = 0;
    let usedTokens = 0;
    for (let index = budgeted.length - 1; index >= 0; index--) {
      const message = budgeted[index];
      if (!message) continue;
      const costChars = estimateMessage(message);
      const costTokens = surfaceBudget ? estimateMessageTokens(message) : 0;
      const remainingMessages = budgeted.length - index;
      const mustPreserve = remainingMessages <= this.preserveRecentMessages;
      const exceedsChars = usedChars + costChars > this.maxInputChars;
      const exceedsTokens = surfaceBudget && usedTokens + costTokens > surfaceBudget.historyBudgetTokens;
      if ((exceedsChars || exceedsTokens) && (!mustPreserve || surfaceBudget)) break;
      selected.unshift(message);
      usedChars += costChars;
      usedTokens += costTokens;
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
      usage: this.contextUsage({
        rawChars,
        contextChars: estimateMessages(selected),
        contextTokens: surfaceBudget ? estimateMessagesTokens(selected) : undefined,
        surfaceBudget,
        truncatedToolResults,
        compactedToolResults: toolCompacted.compactedToolResults,
        omittedMessages,
      }),
    };

    if (boundary) result.compactionBoundary = boundary;
    if (surfaceBudget && budgeted.length > 0 && selected.length === 0) {
      const currentMessage = budgeted.at(-1);
      const currentTokens = currentMessage ? estimateMessageTokens(currentMessage) : 0;
      result.overflow = {
        reason: surfaceBudget.historyBudgetTokens <= 0
          ? "fixed_input_exceeds_window"
          : "current_message_too_large",
        estimatedTokens: currentTokens
          + surfaceBudget.fixedInputTokens
          + surfaceBudget.outputReserveTokens
          + surfaceBudget.framingSafetyTokens,
        budgetTokens: surfaceBudget.contextWindowTokens,
      };
    }

    return result;
  }

  private contextUsage(input: {
    rawChars: number;
    contextChars: number;
    contextTokens: number | undefined;
    surfaceBudget: ResolvedSurfaceBudget | undefined;
    truncatedToolResults: number;
    compactedToolResults: number;
    omittedMessages: number;
  }): ContextUsage {
    const usage: ContextUsage = {
      rawChars: input.rawChars,
      contextChars: input.contextChars,
      budgetChars: this.maxInputChars,
      truncatedToolResults: input.truncatedToolResults,
      compactedToolResults: input.compactedToolResults,
      omittedMessages: input.omittedMessages,
    };
    if (input.contextTokens !== undefined) usage.contextTokens = input.contextTokens;
    if (input.surfaceBudget) {
      usage.fixedInputTokens = input.surfaceBudget.fixedInputTokens;
      usage.budgetTokens = input.surfaceBudget.historyBudgetTokens;
      usage.outputReserveTokens = input.surfaceBudget.outputReserveTokens;
    }
    return usage;
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

export function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

interface ResolvedSurfaceBudget {
  contextWindowTokens: number;
  fixedInputTokens: number;
  outputReserveTokens: number;
  framingSafetyTokens: number;
  historyBudgetTokens: number;
}

function resolveSurfaceBudget(
  surface: ContextRequestSurface,
  framingSafetyTokens: number,
): ResolvedSurfaceBudget | undefined {
  const contextWindowTokens = positiveInteger(surface.contextWindowTokens);
  if (!contextWindowTokens) return undefined;
  const outputReserveTokens = Math.min(
    contextWindowTokens,
    positiveInteger(surface.requestMaxOutputTokens) ?? 0,
  );
  const fixedInputTokens = estimateStringsTokens([
    ...(surface.system ?? []),
    ...(surface.developer ?? []),
    ...(surface.contextualUser ?? []),
  ]) + estimateToolsTokens(surface.tools ?? []);
  return {
    contextWindowTokens,
    fixedInputTokens,
    outputReserveTokens,
    framingSafetyTokens,
    historyBudgetTokens: Math.max(
      0,
      contextWindowTokens - outputReserveTokens - fixedInputTokens - framingSafetyTokens,
    ),
  };
}

function estimateMessageTokens(message: Message): number {
  return message.parts.reduce(
    (total, part) => total + estimatePartTokens(part),
    8 + estimateTextTokens(message.role),
  );
}

function estimatePartTokens(part: MessagePart): number {
  switch (part.type) {
    case "text":
    case "reasoning":
      return estimateTextTokens(part.text);
    case "image":
      return IMAGE_CONTEXT_ESTIMATE_TOKENS
        + estimateTextTokens(`${part.mimeType}${part.filename ?? ""}${part.sourcePath ?? ""}`)
        + 16;
    case "tool_result":
      return estimateTextTokens(part.output)
        + estimateTextTokens(part.error ?? "")
        + estimateToolResultContentTokens(part.content)
        + 16;
    case "tool_call":
      return estimateTextTokens(JSON.stringify(part.input)) + estimateTextTokens(part.toolName) + 16;
    case "patch":
      return estimateTextTokens(part.files.join("\n")) + 16;
    case "artifact":
      return estimateTextTokens(part.artifactId) + 8;
    case "compaction":
      return estimateTextTokens(`${part.boundaryMessageId}${part.reason}${part.summary ?? ""}`) + 16;
    case "agent_handoff":
      return estimateTextTokens(`${part.agentPath}${part.summary}`) + 16;
  }
}

function estimateToolResultContentTokens(content: ToolResultPart["content"]): number {
  return (content ?? []).reduce((total, item) => (
    total + (item.type === "text"
      ? estimateTextTokens(item.text)
      : IMAGE_CONTEXT_ESTIMATE_TOKENS + estimateTextTokens(item.mimeType) + 16)
  ), 0);
}

function estimateStringsTokens(values: readonly string[]): number {
  return values.reduce((total, value) => total + estimateTextTokens(value) + 4, 0);
}

function estimateToolsTokens(tools: readonly ToolDefinition[]): number {
  return tools.reduce((total, tool) => total + estimateTextTokens(JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })) + 12, 0);
}

function estimateTextTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
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
