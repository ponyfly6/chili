import type { Message, MessageId, MessagePart, ToolDefinition, ToolResultPart } from "@chili/protocol";

export interface ContextBudgetOptions {
  maxInputChars?: number;
  compactionThresholdRatio?: number;
  maxToolResultChars?: number;
  maxTotalToolResultChars?: number;
  compactedToolResultChars?: number;
  maxMessagePartChars?: number;
  maxImageDataChars?: number;
  maxPromptItemChars?: number;
  maxToolDefinitionChars?: number;
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
  surface: NormalizedContextRequestSurface;
  usage: ContextUsage;
  compactionBoundary?: CompactionBoundary;
  overflow?: ContextWindowOverflow;
}

export interface NormalizedContextRequestSurface {
  contextWindowTokens?: number;
  requestMaxOutputTokens?: number;
  system: string[];
  developer: string[];
  contextualUser: string[];
  tools: ToolDefinition[];
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
const DEFAULT_MAX_MESSAGE_PART_CHARS = 80_000;
const DEFAULT_MAX_IMAGE_DATA_CHARS = 1_000_000;
const DEFAULT_MAX_PROMPT_ITEM_CHARS = 80_000;
const DEFAULT_MAX_TOOL_DEFINITION_CHARS = 64_000;
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
  private readonly maxMessagePartChars: number;
  private readonly maxImageDataChars: number;
  private readonly maxPromptItemChars: number;
  private readonly maxToolDefinitionChars: number;
  private readonly compactionThresholdRatio: number;
  private readonly preserveRecentMessages: number;
  private readonly preserveRecentToolResults: number;
  private readonly framingSafetyTokens: number;

  constructor(options: ContextBudgetOptions = {}) {
    this.maxInputChars = finiteHardLimit(options.maxInputChars, DEFAULT_MAX_INPUT_CHARS);
    this.maxToolResultChars = finiteHardLimit(options.maxToolResultChars, DEFAULT_MAX_TOOL_RESULT_CHARS);
    this.maxTotalToolResultChars = finiteHardLimit(
      options.maxTotalToolResultChars,
      DEFAULT_MAX_TOTAL_TOOL_RESULT_CHARS,
    );
    this.compactedToolResultChars = finiteHardLimit(
      options.compactedToolResultChars,
      DEFAULT_COMPACTED_TOOL_RESULT_CHARS,
    );
    this.maxMessagePartChars = finiteHardLimit(options.maxMessagePartChars, DEFAULT_MAX_MESSAGE_PART_CHARS);
    this.maxImageDataChars = finiteHardLimit(options.maxImageDataChars, DEFAULT_MAX_IMAGE_DATA_CHARS);
    this.maxPromptItemChars = finiteHardLimit(options.maxPromptItemChars, DEFAULT_MAX_PROMPT_ITEM_CHARS);
    this.maxToolDefinitionChars = finiteHardLimit(
      options.maxToolDefinitionChars,
      DEFAULT_MAX_TOOL_DEFINITION_CHARS,
    );
    this.compactionThresholdRatio = options.compactionThresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
    this.preserveRecentMessages = options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES;
    this.preserveRecentToolResults = options.preserveRecentToolResults ?? DEFAULT_PRESERVE_RECENT_TOOL_RESULTS;
    this.framingSafetyTokens = Math.max(0, options.framingSafetyTokens ?? DEFAULT_FRAMING_SAFETY_TOKENS);
  }

  build(messages: readonly Message[], surface: ContextRequestSurface = {}): ContextBuildResult {
    const normalizedSurface = this.normalizeSurface(surface);
    const snapshottedMessages = messages.map(snapshotMessage);
    const rawChars = estimateMessages(snapshottedMessages);
    const compactedMessages = compactedMessageView(snapshottedMessages).filter(hasContextParts);
    const initialCompactedMessagesOmitted = messages.length - compactedMessages.length;
    const omittedToolCallIds = new Set(
      compactedMessages.flatMap((message) => message.parts)
        .filter((part): part is Extract<MessagePart, { type: "tool_call" }> => (
          part.type === "tool_call"
          && (
            part.callId.length > this.maxMessagePartChars
            || part.toolName.length > this.maxMessagePartChars
            || boundedToolCallInput(part.input, this.maxMessagePartChars) === OMIT_CONTEXT_PART
          )
        ))
        .map((part) => part.callId),
    );
    const truncated = boundStoredSystemInstructions(
      compactedMessages
        .map((message) => this.truncateMessage(message, omittedToolCallIds))
        .map((message) => ({
          ...message,
          parts: message.parts.filter(
            (part) => part.type !== "tool_result" || !omittedToolCallIds.has(part.callId),
          ),
        }))
        .filter(hasContextParts),
      remainingStoredSystemInstructionBudget(normalizedSurface, this.maxPromptItemChars),
    );
    const pairedTruncated = dropToolResultsWithoutPrecedingCalls(truncated);
    const compactedMessagesOmitted = initialCompactedMessagesOmitted
      + compactedMessages.length - pairedTruncated.length;
    const truncatedToolResults = countChangedToolResults(compactedMessages, pairedTruncated);
    const toolCompacted = this.compactToolResultsByBudget(pairedTruncated);
    const budgeted = toolCompacted.messages;
    const threshold = Math.floor(this.maxInputChars * this.compactionThresholdRatio);
    const truncatedChars = estimateMessages(budgeted);
    const surfaceBudget = resolveSurfaceBudget(normalizedSurface, this.framingSafetyTokens);
    const truncatedTokens = surfaceBudget ? estimateMessagesTokens(budgeted) : undefined;
    const fixedInputExceedsWindow = surfaceBudget
      ? surfaceBudget.fixedInputTokens
        + surfaceBudget.outputReserveTokens
        + surfaceBudget.framingSafetyTokens > surfaceBudget.contextWindowTokens
      : false;
    if (surfaceBudget && fixedInputExceedsWindow) {
      return {
        messages: [],
        surface: normalizedSurface,
        usage: this.contextUsage({
          rawChars,
          contextChars: 0,
          contextTokens: 0,
          surfaceBudget,
          truncatedToolResults,
          compactedToolResults: toolCompacted.compactedToolResults,
          omittedMessages: compactedMessagesOmitted + budgeted.length,
        }),
        overflow: {
          reason: "fixed_input_exceeds_window",
          estimatedTokens: surfaceBudget.fixedInputTokens
            + surfaceBudget.outputReserveTokens
            + surfaceBudget.framingSafetyTokens,
          budgetTokens: surfaceBudget.contextWindowTokens,
        },
      };
    }
    const withinTokenBudget = !surfaceBudget || (truncatedTokens ?? 0) <= surfaceBudget.historyBudgetTokens;

    if (truncatedChars <= this.maxInputChars && withinTokenBudget) {
      const boundary = this.chooseBoundary(budgeted, "token_budget", truncatedChars);
      const tokenThresholdReached = surfaceBudget
        && (truncatedTokens ?? 0) >= Math.floor(surfaceBudget.historyBudgetTokens * this.compactionThresholdRatio);
      return {
        messages: budgeted,
        surface: normalizedSurface,
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
      const exceedsChars = usedChars + costChars > this.maxInputChars;
      const exceedsTokens = surfaceBudget && usedTokens + costTokens > surfaceBudget.historyBudgetTokens;
      if (exceedsChars || exceedsTokens) break;
      selected.unshift(message);
      usedChars += costChars;
      usedTokens += costTokens;
    }

    const pairedSelected = dropToolResultsWithoutPrecedingCalls(selected);
    const budgetOmittedMessages = budgeted.length - pairedSelected.length;
    const omittedMessages = compactedMessagesOmitted + budgetOmittedMessages;
    const boundary = this.chooseBoundary(
      budgeted,
      "token_budget",
      truncatedChars,
      budgetOmittedMessages > 0 ? budgetOmittedMessages - 1 : 0,
    );
    const result: ContextBuildResult = {
      messages: pairedSelected,
      surface: normalizedSurface,
      usage: this.contextUsage({
        rawChars,
        contextChars: estimateMessages(pairedSelected),
        contextTokens: surfaceBudget ? estimateMessagesTokens(pairedSelected) : undefined,
        surfaceBudget,
        truncatedToolResults,
        compactedToolResults: toolCompacted.compactedToolResults,
        omittedMessages,
      }),
    };

    if (boundary) result.compactionBoundary = boundary;
    if (budgeted.length > 0 && pairedSelected.length === 0) {
      const currentMessage = budgeted.at(-1);
      const currentTokens = currentMessage ? estimateMessageTokens(currentMessage) : 0;
      result.overflow = {
        reason: "current_message_too_large",
        estimatedTokens: surfaceBudget
          ? currentTokens
            + surfaceBudget.fixedInputTokens
            + surfaceBudget.outputReserveTokens
            + surfaceBudget.framingSafetyTokens
          : currentTokens,
        budgetTokens: surfaceBudget?.contextWindowTokens ?? Math.max(1, Math.floor(this.maxInputChars / 4)),
      };
    }

    return result;
  }

  private normalizeSurface(surface: ContextRequestSurface): NormalizedContextRequestSurface {
    const system = normalizePromptItems(surface.system, this.maxPromptItemChars, "system prompt");
    const developerBudget = Math.max(
      0,
      this.maxPromptItemChars - joinedTextLength(system, "\n\n") - (system.length > 0 ? 2 : 0),
    );
    const normalized: NormalizedContextRequestSurface = {
      system,
      developer: normalizePromptItems(surface.developer, developerBudget, "developer prompt"),
      contextualUser: normalizePromptItems(
        surface.contextualUser,
        this.maxPromptItemChars,
        "contextual user prompt",
      ),
      tools: (surface.tools ?? []).flatMap((tool) => {
        const normalizedTool = normalizeToolDefinition(tool, this.maxToolDefinitionChars);
        return normalizedTool ? [normalizedTool] : [];
      }),
    };
    if (surface.contextWindowTokens !== undefined) {
      normalized.contextWindowTokens = surface.contextWindowTokens;
    }
    if (surface.requestMaxOutputTokens !== undefined) {
      normalized.requestMaxOutputTokens = surface.requestMaxOutputTokens;
    }
    return normalized;
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

  private truncateMessage(message: Message, omittedToolCallIds: Set<string>): Message {
    const parts = message.parts.flatMap((part): MessagePart[] => {
      const next = this.truncatePart(part, omittedToolCallIds);
      return next ? [next] : [];
    });
    const messageTextBudget = Math.max(0, this.maxInputChars - message.role.length - 32);
    return {
      ...message,
      parts: boundJoinedMessageText(parts, Math.min(this.maxMessagePartChars, messageTextBudget)),
    };
  }

  private truncatePart(part: MessagePart, omittedToolCallIds: Set<string>): MessagePart | undefined {
    switch (part.type) {
      case "text":
      case "reasoning": {
        if (part.text.length <= this.maxMessagePartChars) return { ...part };
        return {
          ...part,
          text: truncateContextText(part.text, this.maxMessagePartChars, `${part.type} content`),
        };
      }
      case "image": {
        if (part.data.length > this.maxImageDataChars || part.mimeType.length > this.maxMessagePartChars) {
          return {
            id: part.id,
            messageId: part.messageId,
            sessionId: part.sessionId,
            type: "text",
            text: boundedContextNotice(
              `image${part.filename ? ` ${part.filename}` : ""} omitted: encoded payload exceeded context limit`,
              this.maxMessagePartChars,
            ),
            synthetic: true,
          };
        }
        return {
          ...part,
          ...(part.filename !== undefined
            ? { filename: truncateContextText(part.filename, this.maxMessagePartChars, "image filename") }
            : {}),
          ...(part.sourcePath !== undefined
            ? { sourcePath: truncateContextText(part.sourcePath, this.maxMessagePartChars, "image source path") }
            : {}),
        };
      }
      case "tool_call": {
        if (omittedToolCallIds.has(part.callId)) return undefined;
        const input = boundedToolCallInput(part.input, this.maxMessagePartChars);
        if (input === OMIT_CONTEXT_PART) return undefined;
        return {
          ...part,
          callId: truncateIdentifier(part.callId, this.maxMessagePartChars) as typeof part.callId,
          toolName: truncateIdentifier(part.toolName, this.maxMessagePartChars),
          input,
        };
      }
      case "tool_result":
        if (omittedToolCallIds.has(part.callId)) return undefined;
        return this.truncateToolResult(part);
      case "patch": {
        const files = part.files.join("\n");
        return files.length <= this.maxMessagePartChars
          ? { ...part, files: [...part.files] }
          : { ...part, files: [truncateContextText(files, this.maxMessagePartChars, "patch file list")] };
      }
      case "compaction":
        return {
          ...part,
          boundaryMessageId: truncateIdentifier(part.boundaryMessageId, this.maxMessagePartChars) as typeof part.boundaryMessageId,
          ...(part.summary !== undefined
            ? { summary: truncateContextText(part.summary, this.maxMessagePartChars, "compaction summary") }
            : {}),
          ...(part.sourceMessageIds !== undefined
            ? { sourceMessageIds: part.sourceMessageIds.slice(0, this.maxMessagePartChars) }
            : {}),
        };
      case "agent_handoff":
        return {
          ...part,
          agentPath: truncateContextText(part.agentPath, this.maxMessagePartChars, "agent path"),
          summary: truncateContextText(part.summary, this.maxMessagePartChars, "agent handoff summary"),
        };
      case "artifact":
        return {
          ...part,
          artifactId: truncateIdentifier(part.artifactId, this.maxMessagePartChars) as typeof part.artifactId,
        };
    }
  }

  private truncateToolResult(part: ToolResultPart): ToolResultPart {
    const errorLimit = Math.max(0, this.maxMessagePartChars - "Error: ".length);
    const error = part.error !== undefined
      ? truncateContextText(part.error, errorLimit, "tool error")
      : undefined;
    const formattedErrorChars = error ? error.length + (part.output ? "\n\nError: ".length : "Error: ".length) : 0;
    const outputLimit = Math.min(
      this.maxToolResultChars,
      Math.max(0, this.maxMessagePartChars - formattedErrorChars),
    );
    const result: ToolResultPart = {
      ...part,
      callId: truncateIdentifier(part.callId, this.maxMessagePartChars) as typeof part.callId,
      output: truncateContextText(part.output, outputLimit, "tool result"),
    };
    if (error !== undefined) result.error = error;
    if (part.content !== undefined) {
      result.content = part.content.map((item) => {
        if (item.type === "text") {
          return {
            type: "text" as const,
            text: truncateContextText(item.text, this.maxMessagePartChars, "tool result content"),
          };
        }
        if (item.data.length > this.maxImageDataChars || item.mimeType.length > this.maxMessagePartChars) {
          return {
            type: "text" as const,
            text: boundedContextNotice(
              "tool result image omitted: encoded payload exceeded context limit",
              this.maxMessagePartChars,
            ),
          };
        }
        return { ...item };
      });
    }
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

const OMIT_CONTEXT_PART = Symbol("omit_context_part");

function truncateContextText(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const limit = Math.max(0, Math.trunc(maxChars));
  const marker = `\n[${label} omitted from context after truncation]\n`;
  if (limit <= marker.length) return sliceHeadWithoutBrokenSurrogate(`${label} omitted`, limit);
  const available = limit - marker.length;
  const headChars = Math.floor(available * 0.25);
  const tailChars = available - headChars;
  return `${sliceHeadWithoutBrokenSurrogate(text, headChars)}${marker}${sliceTailWithoutBrokenSurrogate(text, tailChars)}`;
}

function boundedContextNotice(notice: string, maxChars: number): string {
  return sliceHeadWithoutBrokenSurrogate(`[${notice}]`, Math.max(0, Math.trunc(maxChars)));
}

function truncateIdentifier(value: string, maxChars: number): string {
  return sliceHeadWithoutBrokenSurrogate(value, Math.max(0, Math.trunc(maxChars)));
}

function boundedToolCallInput(input: unknown, maxChars: number): unknown | typeof OMIT_CONTEXT_PART {
  const serialized = tryJsonStringify(input);
  if (serialized === undefined) {
    return maxChars >= 2 ? {} : OMIT_CONTEXT_PART;
  }
  if (serialized.length <= maxChars) return jsonSnapshotFromSerialized(serialized);
  const limit = Math.max(0, Math.trunc(maxChars));
  if (limit < 2) return OMIT_CONTEXT_PART;
  return {};
}

function boundJoinedMessageText(parts: readonly MessagePart[], maxChars: number): MessagePart[] {
  let remaining = maxChars;
  let sawText = false;
  let remainingTextParts = parts.filter(
    (part) => (part.type === "text" || part.type === "reasoning") && part.text.length > 0,
  ).length;
  return parts.flatMap((part): MessagePart[] => {
    if (part.type !== "text" && part.type !== "reasoning") return [part];
    if (part.text.length === 0) return [];
    const separatorChars = sawText ? 1 : 0;
    const futureSeparators = Math.max(0, remainingTextParts - 1);
    const available = Math.max(
      0,
      Math.floor((remaining - separatorChars - futureSeparators) / Math.max(1, remainingTextParts)),
    );
    remainingTextParts -= 1;
    if (available === 0) return [];
    const text = truncateContextText(part.text, available, `${part.type} content`);
    if (text.length === 0) return [];
    sawText = true;
    remaining -= separatorChars + text.length;
    return [{ ...part, text }];
  });
}

function remainingStoredSystemInstructionBudget(
  surface: NormalizedContextRequestSurface,
  maxChars: number,
): number {
  const surfaceChars = joinedTextLength([...surface.system, ...surface.developer], "\n\n");
  return Math.max(0, maxChars - surfaceChars - (surfaceChars > 0 ? 2 : 0));
}

function boundStoredSystemInstructions(messages: readonly Message[], maxChars: number): Message[] {
  let remaining = maxChars;
  let sawText = false;
  return messages.flatMap((message): Message[] => {
    if (message.role !== "system") return [message];
    const parts = message.parts.flatMap((part): MessagePart[] => {
      if (part.type !== "text" && part.type !== "reasoning") return [];
      if (part.text.length === 0) return [];
      const separatorChars = sawText ? 2 : 0;
      const available = Math.max(0, remaining - separatorChars);
      if (available === 0) return [];
      const text = truncateContextText(part.text, available, "stored system instruction");
      if (text.length === 0) return [];
      sawText = true;
      remaining -= separatorChars + text.length;
      return [{ ...part, text }];
    });
    return parts.length > 0 ? [{ ...message, parts }] : [];
  });
}

function dropToolResultsWithoutPrecedingCalls(messages: readonly Message[]): Message[] {
  const seenCallIds = new Set<string>();
  return messages.flatMap((message): Message[] => {
    const parts = message.parts.filter((part) => {
      if (part.type === "tool_call") {
        seenCallIds.add(part.callId);
        return true;
      }
      if (part.type !== "tool_result") return true;
      return seenCallIds.has(part.callId);
    });
    return parts.length > 0 ? [{ ...message, parts }] : [];
  });
}

function sliceHeadWithoutBrokenSurrogate(text: string, maxChars: number): string {
  let end = Math.max(0, Math.min(text.length, maxChars));
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function sliceTailWithoutBrokenSurrogate(text: string, maxChars: number): string {
  let start = Math.max(0, text.length - Math.max(0, maxChars));
  if (start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
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

function snapshotMessage(message: Message): Message {
  const snapshot: Message = {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    parts: message.parts.map(snapshotMessagePart),
    createdAt: message.createdAt,
  };
  if (message.parentId !== undefined) snapshot.parentId = message.parentId;
  if (message.turnId !== undefined) snapshot.turnId = message.turnId;
  return snapshot;
}

function snapshotMessagePart(part: MessagePart): MessagePart {
  const base = {
    id: part.id,
    messageId: part.messageId,
    sessionId: part.sessionId,
  };
  switch (part.type) {
    case "text": {
      const snapshot: Extract<MessagePart, { type: "text" }> = { ...base, type: "text", text: part.text };
      if (part.displayText !== undefined) snapshot.displayText = part.displayText;
      if (part.synthetic !== undefined) snapshot.synthetic = part.synthetic;
      return snapshot;
    }
    case "reasoning": {
      const snapshot: Extract<MessagePart, { type: "reasoning" }> = { ...base, type: "reasoning", text: part.text };
      if (part.redacted !== undefined) snapshot.redacted = part.redacted;
      return snapshot;
    }
    case "image": {
      const snapshot: Extract<MessagePart, { type: "image" }> = {
        ...base,
        type: "image",
        data: part.data,
        mimeType: part.mimeType,
      };
      if (part.filename !== undefined) snapshot.filename = part.filename;
      if (part.sourcePath !== undefined) snapshot.sourcePath = part.sourcePath;
      if (part.displayText !== undefined) snapshot.displayText = part.displayText;
      return snapshot;
    }
    case "tool_call":
      return {
        ...base,
        type: "tool_call",
        callId: part.callId,
        toolName: part.toolName,
        input: jsonSnapshot(part.input),
        status: part.status,
      };
    case "tool_result": {
      const snapshot: ToolResultPart = {
        ...base,
        type: "tool_result",
        callId: part.callId,
        output: part.output,
      };
      const content = part.content;
      if (content !== undefined) {
        snapshot.content = content.map((item) => item.type === "text"
          ? { type: "text", text: item.text }
          : { type: "image", data: item.data, mimeType: item.mimeType });
      }
      if (part.error !== undefined) snapshot.error = part.error;
      if (part.synthetic !== undefined) snapshot.synthetic = part.synthetic;
      if (part.artifactIds !== undefined) snapshot.artifactIds = [...part.artifactIds];
      return snapshot;
    }
    case "patch": {
      const snapshot: Extract<MessagePart, { type: "patch" }> = { ...base, type: "patch", files: [...part.files] };
      if (part.artifactId !== undefined) snapshot.artifactId = part.artifactId;
      return snapshot;
    }
    case "artifact":
      return { ...base, type: "artifact", artifactId: part.artifactId };
    case "compaction": {
      const snapshot: Extract<MessagePart, { type: "compaction" }> = {
        ...base,
        type: "compaction",
        boundaryMessageId: part.boundaryMessageId,
        reason: part.reason,
      };
      if (part.summary !== undefined) snapshot.summary = part.summary;
      if (part.sourceMessageIds !== undefined) snapshot.sourceMessageIds = [...part.sourceMessageIds];
      if (part.estimatedCharsBefore !== undefined) snapshot.estimatedCharsBefore = part.estimatedCharsBefore;
      if (part.estimatedCharsAfter !== undefined) snapshot.estimatedCharsAfter = part.estimatedCharsAfter;
      return snapshot;
    }
    case "agent_handoff":
      return { ...base, type: "agent_handoff", agentPath: part.agentPath, summary: part.summary };
  }
}

function countChangedToolResults(before: readonly Message[], after: readonly Message[]): number {
  const normalizedById = new Map(
    after.flatMap((message) => message.parts)
      .filter((part): part is ToolResultPart => part.type === "tool_result")
      .map((part) => [part.id, part] as const),
  );
  return before.reduce((count, message) => count + message.parts.filter((part) => {
    if (part.type !== "tool_result") return false;
    const normalized = normalizedById.get(part.id);
    return !normalized || toolResultPayloadChanged(part, normalized);
  }).length, 0);
}

function toolResultPayloadChanged(before: ToolResultPart, after: ToolResultPart): boolean {
  if (before.callId !== after.callId || before.output !== after.output || before.error !== after.error) return true;
  if ((before.content?.length ?? 0) !== (after.content?.length ?? 0)) return true;
  return (before.content ?? []).some((item, index) => {
    const normalized = after.content?.[index];
    if (!normalized || item.type !== normalized.type) return true;
    return item.type === "text"
      ? item.text !== (normalized.type === "text" ? normalized.text : undefined)
      : item.data !== (normalized.type === "image" ? normalized.data : undefined)
        || item.mimeType !== (normalized.type === "image" ? normalized.mimeType : undefined);
  });
}

function safeJsonStringify(value: unknown): string {
  return tryJsonStringify(value) ?? "null";
}

function tryJsonStringify(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "null";
  } catch {
    return undefined;
  }
}

function jsonSnapshot(value: unknown): unknown {
  const serialized = tryJsonStringify(value);
  return serialized === undefined ? {} : jsonSnapshotFromSerialized(serialized);
}

function jsonSnapshotFromSerialized(serialized: string): unknown {
  return JSON.parse(serialized) as unknown;
}

function finiteHardLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
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

function normalizePromptItems(
  values: readonly string[] | undefined,
  maxChars: number,
  label: string,
): string[] {
  const joined = (values ?? []).filter(Boolean).join("\n\n");
  if (!joined || maxChars <= 0) return [];
  return [truncateContextText(joined, maxChars, label)];
}

function joinedTextLength(values: readonly string[], separator: string): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value.length, separator.length * (values.length - 1));
}

function normalizeToolDefinition(
  tool: ToolDefinition,
  maxChars: number,
): ToolDefinition | undefined {
  const name = tool.name;
  const description = tool.description;
  const risk = tool.risk;
  const execute = tool.execute;
  const schema = tryJsonStringify(tool.inputSchema);
  if (maxChars <= 0 || name.length > maxChars) return undefined;
  if (schema === undefined || schema.length > maxChars) return undefined;
  const inputSchema = jsonSnapshotFromSerialized(schema);
  const definitionChars = (candidateDescription: string): number => safeJsonStringify({
    name,
    description: candidateDescription,
    inputSchema,
  }).length;
  if (definitionChars("") > maxChars) return undefined;
  if (definitionChars(description) <= maxChars) {
    return { name, description, risk, inputSchema, execute };
  }

  let lower = 0;
  let upper = description.length;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    const candidateDescription = sliceHeadWithoutBrokenSurrogate(description, candidate);
    if (definitionChars(candidateDescription) <= maxChars) lower = candidate;
    else upper = candidate - 1;
  }
  return {
    name,
    description: sliceHeadWithoutBrokenSurrogate(description, lower),
    risk,
    inputSchema,
    execute,
  };
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
      return estimateTextTokens(safeJsonStringify(part.input)) + estimateTextTokens(part.toolName) + 16;
    case "patch":
      return 0;
    case "artifact":
      return 0;
    case "compaction":
      return 0;
    case "agent_handoff":
      return 0;
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
  return tools.reduce((total, tool) => total + estimateTextTokens(safeJsonStringify({
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
      return safeJsonStringify(part.input).length + part.toolName.length + 64;
    case "patch":
      return 0;
    case "artifact":
      return 0;
    case "compaction":
      return 0;
    case "agent_handoff":
      return 0;
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
  if (maxChars <= marker.length + 2 || output.length === 0) {
    return sliceHeadWithoutBrokenSurrogate(marker, Math.max(0, maxChars));
  }
  if (output.length <= maxChars) return output;

  const remaining = maxChars - marker.length - 8;
  const headChars = Math.max(0, Math.floor(remaining / 2));
  const tailChars = Math.max(0, remaining - headChars);
  return `${marker}\n${sliceHeadWithoutBrokenSurrogate(output, headChars)}\n...\n${sliceTailWithoutBrokenSurrogate(output, tailChars)}`;
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

function countToolResults(messages: readonly Message[]): number {
  return messages.reduce(
    (count, message) => count + message.parts.filter((part) => part.type === "tool_result").length,
    0,
  );
}
