import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  MessagePart,
  ModelSelection,
  ModelUsage,
  RuntimeModelDescriptor,
  ReasoningLevel,
  ServiceTier,
  PartId,
  SessionId,
  ThreadId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import type { EventStore } from "@chili/store";
import type { ChiliToolDefinition, ToolAccessPolicy, ToolAccessPolicyResolver, ToolRegistry } from "@chili/tools";
import { ToolExecutor, filterToolsByPolicy } from "@chili/tools";
import {
  ContextCompactionService,
  ContextWindowExceededError,
  ContextWindowBuilder,
  type CompactionBoundary,
  type ContextBudgetOptions,
  type ContextCompactionOptions,
  type ContextCompactionResult,
  type ContextRequestSurface,
  type ContextUsage,
} from "./context/index.js";
import { messagesForContext } from "./cancelled-turn-context.js";
import { DoomLoopError, DoomLoopGuard, type DoomLoopGuardOptions } from "./doom-loop-guard.js";
import { addModelUsage, attachModelUsage, takeModelUsage } from "./model-usage.js";
import { normalizeRetryPolicy, retryDelay, sleep, type RetryPolicy } from "./retry.js";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";
import type { AgentRunner, AppendUserMessageInput, CreateSessionInput, RunTurnInput, RunTurnResult } from "./runner.js";

export type { AppendUserMessageInput, CreateSessionInput, RunTurnInput, RunTurnResult } from "./runner.js";

export interface SingleAgentRuntimeOptions {
  store: EventStore;
  model: ModelRouter;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  toolPolicyResolver?: ToolAccessPolicyResolver;
  contextBudget?: ContextBudgetOptions;
  contextBuilder?: ContextWindowBuilder;
  contextCompaction?: Omit<ContextCompactionOptions, "model" | "now">;
  contextCompactor?: ContextCompactionService;
  retryPolicy?: RetryPolicy;
  doomLoopGuard?: DoomLoopGuardOptions;
  maxConcurrentToolCalls?: number;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
}

interface EventContext {
  sessionId: SessionId;
  threadId?: ThreadId;
}

interface PendingToolCall {
  callId: ToolCallId;
  toolName: string;
  input: unknown;
  inputParseError?: string;
}

interface StreamingToolCall {
  callId: ToolCallId;
  toolName: string;
  input: unknown;
}

interface AssistantStreamState {
  textPartId?: PartId;
  reasoningPartId?: PartId;
  toolCalls: PendingToolCall[];
  streamingToolCalls: Map<string, StreamingToolCall>;
}

interface AssistantStreamResult {
  finishReason?: string;
  toolCalls: PendingToolCall[];
  usage?: ModelUsage;
}

interface CompactionAttemptResult {
  completed: boolean;
  usage?: ModelUsage;
}

export interface CompactContextInput {
  sessionId: SessionId;
  threadId: ThreadId;
  turnId?: TurnId;
  reason?: "manual" | "token_budget" | "recovery";
  instructions?: string;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  signal?: AbortSignal;
}

export type CompactContextResult =
  | {
      status: "completed";
      turnId: TurnId;
      messageId: MessageId;
      boundaryMessageId: MessageId;
      summaryChars: number;
      usage?: ModelUsage;
    }
  | {
      status: "skipped";
      turnId: TurnId;
      reason: string;
      usage?: ModelUsage;
    }
  | {
      status: "failed" | "cancelled";
      turnId: TurnId;
      error: Error;
      usage?: ModelUsage;
    };

export class SingleAgentRuntime implements AgentRunner {
  constructor(private readonly options: SingleAgentRuntimeOptions) {}

  listModels(): Promise<readonly RuntimeModelDescriptor[]> | readonly RuntimeModelDescriptor[] {
    return this.options.model.listModels?.() ?? [];
  }

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    const sessionId = input.sessionId ?? this.id<SessionId>("session");
    await this.append(
      {
        sessionId,
        threadId: input.threadId,
      },
      "session.created",
      { sessionId, cwd: input.cwd },
    );
    return sessionId;
  }

  async appendUserMessage(input: AppendUserMessageInput): Promise<MessageId> {
    const messageId = this.id<MessageId>("msg");
    await this.append(input, "message.created", {
      messageId,
      role: "user",
      ...(input.turnId ? { turnId: input.turnId } : {}),
    });
    const images = input.images ?? [];
    if (input.text.length > 0 || images.length === 0) {
      const part: Extract<MessagePart, { type: "text" }> = {
        id: this.id<PartId>("part"),
        messageId,
        sessionId: input.sessionId,
        type: "text",
        text: input.text,
      };
      if (input.displayText) part.displayText = input.displayText;
      await this.appendPart(input, messageId, part);
    }
    for (const image of images) {
      const part: Extract<MessagePart, { type: "image" }> = {
        id: this.id<PartId>("part"),
        messageId,
        sessionId: input.sessionId,
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
      };
      if (image.filename) part.filename = image.filename;
      if (image.sourcePath) part.sourcePath = image.sourcePath;
      await this.appendPart(input, messageId, part);
    }
    return messageId;
  }

  async compactContext(input: CompactContextInput): Promise<CompactContextResult> {
    const turnId = input.turnId ?? this.id<TurnId>("turn");
    const reason = input.reason ?? "manual";
    let boundary: CompactionBoundary | undefined;
    let usage: ModelUsage | undefined;
    try {
      await this.append(input, "turn.started", { turnId });
      const rawMessages = await messagesForContext(this.options.store, input.sessionId);
      boundary = this.contextBuilder().compactionBoundary(rawMessages, reason);
      if (!boundary) {
        await this.append(input, "turn.completed", { turnId, status: "completed" });
        return { status: "skipped", turnId, reason: "No messages available to compact" };
      }

      await this.append(input, "turn.compaction_requested", {
        turnId,
        reason,
        boundaryMessageId: boundary.boundaryMessageId,
        estimatedChars: boundary.estimatedChars,
        budgetChars: boundary.budgetChars,
      });
      const result = await this.compactMessages(input, turnId, rawMessages, boundary);
      usage = addModelUsage(usage, result.usage);
      await this.append(input, "turn.completed", { turnId, status: "completed" });
      const completed: Extract<CompactContextResult, { status: "completed" }> = {
        status: "completed",
        turnId,
        messageId: result.messageId,
        boundaryMessageId: result.boundaryMessageId,
        summaryChars: result.summaryChars,
      };
      if (usage) completed.usage = usage;
      return completed;
    } catch (error) {
      const err = toError(error);
      usage = addModelUsage(usage, takeModelUsage(err));
      const status = isAbortError(err) ? "cancelled" : "failed";
      await this.append(input, "turn.compaction_failed", {
        turnId,
        reason,
        ...(boundary ? { boundaryMessageId: boundary.boundaryMessageId } : {}),
        error: err.message,
      });
      await this.append(input, "turn.completed", { turnId, status });
      const failed: Extract<CompactContextResult, { status: "failed" | "cancelled" }> = {
        status,
        turnId,
        error: err,
      };
      if (usage) failed.usage = usage;
      return failed;
    }
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const turnId = input.turnId ?? this.id<TurnId>("turn");
    let assistantMessageId: MessageId | undefined;
    let contextUsage: ContextUsage | undefined;
    let turnUsage: ModelUsage | undefined;

    try {
      await this.append(input, "turn.started", { turnId });

      const visibleTools = await this.visibleTools(input, turnId);
      const requestLimits = await this.options.model.resolveRequestLimits?.({
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.reasoningLevel !== undefined ? { reasoningLevel: input.reasoningLevel } : {}),
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      });
      const contextSurface: ContextRequestSurface = {
        ...(requestLimits?.contextWindowTokens !== undefined
          ? { contextWindowTokens: requestLimits.contextWindowTokens }
          : {}),
        ...(requestLimits?.requestMaxOutputTokens !== undefined
          ? { requestMaxOutputTokens: requestLimits.requestMaxOutputTokens }
          : {}),
        system: input.system ?? [],
        developer: input.developer ?? [],
        contextualUser: input.contextualUser ?? [],
        tools: visibleTools,
      };
      const rawMessages = await messagesForContext(this.options.store, input.sessionId);
      let context = this.contextBuilder().build(rawMessages, contextSurface);
      if (context.overflow) throw new ContextWindowExceededError(context.overflow);
      contextUsage = context.usage;
      if (context.compactionBoundary) {
        await this.append(input, "turn.compaction_requested", {
          turnId,
          reason: context.compactionBoundary.reason,
          boundaryMessageId: context.compactionBoundary.boundaryMessageId,
          estimatedChars: context.compactionBoundary.estimatedChars,
          budgetChars: context.compactionBoundary.budgetChars,
        });
        const compacted = await this.tryCompactMessages(input, turnId, rawMessages, context.compactionBoundary);
        turnUsage = addModelUsage(turnUsage, compacted.usage);
        if (compacted.completed) {
          context = this.contextBuilder().build(
            await messagesForContext(this.options.store, input.sessionId),
            contextSurface,
          );
          if (context.overflow) throw new ContextWindowExceededError(context.overflow);
          contextUsage = context.usage;
        }
      }

      assistantMessageId = this.id<MessageId>("msg");
      await this.append(input, "message.created", {
        messageId: assistantMessageId,
        role: "assistant",
        turnId,
      });

      let modelInput: ModelStreamInput = {
        sessionId: input.sessionId,
        threadId: input.threadId,
        turnId,
        messages: context.messages,
        tools: visibleTools,
        system: input.system ?? [],
      };
      if (input.developer && input.developer.length > 0) modelInput.developer = input.developer;
      if (input.contextualUser && input.contextualUser.length > 0) modelInput.contextualUser = input.contextualUser;
      if (input.promptDebug) modelInput.promptDebug = input.promptDebug;
      if (input.modelSelection) modelInput.modelSelection = input.modelSelection;
      if (input.reasoningLevel !== undefined) modelInput.reasoningLevel = input.reasoningLevel;
      if (input.serviceTier !== undefined) modelInput.serviceTier = input.serviceTier;
      if (input.signal) modelInput.signal = input.signal;

      const guard = new DoomLoopGuard(this.options.doomLoopGuard);
      let streamResult: AssistantStreamResult;
      try {
        streamResult = await this.consumeModelStream(input, turnId, assistantMessageId, modelInput, guard);
      } catch (error) {
        const err = toError(error);
        if (!this.canRecoverWithCompaction(err)) throw err;
        turnUsage = addModelUsage(turnUsage, takeModelUsage(err));
        const recoveryMessages = await messagesForContext(this.options.store, input.sessionId);
        const recoveryBoundary = this.contextBuilder().compactionBoundary(recoveryMessages, "recovery");
        if (!recoveryBoundary) throw err;
        await this.append(input, "turn.compaction_requested", {
          turnId,
          reason: "recovery",
          boundaryMessageId: recoveryBoundary.boundaryMessageId,
          estimatedChars: recoveryBoundary.estimatedChars,
          budgetChars: recoveryBoundary.budgetChars,
        });
        const recovered = await this.tryCompactMessages(input, turnId, recoveryMessages, recoveryBoundary);
        turnUsage = addModelUsage(turnUsage, recovered.usage);
        if (!recovered.completed) throw err;
        const recoveredContext = this.contextBuilder().build(
          await messagesForContext(this.options.store, input.sessionId),
          contextSurface,
        );
        if (recoveredContext.overflow) throw new ContextWindowExceededError(recoveredContext.overflow);
        contextUsage = recoveredContext.usage;
        modelInput = {
          ...modelInput,
          messages: recoveredContext.messages,
        };
        streamResult = await this.consumeModelStream(input, turnId, assistantMessageId, modelInput, guard);
      }
      turnUsage = addModelUsage(turnUsage, streamResult.usage);
      let finishReason = streamResult.finishReason;
      if (isOutputLimitFinishReason(streamResult.finishReason) && streamResult.toolCalls.length > 0) {
        await this.failOutputLimitedToolCalls(
          input,
          turnId,
          assistantMessageId,
          streamResult.toolCalls,
          streamResult.finishReason,
        );
        finishReason = "tool_use";
      } else {
        await this.executeToolCalls(input, turnId, assistantMessageId, streamResult.toolCalls);
      }

      await this.append(input, "turn.completed", {
        turnId,
        status: "completed",
      });

      const result: Extract<RunTurnResult, { status: "completed" }> = {
        status: "completed",
        turnId,
        assistantMessageId,
      };
      if (contextUsage) result.contextUsage = contextUsage;
      if (turnUsage) result.usage = turnUsage;
      if (finishReason) result.finishReason = finishReason;
      return result;
    } catch (error) {
      const err = toError(error);
      turnUsage = addModelUsage(turnUsage, takeModelUsage(err));
      const status = isAbortError(err) ? "cancelled" : "failed";
      if (status === "failed" && assistantMessageId && !didAssistantMutate(err)) {
        await this.appendModelFailureMessage(input, assistantMessageId, err);
      }
      await this.append(input, "turn.completed", {
        turnId,
        status,
      });
      const result: Extract<RunTurnResult, { status: "failed" | "cancelled" }> = {
        status,
        turnId,
        error: err,
      };
      if (assistantMessageId) result.assistantMessageId = assistantMessageId;
      if (contextUsage) result.contextUsage = contextUsage;
      if (turnUsage) result.usage = turnUsage;
      return result;
    }
  }

  private async appendModelFailureMessage(
    input: RunTurnInput,
    assistantMessageId: MessageId,
    error: Error,
  ): Promise<void> {
    await this.appendPart(input, assistantMessageId, {
      id: this.id<PartId>("part"),
      messageId: assistantMessageId,
      sessionId: input.sessionId,
      type: "text",
      text: `Model request failed: ${error.message}`,
    });
  }

  private async visibleTools(input: RunTurnInput, turnId: TurnId) {
    if (input.toolMode === "disabled") return [];
    const resolvedPolicy = await this.options.toolPolicyResolver?.resolve({
      sessionId: input.sessionId,
      threadId: input.threadId,
      turnId,
      cwd: input.cwd,
    });
    let tools = filterToolsByPolicies(this.options.toolRegistry.list(), input.toolPolicy, resolvedPolicy);
    if (input.preferExternalImageTools && tools.some(isExternalImageUnderstandingTool)) {
      tools = tools.filter((tool) => !isDirectImageBlockTool(tool));
      return tools;
    }
    if (!input.suppressExternalImageTools) return tools;
    return tools.filter((tool) => !isExternalImageUnderstandingTool(tool));
  }

  private async consumeModelStream(
    input: RunTurnInput,
    turnId: TurnId,
    assistantMessageId: MessageId,
    modelInput: ModelStreamInput,
    guard: DoomLoopGuard,
  ): Promise<AssistantStreamResult> {
    const retryPolicy = normalizeRetryPolicy(this.options.retryPolicy);
    let attempt = 1;
    let previousAttemptUsage: ModelUsage | undefined;

    while (true) {
      let assistantMutated = false;
      let latestUsage: ModelUsage | undefined;
      const state: AssistantStreamState = {
        toolCalls: [],
        streamingToolCalls: new Map(),
      };
      try {
        for await (const event of this.options.model.stream(modelInput)) {
          if (input.signal?.aborted) throw abortError("Turn aborted");
          if (event.type === "text_delta") {
            assistantMutated = true;
            await this.appendTextDelta(input, assistantMessageId, state, event.text);
            continue;
          }

          if (event.type === "reasoning_delta") {
            assistantMutated = true;
            await this.appendReasoningDelta(input, assistantMessageId, state, event.text, event.redacted);
            continue;
          }

          if (event.type === "tool_call") {
            assistantMutated = true;
            await this.queueToolCall(
              input,
              turnId,
              assistantMessageId,
              {
                callId: this.id<ToolCallId>("toolcall"),
                toolName: event.name,
                input: event.input,
                ...(event.inputParseError ? { inputParseError: event.inputParseError } : {}),
              },
              guard,
              state,
            );
            continue;
          }

          if (event.type === "tool_call_start") {
            assistantMutated = true;
            const toolCall: StreamingToolCall = {
              callId: event.toolCallId as ToolCallId,
              toolName: event.name,
              input: {},
            };
            state.streamingToolCalls.set(toolCallKey(event.toolCallId, event.index), toolCall);
            await this.updateStreamingToolCall(input, toolCall);
            continue;
          }

          if (event.type === "tool_call_delta") {
            const key = toolCallKey(event.toolCallId, event.index);
            let toolCall = state.streamingToolCalls.get(key);
            if (!toolCall && event.name) {
              assistantMutated = true;
              toolCall = {
                callId: event.toolCallId as ToolCallId,
                toolName: event.name,
                input: {},
              };
              state.streamingToolCalls.set(key, toolCall);
              await this.updateStreamingToolCall(input, toolCall);
            }
            if (toolCall && event.partialInput !== undefined) {
              assistantMutated = true;
              if (event.name) toolCall.toolName = event.name;
              toolCall.input = event.partialInput;
              await this.updateStreamingToolCall(input, toolCall);
            }
            continue;
          }

          if (event.type === "tool_call_end") {
            assistantMutated = true;
            const key = toolCallKey(event.toolCallId, event.index);
            const existing = state.streamingToolCalls.get(key);
            state.streamingToolCalls.delete(key);
            const toolCall = {
              callId: (existing?.callId ?? event.toolCallId) as ToolCallId,
              toolName: event.name || existing?.toolName || "",
              input: event.input,
              ...(event.inputParseError ? { inputParseError: event.inputParseError } : {}),
            };
            await this.updateStreamingToolCall(input, toolCall);
            await this.queueToolCall(
              input,
              turnId,
              assistantMessageId,
              toolCall,
              guard,
              state,
            );
            continue;
          }

          if (event.type === "finish") {
            if (event.usage) latestUsage = event.usage;
            if (event.responseId || event.usage) {
              await this.appendModelMetadata(input, turnId, event);
            }
            await this.finishUnfinishedStreamingToolCalls(input, state, "failed", "Tool call stream ended before tool_call_end");
            const usage = addModelUsage(previousAttemptUsage, latestUsage);
            return { finishReason: event.reason, toolCalls: state.toolCalls, ...(usage ? { usage } : {}) };
          }

          if (event.type === "metadata") {
            if (event.usage) latestUsage = event.usage;
            await this.appendModelMetadata(input, turnId, event);
            continue;
          }

          if (event.usage) latestUsage = event.usage;
          if (event.responseId || event.usage) {
            await this.appendModelMetadata(input, turnId, event);
          }
          throw toError(event.error);
        }
        await this.finishUnfinishedStreamingToolCalls(input, state, "failed", "Tool call stream ended before tool_call_end");
        const usage = addModelUsage(previousAttemptUsage, latestUsage);
        return { toolCalls: state.toolCalls, ...(usage ? { usage } : {}) };
      } catch (error) {
        const err = toError(error);
        previousAttemptUsage = addModelUsage(
          previousAttemptUsage,
          addModelUsage(latestUsage, takeModelUsage(err)),
        );
        if (input.signal?.aborted || isAbortError(err)) {
          await this.finishUnfinishedStreamingToolCalls(input, state, "cancelled", err.message);
          throw attachModelUsage(err, previousAttemptUsage);
        }
        await this.finishUnfinishedStreamingToolCalls(input, state, "failed", err.message);
        if (!assistantMutated && attempt < retryPolicy.maxAttempts && retryPolicy.retryable(err)) {
          const delayMs = retryDelay(retryPolicy, attempt);
          await this.append(input, "turn.retry_scheduled", {
            turnId,
            attempt: attempt + 1,
            delayMs,
            reason: err.message,
          });
          await sleep(delayMs);
          attempt++;
          continue;
        }
        markAssistantMutation(err, assistantMutated);
        throw attachModelUsage(err, previousAttemptUsage);
      }
    }
  }

  private canRecoverWithCompaction(error: Error): boolean {
    if (didAssistantMutate(error)) return false;
    if (isAbortError(error)) return false;
    return isContextLimitError(error);
  }

  private async tryCompactMessages(
    input: RunTurnInput,
    turnId: TurnId,
    messages: readonly Message[],
    boundary: CompactionBoundary,
  ): Promise<CompactionAttemptResult> {
    try {
      const result = await this.compactMessages(input, turnId, messages, boundary);
      return { completed: true, ...(result.usage ? { usage: result.usage } : {}) };
    } catch (error) {
      const err = toError(error);
      const usage = takeModelUsage(err);
      await this.append(input, "turn.compaction_failed", {
        turnId,
        reason: boundary.reason,
        boundaryMessageId: boundary.boundaryMessageId,
        error: err.message,
      });
      return { completed: false, ...(usage ? { usage } : {}) };
    }
  }

  private async compactMessages(
    input: CompactContextInput,
    turnId: TurnId,
    messages: readonly Message[],
    boundary: CompactionBoundary,
  ): Promise<{ messageId: MessageId; boundaryMessageId: MessageId; summaryChars: number; usage?: ModelUsage }> {
    await this.append(input, "turn.compaction_started", {
      turnId,
      reason: boundary.reason,
      boundaryMessageId: boundary.boundaryMessageId,
      estimatedChars: boundary.estimatedChars,
      budgetChars: boundary.budgetChars,
    });
    const compactInput: {
      sessionId: SessionId;
      threadId: ThreadId;
      turnId: TurnId;
      messages: readonly Message[];
      boundary: CompactionBoundary;
      instructions?: string;
      modelSelection?: ModelSelection;
      reasoningLevel?: ReasoningLevel;
      serviceTier?: ServiceTier;
      signal?: AbortSignal;
    } = {
      sessionId: input.sessionId,
      threadId: input.threadId,
      turnId,
      messages,
      boundary,
    };
    if (input.instructions !== undefined) compactInput.instructions = input.instructions;
    if (input.modelSelection !== undefined) compactInput.modelSelection = input.modelSelection;
    if (input.reasoningLevel !== undefined) compactInput.reasoningLevel = input.reasoningLevel;
    if (input.serviceTier !== undefined) compactInput.serviceTier = input.serviceTier;
    if (input.signal !== undefined) compactInput.signal = input.signal;
    const result = await this.compactor().compact(compactInput);
    const messageId = await this.appendCompactionMessage(input, turnId, result);
    await this.append(input, "turn.compaction_completed", {
      turnId,
      messageId,
      boundaryMessageId: result.boundary.boundaryMessageId,
      summaryChars: result.summary.length,
      sourceMessageCount: result.sourceMessageCount,
      estimatedCharsBefore: result.estimatedCharsBefore,
      estimatedCharsAfter: result.estimatedCharsAfter,
    });
    return {
      messageId,
      boundaryMessageId: result.boundary.boundaryMessageId,
      summaryChars: result.summary.length,
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }

  private async appendCompactionMessage(input: EventContext, turnId: TurnId, result: ContextCompactionResult): Promise<MessageId> {
    const messageId = this.id<MessageId>("msg");
    await this.append(input, "message.created", {
      messageId,
      role: "user",
      turnId,
    });

    const summaryText = renderContextSummary(result);
    await this.appendPart(input, messageId, {
      id: this.id<PartId>("part"),
      messageId,
      sessionId: input.sessionId,
      type: "text",
      text: summaryText,
      synthetic: true,
    });
    await this.appendPart(input, messageId, {
      id: this.id<PartId>("part"),
      messageId,
      sessionId: input.sessionId,
      type: "compaction",
      boundaryMessageId: result.boundary.boundaryMessageId,
      reason: result.boundary.reason,
      summary: result.summary,
      sourceMessageIds: result.sourceMessageIds,
      estimatedCharsBefore: result.estimatedCharsBefore,
      estimatedCharsAfter: result.estimatedCharsAfter,
    });
    return messageId;
  }

  private async appendTextDelta(
    input: RunTurnInput,
    assistantMessageId: MessageId,
    state: AssistantStreamState,
    text: string,
  ): Promise<void> {
    if (!state.textPartId) {
      state.textPartId = this.id<PartId>("part");
      await this.appendPart(input, assistantMessageId, {
        id: state.textPartId,
        messageId: assistantMessageId,
        sessionId: input.sessionId,
        type: "text",
        text,
      });
      return;
    }

    await this.appendPartDelta(input, assistantMessageId, state.textPartId, "text", text);
  }

  private async appendReasoningDelta(
    input: RunTurnInput,
    assistantMessageId: MessageId,
    state: AssistantStreamState,
    text: string,
    redacted?: boolean,
  ): Promise<void> {
    if (!state.reasoningPartId) {
      state.reasoningPartId = this.id<PartId>("part");
      await this.appendPart(input, assistantMessageId, {
        id: state.reasoningPartId,
        messageId: assistantMessageId,
        sessionId: input.sessionId,
        type: "reasoning",
        text,
        ...(redacted ? { redacted } : {}),
      });
      return;
    }

    await this.appendPartDelta(input, assistantMessageId, state.reasoningPartId, "text", text);
  }

  private async queueToolCall(
    input: RunTurnInput,
    turnId: TurnId,
    assistantMessageId: MessageId,
    toolCall: PendingToolCall,
    guard: DoomLoopGuard,
    state: AssistantStreamState,
  ): Promise<void> {
    await this.appendPart(input, assistantMessageId, {
      id: this.id<PartId>("part"),
      messageId: assistantMessageId,
      sessionId: input.sessionId,
      type: "tool_call",
      callId: toolCall.callId,
      toolName: toolCall.toolName,
      input: toolCall.input,
      status: "pending",
    });

    const guardResult = guard.check({ toolName: toolCall.toolName, input: toolCall.input });
    if (!guardResult.ok) {
      const error = new DoomLoopError(
        guardResult.reason === "repeated_tool_call"
          ? `Repeated tool call blocked: ${toolCall.toolName}`
          : `Tool call limit exceeded: ${guardResult.total}`,
      );
      await this.append(input, "turn.guard_triggered", {
        turnId,
        reason: guardResult.reason,
        toolName: toolCall.toolName,
        count: guardResult.count,
      });
      await this.append(input, "tool.call_started", {
        turnId,
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        input: toolCall.input,
      });
      await this.append(input, "tool.call_finished", {
        callId: toolCall.callId,
        status: "failed",
        error: error.message,
        synthetic: true,
      });
      await this.appendPart(input, assistantMessageId, {
        id: this.id<PartId>("part"),
        messageId: assistantMessageId,
        sessionId: input.sessionId,
        type: "tool_result",
        callId: toolCall.callId,
        output: "",
        error: error.message,
        synthetic: true,
      });
      throw error;
    }

    state.toolCalls.push(toolCall);
  }

  private async updateStreamingToolCall(input: EventContext, toolCall: StreamingToolCall): Promise<void> {
    await this.append(input, "tool.call_updated", {
      callId: toolCall.callId,
      status: "running",
      toolName: toolCall.toolName,
      input: toolCall.input,
    });
  }

  private async finishUnfinishedStreamingToolCalls(
    input: EventContext,
    state: AssistantStreamState,
    status: "failed" | "cancelled",
    error: string,
  ): Promise<void> {
    const unfinished = [...state.streamingToolCalls.values()];
    state.streamingToolCalls.clear();
    const seen = new Set<ToolCallId>();
    for (const toolCall of unfinished) {
      if (seen.has(toolCall.callId)) continue;
      seen.add(toolCall.callId);
      await this.append(input, "tool.call_finished", {
        callId: toolCall.callId,
        status,
        error,
        synthetic: true,
      });
    }
  }

  private async executeToolCalls(
    input: RunTurnInput,
    turnId: TurnId,
    assistantMessageId: MessageId,
    toolCalls: readonly PendingToolCall[],
  ): Promise<void> {
    const concurrentLimit = this.options.maxConcurrentToolCalls ?? 10;
    let batch: PendingToolCall[] = [];

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const current = batch;
      batch = [];
      const results = await Promise.all(
        current.map((toolCall) => this.runToolCall(input, turnId, assistantMessageId, toolCall)),
      );
      let cancelled: Error | undefined;
      for (const result of results) {
        await this.appendPart(input, assistantMessageId, result.part);
        if (result.cancelledError && !cancelled) cancelled = result.cancelledError;
      }
      if (cancelled) throw cancelled;
    };

    for (const toolCall of toolCalls) {
      if (input.signal?.aborted) throw abortError("Turn aborted");
      if (input.toolMode === "disabled") {
        await flush();
        const part = await this.failToolCallWithoutExecution(
          input,
          turnId,
          assistantMessageId,
          toolCall,
          "Tool use is disabled for this turn.",
        );
        await this.appendPart(input, assistantMessageId, part);
        continue;
      }
      if (toolCall.inputParseError) {
        await flush();
        const part = await this.failToolCallWithoutExecution(
          input,
          turnId,
          assistantMessageId,
          toolCall,
          toolCall.inputParseError,
        );
        await this.appendPart(input, assistantMessageId, part);
        continue;
      }
      const safe = await this.options.toolExecutor.canRunConcurrently(toolCall.toolName, toolCall.input);
      if (safe) {
        batch.push(toolCall);
        if (batch.length >= concurrentLimit) await flush();
        continue;
      }

      await flush();
      const result = await this.runToolCall(input, turnId, assistantMessageId, toolCall);
      await this.appendPart(input, assistantMessageId, result.part);
      if (result.cancelledError) throw result.cancelledError;
    }

    await flush();
  }

  private async failToolCallWithoutExecution(
    input: EventContext,
    turnId: TurnId,
    assistantMessageId: MessageId,
    toolCall: PendingToolCall,
    error: string,
  ): Promise<MessagePart> {
    await this.append(input, "tool.call_started", {
      turnId,
      callId: toolCall.callId,
      toolName: toolCall.toolName,
      input: toolCall.input,
    });
    await this.append(input, "tool.call_finished", {
      callId: toolCall.callId,
      status: "failed",
      error,
      synthetic: true,
    });
    return {
      id: this.id<PartId>("part"),
      messageId: assistantMessageId,
      sessionId: input.sessionId,
      type: "tool_result",
      callId: toolCall.callId,
      output: "",
      error,
      synthetic: true,
    };
  }

  private async failOutputLimitedToolCalls(
    input: EventContext,
    turnId: TurnId,
    assistantMessageId: MessageId,
    toolCalls: readonly PendingToolCall[],
    finishReason: string | undefined,
  ): Promise<void> {
    const reason = finishReason ?? "unknown";
    const error = `Model response hit output token limit (finish reason: ${reason}); tool arguments may be truncated. Re-issue the complete tool call.`;
    for (const toolCall of toolCalls) {
      const part = await this.failToolCallWithoutExecution(
        input,
        turnId,
        assistantMessageId,
        toolCall,
        error,
      );
      await this.appendPart(input, assistantMessageId, part);
    }
  }

  private async runToolCall(
    input: RunTurnInput,
    turnId: TurnId,
    assistantMessageId: MessageId,
    toolCall: PendingToolCall,
  ): Promise<{ part: MessagePart; cancelledError?: Error }> {
    const executeInput = {
      sessionId: input.sessionId,
      threadId: input.threadId,
      turnId,
      callId: toolCall.callId,
      toolName: toolCall.toolName,
      input: toolCall.input,
      cwd: input.cwd,
    };
    if (input.toolPolicy) {
      Object.assign(executeInput, { policy: input.toolPolicy });
    }
    if (input.signal) {
      Object.assign(executeInput, { signal: input.signal });
    }

    const result = await this.options.toolExecutor.execute(executeInput);

    if (result.status === "completed") {
      const part: MessagePart = {
        id: this.id<PartId>("part"),
        messageId: assistantMessageId,
        sessionId: input.sessionId,
        type: "tool_result",
        callId: toolCall.callId,
        output: result.result.output,
      };
      if (result.result.content) {
        part.content = result.result.content;
      }
      if (result.result.artifactIds) {
        part.artifactIds = result.result.artifactIds;
      }
      return { part };
    }

    const part: MessagePart = {
      id: this.id<PartId>("part"),
      messageId: assistantMessageId,
      sessionId: input.sessionId,
      type: "tool_result",
      callId: toolCall.callId,
      output: "",
      error: result.error.message,
      synthetic: true,
    };
    if (result.status === "cancelled") {
      return { part, cancelledError: result.error };
    }
    return { part };
  }

  private async appendPart(input: EventContext, messageId: MessageId, part: MessagePart): Promise<void> {
    await this.append(input, "message.part_added", {
      messageId,
      part,
    });
  }

  private async appendPartDelta(
    input: EventContext,
    messageId: MessageId,
    partId: PartId,
    field: string,
    delta: string,
  ): Promise<void> {
    await this.append(input, "message.part_delta", {
      messageId,
      partId,
      field,
      delta,
    });
  }

  private async appendModelMetadata(
    input: EventContext,
    turnId: TurnId,
    metadata: Extract<ModelStreamEvent, { type: "metadata" | "finish" | "error" }>,
  ): Promise<void> {
    await this.append(input, "turn.model_metadata", {
      turnId,
      ...(isModelMetadataEvent(metadata) && metadata.provider ? { provider: metadata.provider } : {}),
      ...(isModelMetadataEvent(metadata) && metadata.model ? { model: metadata.model } : {}),
      ...(metadata.responseId ? { responseId: metadata.responseId } : {}),
      ...(metadata.usage ? { usage: metadata.usage } : {}),
      ...(isModelMetadataEvent(metadata) && metadata.contextWindowTokens !== undefined ? { contextWindowTokens: metadata.contextWindowTokens } : {}),
      ...(isModelMetadataEvent(metadata) && metadata.maxOutputTokens !== undefined ? { maxOutputTokens: metadata.maxOutputTokens } : {}),
    });
  }

  private async append<TType extends ChiliEvent["type"], TPayload>(
    input: EventContext,
    type: TType,
    payload: TPayload,
  ): Promise<void> {
    const event: EventEnvelope<TType, TPayload> = {
      id: this.id("event"),
      type,
      time: this.now(),
      sessionId: input.sessionId,
      payload,
    };
    if (input.threadId) event.threadId = input.threadId;
    await this.options.store.append(event as ChiliEvent);
  }

  private id<T extends string>(prefix: string): T {
    const create = this.options.createId ?? defaultCreateId;
    return create(prefix) as T;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }

  private contextBuilder(): ContextWindowBuilder {
    return this.options.contextBuilder ?? new ContextWindowBuilder(this.options.contextBudget);
  }

  private compactor(): ContextCompactionService {
    return (
      this.options.contextCompactor ??
      new ContextCompactionService({
        model: this.options.model,
        now: () => this.now(),
        ...this.options.contextCompaction,
      })
    );
  }
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

interface AssistantMutationError extends Error {
  assistantMutated?: boolean;
}

function markAssistantMutation(error: Error, assistantMutated: boolean): void {
  (error as AssistantMutationError).assistantMutated = assistantMutated;
}

function didAssistantMutate(error: Error): boolean {
  return (error as AssistantMutationError).assistantMutated === true;
}

function isContextLimitError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("context window") ||
    message.includes("context length") ||
    message.includes("maximum context") ||
    message.includes("prompt is too long") ||
    message.includes("input is too long") ||
    message.includes("too many tokens") ||
    message.includes("request too large") ||
    message.includes("http 413") ||
    /\b413\b/.test(message)
  );
}

function isExternalImageUnderstandingTool(tool: { name: string; description: string; mcp?: unknown }): boolean {
  if (!isMcpTool(tool)) return false;
  const rawToolName = typeof tool.mcp.rawToolName === "string" ? tool.mcp.rawToolName : "";
  const toolName = typeof tool.mcp.toolName === "string" ? tool.mcp.toolName : "";
  const haystack = `${tool.name} ${rawToolName} ${toolName} ${tool.description}`.toLowerCase();
  if (!/(?:image|vision|vlm|ocr|screenshot)/.test(haystack)) return false;
  return /(?:understand|analy[sz]e|describe|extract|read|ocr|vision|vlm)/.test(haystack);
}

function isDirectImageBlockTool(tool: {
  name: string;
  aliases?: readonly string[];
  description?: string;
  searchHint?: string;
  mcp?: unknown;
}): boolean {
  if (isMcpTool(tool)) return false;
  const names = [tool.name, ...(tool.aliases ?? [])].map((name) => name.toLowerCase());
  if (names.some((name) => name === "read_image" || name === "view_image" || name === "image_read")) return true;
  const haystack = `${tool.name} ${tool.description ?? ""} ${tool.searchHint ?? ""}`.toLowerCase();
  return /(?:image block|image content)/.test(haystack) && /(?:read|view|inspect)/.test(haystack);
}

function isMcpTool(tool: { mcp?: unknown }): tool is { mcp: Record<string, unknown> } {
  return typeof tool.mcp === "object" && tool.mcp !== null;
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function toolCallKey(toolCallId: string, index: number | undefined): string {
  return `${toolCallId}:${index ?? ""}`;
}

function isOutputLimitFinishReason(reason: string | undefined): boolean {
  if (!reason) return false;
  const normalized = reason.toLowerCase();
  return normalized === "length" || normalized === "max_tokens" || normalized === "max_output_tokens";
}

function isModelMetadataEvent(
  event: Extract<ModelStreamEvent, { type: "metadata" | "finish" | "error" }>,
): event is Extract<ModelStreamEvent, { type: "metadata" }> {
  return "type" in event && event.type === "metadata";
}

function filterToolsByPolicies(
  tools: readonly ChiliToolDefinition[],
  ...policies: readonly (ToolAccessPolicy | undefined)[]
): ChiliToolDefinition[] {
  return policies.reduce(
    (current, policy) => filterToolsByPolicy(current, policy),
    [...tools],
  );
}

function renderContextSummary(result: ContextCompactionResult): string {
  return [
    `<context_summary boundary_message_id="${result.boundary.boundaryMessageId}" reason="${result.boundary.reason}">`,
    stripContextSummary(result.summary),
    "</context_summary>",
  ].join("\n");
}

function stripContextSummary(summary: string): string {
  const match = /<context_summary\b[^>]*>([\s\S]*?)<\/context_summary>/i.exec(summary.trim());
  return (match?.[1] ?? summary).trim();
}
