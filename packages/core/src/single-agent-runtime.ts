import type {
  AssistantMessagePhase,
  RuntimeEvent,
  EventEnvelope,
  ExecutionIdentity,
  Message,
  MessageId,
  MessagePart,
  TextPart,
  ReasoningPart,
  ModelSelection,
  ModelUsage,
  PreparedModelRequest,
  RuntimeModelDescriptor,
  ReasoningLevel,
  ServiceTier,
  PartId,
  SessionId,
  TimestampMs,
  ToolCallId,
  ToolResultExecutionContext,
  TurnId,
} from "@chili/protocol";
import {
  boundPersistedErrorMessage,
  boundPersistedJsonValue,
  normalizePersistedError,
  normalizeToolCallId,
  PERSISTED_JSON_LIMITS,
  timestampNow,
} from "@chili/protocol";
import type { EventStore } from "@chili/store";
import type { ChiliToolDefinition, ExecuteToolInput, PreparedToolCall, ToolAccessPolicy, ToolAccessPolicyResolver, ToolRegistry } from "@chili/tools";
import { ToolDispatchScope, ToolExecutor, ToolValidationError, UnknownToolError, filterToolsByPolicy } from "@chili/tools";
import {
  ContextCompactionService,
  ContextWindowExceededError,
  ContextWindowBuilder,
  compactedMessageView,
  type CompactionBoundary,
  type CompactionRequestSource,
  type ContextBuildResult,
  type ContextBudgetOptions,
  type ContextCompactionOptions,
  type ContextCompactionResult,
  type ContextRequestSurface,
  type ContextUsage,
  prepareModelRequest,
} from "./context/index.js";
import { messagesForContext } from "./cancelled-turn-context.js";
import { DoomLoopError, DoomLoopGuard, type DoomLoopGuardOptions } from "./doom-loop-guard.js";
import { addModelUsage, attachModelUsage, takeModelUsage } from "./model-usage.js";
import {
  isRetryableTransientError,
  normalizeRetryPolicy,
  retryAfterDelayHint,
  retryDelay,
  sleep,
  type RetryPolicy,
} from "./retry.js";
import type { ModelRouter, ModelStreamEvent, ModelStreamInput } from "./runtime.js";
import type { AgentRunner, AppendUserMessageInput, CreateSessionInput, PromptExecutionScope, RunTurnInput, RunTurnResult } from "./runner.js";

export type { AppendUserMessageInput, CreateSessionInput, RunTurnInput, RunTurnResult } from "./runner.js";

export interface SingleAgentRuntimeOptions {
  store: EventStore;
  model: ModelRouter;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  toolPolicyResolver?: ToolAccessPolicyResolver;
  /** Model definitions only; discovery and nested execution retain the authorized catalog. */
  toolExposure?: {
    eagerTools: readonly string[];
    requiredTools?: (context: { sessionId: SessionId; cwd: string }) => Promise<readonly string[]>;
  };
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
}

interface PendingToolCall {
  ordinal?: number;
  callId: ToolCallId;
  providerCallId?: string;
  toolName: string;
  input: unknown;
  inputParseError?: string;
  prepared?: PreparedToolCall;
}

interface StreamingToolCall {
  ordinal: number;
  callId: ToolCallId;
  providerCallId?: string;
  toolName: string;
  input: unknown;
}

type AssistantContentPart = TextPart | ReasoningPart;
type ContentCompletion = "completed" | "cancelled" | "failed";

interface AssistantStreamState {
  textParts: Map<number, TextPart>;
  reasoningParts: Map<number, ReasoningPart>;
  /** In first-observed order across text and reasoning blocks. Never persisted as a draft. */
  pendingContent: Map<PartId, AssistantContentPart>;
  toolCalls: PendingToolCall[];
  streamingToolCalls: Map<string, StreamingToolCall>;
}

interface AssistantStreamResult {
  finishReason: string;
  toolCalls: PendingToolCall[];
  usage?: ModelUsage;
}

interface CompactionAttemptResult {
  completed: boolean;
  usage?: ModelUsage;
}

interface TurnToolDispatch {
  scope: ToolDispatchScope;
  guardError?: DoomLoopError;
}

const MAX_MODEL_METADATA_TEXT_BYTES = 4_096;
const MAX_MODEL_RESPONSE_ID_CHARS = 512;

export interface CompactContextInput {
  sessionId: SessionId;
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
  private readonly promptGuards = new WeakMap<PromptExecutionScope, DoomLoopGuard>();
  /** Exists only while its assistant turn is running; includes tool results in the same order. */
  private readonly assistantPartOrdinals = new Map<MessageId, number>();

  constructor(private readonly options: SingleAgentRuntimeOptions) {}

  listModels(): Promise<readonly RuntimeModelDescriptor[]> | readonly RuntimeModelDescriptor[] {
    return this.options.model.listModels?.() ?? [];
  }

  async createSession(input: CreateSessionInput): Promise<SessionId> {
    const sessionId = input.sessionId ?? this.id<SessionId>("session");
    await this.append(
      { sessionId },
      "session.created",
      { sessionId, cwd: input.cwd, ...(input.identity ? { identity: input.identity } : {}) },
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
        throwIfTurnAborted(input.signal);
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
      const limits = await this.options.model.resolveRequestLimits?.({
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.reasoningLevel !== undefined ? { reasoningLevel: input.reasoningLevel } : {}),
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      });
      const result = await this.compactMessages(input, turnId, rawMessages, boundary, {
        ...limits,
        tools: await this.options.toolRegistry.list(),
      }, true);
      usage = addModelUsage(usage, result.usage);
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
      const aborted = input.signal?.aborted === true || isAbortError(err);
      const persistedError = terminalPersistedError(err, aborted);
      const status = aborted ? "cancelled" : "failed";
      await this.append(input, "turn.compaction_failed", {
        turnId,
        reason,
        ...(boundary ? { boundaryMessageId: boundary.boundaryMessageId } : {}),
        error: persistedError.message,
      });
      await this.append(input, "turn.completed", { turnId, status, reason: persistedError.message });
      const failed: Extract<CompactContextResult, { status: "failed" | "cancelled" }> = {
        status,
        turnId,
        error: persistedError,
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
    const pendingToolCalls = new Set<PendingToolCall>();

    try {
      await this.append(input, "turn.started", { turnId });
      const guard = this.guardForTurn(input);
      const dispatch: TurnToolDispatch = {
        scope: new ToolDispatchScope({
          maxConcurrentCalls: this.options.maxConcurrentToolCalls ?? 10,
          beforeCall: async (request) => {
            if (dispatch.guardError) throw dispatch.guardError;
            const result = guard.check(request);
            if (result.ok) return;
            const error = new DoomLoopError(
              result.reason === "repeated_tool_call"
                ? `Repeated tool call blocked: ${request.toolName}`
                : `Tool call limit exceeded: ${result.total}`,
            );
            dispatch.guardError ??= error;
            await this.append(input, "turn.guard_triggered", {
              turnId,
              reason: result.reason,
              toolName: boundedToolName(request.toolName),
              count: result.count,
            });
            throw error;
          },
        }),
      };

      const visibleTools = await this.visibleTools(input, turnId);
      const advertisedCatalogRevision = this.options.toolRegistry.getRevision?.();
      const modelTools = await this.modelTools(input, visibleTools);
      const modelToolNames = new Set(modelTools.map((tool) => tool.name));
      const unloadedToolNames = new Set(visibleTools.filter((tool) => !modelToolNames.has(tool.name))
        .flatMap((tool) => [tool.name, ...(tool.aliases ?? [])]));
      const requestLimits = await this.options.model.resolveRequestLimits?.({
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.reasoningLevel !== undefined ? { reasoningLevel: input.reasoningLevel } : {}),
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
      });
      const contextSurface: ContextRequestSurface = {
        ...(input.promptDebug ? { promptDebug: input.promptDebug } : {}),
        ...(requestLimits?.contextWindowTokens !== undefined
          ? { contextWindowTokens: requestLimits.contextWindowTokens }
          : {}),
        ...(requestLimits?.requestMaxOutputTokens !== undefined
          ? { requestMaxOutputTokens: requestLimits.requestMaxOutputTokens }
          : {}),
        system: input.system ?? [],
        developer: input.developer ?? [],
        contextualUser: input.contextualUser ?? [],
        tools: modelTools,
      };
      const rawMessages = await messagesForContext(this.options.store, input.sessionId);
      let contextMessages = rawMessages;
      let context = this.contextBuilder().build(rawMessages, contextSurface);
      contextUsage = context.usage;
      if (context.compactionBoundary) {
        await this.append(input, "turn.compaction_requested", {
          turnId,
          reason: context.compactionBoundary.reason,
          boundaryMessageId: context.compactionBoundary.boundaryMessageId,
          estimatedChars: context.compactionBoundary.estimatedChars,
          budgetChars: context.compactionBoundary.budgetChars,
        });
        const compacted = await this.tryCompactMessages(input, turnId, rawMessages, context.compactionBoundary, contextSurface);
        turnUsage = addModelUsage(turnUsage, compacted.usage);
        if (compacted.completed) {
          const compactedMessages = await messagesForContext(this.options.store, input.sessionId);
          contextMessages = compactedMessages;
          context = this.contextBuilder().build(compactedMessages, contextSurface);
          assertCompleteContext(compactedMessages, context);
          contextUsage = context.usage;
        }
      }
      assertCompleteContext(contextMessages, context);

      assistantMessageId = this.id<MessageId>("msg");
      this.assistantPartOrdinals.set(assistantMessageId, 0);
      await this.append(input, "message.created", {
        messageId: assistantMessageId,
        role: "assistant",
        turnId,
      });

      let modelInput: ModelStreamInput = {
        sessionId: input.sessionId,
        turnId,
        messages: context.messages,
        tools: context.surface.tools,
        system: context.surface.system,
      };
      if (context.surface.developer.length > 0) modelInput.developer = context.surface.developer;
      if (context.surface.contextualUser.length > 0) modelInput.contextualUser = context.surface.contextualUser;
      if (input.promptDebug) modelInput.promptDebug = input.promptDebug;
      if (input.modelSelection) modelInput.modelSelection = input.modelSelection;
      if (input.reasoningLevel !== undefined) modelInput.reasoningLevel = input.reasoningLevel;
      if (input.serviceTier !== undefined) modelInput.serviceTier = input.serviceTier;
      if (input.signal) modelInput.signal = input.signal;

      let request = await this.prepareRequest(modelInput, contextSurface, contextUsage, "turn", advertisedCatalogRevision);
      let streamResult: AssistantStreamResult;
      try {
        streamResult = await this.consumeModelStream(input, turnId, assistantMessageId, modelInput, guard, request);
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
        const recovered = await this.tryCompactMessages(input, turnId, recoveryMessages, recoveryBoundary, contextSurface);
        turnUsage = addModelUsage(turnUsage, recovered.usage);
        if (!recovered.completed) throw err;
        const recoveredMessages = await messagesForContext(this.options.store, input.sessionId);
        const recoveredContext = this.contextBuilder().build(recoveredMessages, contextSurface);
        assertCompleteContext(recoveredMessages, recoveredContext);
        contextUsage = recoveredContext.usage;
        modelInput = {
          ...modelInput,
          messages: recoveredContext.messages,
          tools: recoveredContext.surface.tools,
          system: recoveredContext.surface.system,
          ...(recoveredContext.surface.developer.length > 0
            ? { developer: recoveredContext.surface.developer }
            : {}),
          ...(recoveredContext.surface.contextualUser.length > 0
            ? { contextualUser: recoveredContext.surface.contextualUser }
            : {}),
        };
        request = await this.prepareRequest(modelInput, contextSurface, contextUsage, "turn", advertisedCatalogRevision);
        streamResult = await this.consumeModelStream(input, turnId, assistantMessageId, modelInput, guard, request);
      }
      turnUsage = addModelUsage(turnUsage, streamResult.usage);
      for (const toolCall of streamResult.toolCalls) pendingToolCalls.add(toolCall);
      throwIfTurnAborted(input.signal);
      await this.executeToolCalls(
        input,
        turnId,
        assistantMessageId,
        streamResult.toolCalls,
        pendingToolCalls,
        request.toolCatalogRevision,
        dispatch,
        unloadedToolNames,
        new Set(
          modelTools
            .map((tool) => tool.name)
            .filter((toolName) => !modelInput.tools.some((tool) => tool.name === toolName)),
        ),
      );

      throwIfTurnAborted(input.signal);
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
      result.finishReason = streamResult.finishReason;
      return result;
    } catch (error) {
      const err = toError(error);
      turnUsage = addModelUsage(turnUsage, takeModelUsage(err));
      const aborted = input.signal?.aborted === true || isAbortError(err);
      const persistedError = terminalPersistedError(err, aborted);
      const status = aborted ? "cancelled" : "failed";
      if (assistantMessageId && pendingToolCalls.size > 0) {
        await this.finishPendingToolCalls(
          input, turnId, assistantMessageId, [...pendingToolCalls], status, persistedError,
        );
        pendingToolCalls.clear();
      }
      if (status === "failed" && assistantMessageId && !didAssistantMutate(err)) {
        await this.appendModelFailureMessage(input, assistantMessageId, persistedError);
      }
      await this.append(input, "turn.completed", {
        turnId,
        status,
        reason: persistedError.message,
      });
      const result: Extract<RunTurnResult, { status: "failed" | "cancelled" }> = {
        status,
        turnId,
        error: persistedError,
      };
      if (assistantMessageId) result.assistantMessageId = assistantMessageId;
      if (contextUsage) result.contextUsage = contextUsage;
      if (turnUsage) result.usage = turnUsage;
      return result;
    } finally {
      if (assistantMessageId) this.assistantPartOrdinals.delete(assistantMessageId);
    }
  }

  private guardForTurn(input: RunTurnInput): DoomLoopGuard {
    const scope = input.promptExecution;
    if (!scope) return new DoomLoopGuard(this.options.doomLoopGuard);
    if (scope.sessionId !== input.sessionId) {
      throw new Error("Prompt execution scope belongs to a different session");
    }
    let guard = this.promptGuards.get(scope);
    if (!guard) {
      guard = new DoomLoopGuard(this.options.doomLoopGuard);
      this.promptGuards.set(scope, guard);
    }
    guard.beginTurn();
    return guard;
  }

  private async appendModelFailureMessage(
    input: RunTurnInput,
    assistantMessageId: MessageId,
    error: Error,
  ): Promise<void> {
    const message = normalizePersistedError(error).message;
    await this.appendPart(input, assistantMessageId, {
      id: this.id<PartId>("part"),
      messageId: assistantMessageId,
      sessionId: input.sessionId,
      type: "text",
      text: boundPersistedErrorMessage(`Model request failed: ${message}`).text,
      synthetic: true,
    });
  }

  private async visibleTools(input: RunTurnInput, turnId: TurnId) {
    if (input.toolMode === "disabled") return [];
    const resolvedPolicy = await this.options.toolPolicyResolver?.resolve({
      sessionId: input.sessionId,
      turnId,
      cwd: input.cwd,
    });
    const registeredTools = this.options.toolRegistry.listForContext
      ? await this.options.toolRegistry.listForContext({
        sessionId: input.sessionId,
        turnId,
        cwd: input.cwd,
      })
      : this.options.toolRegistry.list();
    let tools = filterToolsByPolicies(registeredTools, input.toolPolicy, resolvedPolicy);
    if (input.preferExternalImageTools && tools.some(isExternalImageUnderstandingTool)) {
      tools = tools.filter((tool) => !isDirectImageBlockTool(tool));
      return tools;
    }
    if (!input.suppressExternalImageTools) return tools;
    return tools.filter((tool) => !isExternalImageUnderstandingTool(tool));
  }

  private async modelTools(input: RunTurnInput, available: readonly ChiliToolDefinition[]): Promise<ChiliToolDefinition[]> {
    if (available.length === 0) return [];
    // Embedders that provide their own registry may not install a discovery tool.
    // Host opts into an explicit surface; unconfigured runtimes retain their catalog.
    if (!this.options.toolExposure) return [...available];
    const selected = new Set(this.options.toolExposure.eagerTools);
    const events = await this.options.store.events({ sessionId: input.sessionId, type: "session.tools_loaded" });
    for (const event of events) {
      const payload = event.payload as { names?: unknown } | null;
      if (Array.isArray(payload?.names)) {
        for (const name of payload.names) if (typeof name === "string") selected.add(name);
      }
    }
    for (const name of await this.options.toolExposure?.requiredTools?.(input) ?? []) selected.add(name);
    return available.filter((tool) => selected.has(tool.name));
  }

  private async prepareRequest(
    modelInput: ModelStreamInput,
    sourceSurface: ContextRequestSurface,
    usage?: ContextUsage,
    purpose: "turn" | "compaction" = "turn",
    advertisedCatalogRevision?: number,
    compactionSource?: CompactionRequestSource,
  ): Promise<PreparedModelRequest> {
    const sourceMessages = await messagesForContext(this.options.store, modelInput.sessionId);
    const lastEvent = (await this.options.store.events({ sessionId: modelInput.sessionId, tail: true, limit: 1, compactRequests: true }))[0];
    const revision = advertisedCatalogRevision ?? this.options.toolRegistry.getRevision?.();
    const identityEvents = await Promise.all([
      this.options.store.events({ sessionId: modelInput.sessionId, type: "session.identity_bound", tail: true, limit: 1 }),
      this.options.store.events({ sessionId: modelInput.sessionId, type: "session.created", tail: true, limit: 1 }),
    ]);
    const identityEvent = identityEvents[0][0] ?? identityEvents[1][0];
    const identity = (identityEvent?.payload as { identity?: ExecutionIdentity } | undefined)?.identity;
    return prepareModelRequest({
      modelInput, sourceMessages, sourceSurface, purpose,
      ...(compactionSource ? { compactionSource } : {}),
      ...(identity ? { executionIdentity: identity } : {}),
      ...(usage ? { usage } : {}),
      ...(lastEvent ? { sourceEventId: lastEvent.id } : {}),
      ...(revision !== undefined ? { toolCatalogRevision: revision } : {}),
    });
  }

  private async consumeModelStream(
    input: RunTurnInput,
    turnId: TurnId,
    assistantMessageId: MessageId,
    modelInput: ModelStreamInput,
    guard: DoomLoopGuard,
    request: PreparedModelRequest,
  ): Promise<AssistantStreamResult> {
    const retryPolicy = normalizeRetryPolicy(this.options.retryPolicy);
    let attempt = 1;
    let previousAttemptUsage: ModelUsage | undefined;
    const requestId = this.id("request");

    while (true) {
      let assistantMutated = false;
      let latestUsage: ModelUsage | undefined;
      const state: AssistantStreamState = {
        textParts: new Map(),
        reasoningParts: new Map(),
        pendingContent: new Map(),
        toolCalls: [],
        streamingToolCalls: new Map(),
      };
      try {
        throwIfTurnAborted(input.signal);
        await this.append(input, "model.request_prepared", { turnId, requestId, attempt, contentVersion: request.contentVersion, request });
        const executionInput: ModelStreamInput = {
          ...modelInput,
          onRequestIdentity: async (identity) => {
            throwIfTurnAborted(input.signal);
            await this.append(input, "model.request_identity", { turnId, requestId, attempt, identity });
          },
        };
        for await (const event of this.options.model.stream(executionInput)) {
          if (input.signal?.aborted) throw abortError("Turn aborted");
          if (event.type === "text_delta") {
            assistantMutated = true;
            await this.appendTextDelta(input, assistantMessageId, state, event.text, event.index, event.phase);
            continue;
          }

          if (event.type === "reasoning_delta") {
            assistantMutated = true;
            await this.appendReasoningDelta(input, assistantMessageId, state, event.text, event.index, event.redacted);
            continue;
          }

          if (event.type === "text_end") {
            const part = state.textParts.get(event.index ?? 0);
            if (part && event.phase !== undefined && part.phase !== event.phase) {
              throw incompleteModelStreamError("Model text end changed the block phase");
            }
            if (part) await this.commitContentPart(input, assistantMessageId, state, part, "completed");
            continue;
          }

          if (event.type === "reasoning_end") {
            const part = state.reasoningParts.get(event.index ?? 0);
            if (part) await this.commitContentPart(input, assistantMessageId, state, part, "completed");
            continue;
          }

          if (event.type === "reasoning_item") {
            assistantMutated = true;
            await this.appendReasoningItem(input, assistantMessageId, event.output);
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
            if (state.streamingToolCalls.has(toolCallKey(event.toolCallId, event.index))) {
              throw incompleteModelStreamError("Model reused a live tool call stream identifier before completing it");
            }
            const toolCall: StreamingToolCall = {
              ordinal: this.nextAssistantPartOrdinal(assistantMessageId),
              callId: this.id<ToolCallId>("toolcall"),
              providerCallId: normalizeToolCallId(event.toolCallId, event.index),
              toolName: event.name,
              input: {},
            };
            state.streamingToolCalls.set(toolCallKey(event.toolCallId, event.index), toolCall);
            await this.updateStreamingToolCall(input, toolCall);
            continue;
          }

          if (event.type === "tool_call_delta") {
            assistantMutated = true;
            const key = toolCallKey(event.toolCallId, event.index);
            let toolCall = state.streamingToolCalls.get(key);
            if (!toolCall && event.name) {
              assistantMutated = true;
              toolCall = {
                ordinal: this.nextAssistantPartOrdinal(assistantMessageId),
                callId: this.id<ToolCallId>("toolcall"),
                providerCallId: normalizeToolCallId(event.toolCallId, event.index),
                toolName: event.name,
                input: {},
              };
              state.streamingToolCalls.set(key, toolCall);
              await this.updateStreamingToolCall(input, toolCall);
            }
            if (toolCall) {
              if (event.name) toolCall.toolName = event.name;
              // Partial arguments are only for the live attempt. Persist the complete
              // input once tool_call_end arrives, before any tool can execute.
              if (event.partialInput !== undefined) toolCall.input = event.partialInput;
            }
            continue;
          }

          if (event.type === "tool_call_end") {
            assistantMutated = true;
            const key = toolCallKey(event.toolCallId, event.index);
            const existing = state.streamingToolCalls.get(key);
            state.streamingToolCalls.delete(key);
            const toolCall = {
              ordinal: existing?.ordinal ?? this.nextAssistantPartOrdinal(assistantMessageId),
              callId: existing?.callId ?? this.id<ToolCallId>("toolcall"),
              providerCallId: existing?.providerCallId ?? normalizeToolCallId(event.toolCallId, event.index),
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
            if (event.usage) latestUsage = persistedModelUsage(event.usage);
            if (event.responseId || event.usage) {
              await this.appendModelMetadata(input, turnId, event);
            }
            throwIfTurnAborted(input.signal);
            if (typeof event.reason !== "string" || !event.reason.trim()) {
              throw incompleteModelStreamError("Model finish event did not include a finish reason");
            }
            const finishReason = normalizePersistedError(event.reason).message.trim();
            if (finishReason.toLowerCase() === "content_filter") {
              throw incompleteModelStreamError("Model response was interrupted by content filtering; tool calls were not executed.");
            }
            if (isOutputLimitFinishReason(finishReason)) {
              throw Object.assign(
                new Error(`Model response hit output token limit (finish reason: ${finishReason}); response is incomplete and tool calls were not executed.`),
                { name: "ModelOutputLimitError", retryable: false },
              );
            }
            if (state.streamingToolCalls.size > 0) {
              throw incompleteModelStreamError("Tool call stream ended before tool_call_end");
            }
            await this.commitPendingContent(input, assistantMessageId, state, "completed");
            const usage = addModelUsage(previousAttemptUsage, latestUsage);
            return {
              finishReason,
              toolCalls: state.toolCalls,
              ...(usage ? { usage } : {}),
            };
          }

          if (event.type === "metadata") {
            if (event.usage) latestUsage = persistedModelUsage(event.usage);
            await this.appendModelMetadata(input, turnId, event);
            continue;
          }

          if (event.usage) latestUsage = persistedModelUsage(event.usage);
          if (event.responseId || event.usage) {
            await this.appendModelMetadata(input, turnId, event);
          }
          throw toError(event.error);
        }
        throwIfTurnAborted(input.signal);
        throw incompleteModelStreamError("Model stream ended before an explicit finish event");
      } catch (error) {
        const err = toError(error);
        const persistedError = normalizePersistedError(err);
        previousAttemptUsage = addModelUsage(
          previousAttemptUsage,
          addModelUsage(latestUsage, takeModelUsage(err)),
        );
        const aborted = input.signal?.aborted === true || isAbortError(err);
        await this.commitPendingContent(input, assistantMessageId, state, aborted ? "cancelled" : "failed");
        markAssistantMutation(err, assistantMutated);
        if (aborted) {
          await this.finishUnfinishedStreamingToolCalls(input, state, "cancelled", persistedError);
          await this.finishPendingToolCalls(input, turnId, assistantMessageId, state.toolCalls.splice(0), "cancelled", persistedError);
          throw attachModelUsage(err, previousAttemptUsage);
        }
        await this.finishUnfinishedStreamingToolCalls(input, state, "failed", persistedError);
        await this.finishPendingToolCalls(input, turnId, assistantMessageId, state.toolCalls.splice(0), "failed", persistedError);
        if (!assistantMutated && attempt < retryPolicy.maxAttempts && retryPolicy.retryable(err)) {
          const delayMs = retryDelay(retryPolicy, attempt, err);
          await this.append(input, "turn.retry_scheduled", {
            turnId,
            attempt: attempt + 1,
            delayMs,
            reason: persistedError.message,
          });
          await sleep(delayMs, input.signal);
          attempt++;
          continue;
        }
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
    surface: ContextRequestSurface,
  ): Promise<CompactionAttemptResult> {
    try {
      const result = await this.compactMessages(input, turnId, messages, boundary, surface);
      return { completed: true, ...(result.usage ? { usage: result.usage } : {}) };
    } catch (error) {
      const err = toError(error);
      const persistedError = normalizePersistedError(err);
      const usage = takeModelUsage(err);
      await this.append(input, "turn.compaction_failed", {
        turnId,
        reason: boundary.reason,
        boundaryMessageId: boundary.boundaryMessageId,
        error: persistedError.message,
      });
      if (input.signal?.aborted || isAbortError(err)) throw signalAbortError(input.signal, persistedError.message);
      return { completed: false, ...(usage ? { usage } : {}) };
    }
  }

  private async compactMessages(
    input: CompactContextInput,
    turnId: TurnId,
    messages: readonly Message[],
    boundary: CompactionBoundary,
    surface: ContextRequestSurface,
    completeTurn = false,
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
      turnId: TurnId;
      messages: readonly Message[];
      boundary: CompactionBoundary;
      onPreparedRequest?: (request: ModelStreamInput, source: CompactionRequestSource) => Promise<void>;
      instructions?: string;
      modelSelection?: ModelSelection;
      reasoningLevel?: ReasoningLevel;
      serviceTier?: ServiceTier;
      signal?: AbortSignal;
    } = {
      sessionId: input.sessionId,
      turnId,
      messages,
      boundary,
      onPreparedRequest: async (modelInput, source) => {
        const request = await this.prepareRequest(modelInput, {
          ...(surface.contextWindowTokens !== undefined ? { contextWindowTokens: surface.contextWindowTokens } : {}),
          ...(modelInput.maxTokens !== undefined ? { requestMaxOutputTokens: modelInput.maxTokens } : {}),
          system: modelInput.system,
          ...(modelInput.developer ? { developer: modelInput.developer } : {}),
          ...(modelInput.contextualUser ? { contextualUser: modelInput.contextualUser } : {}),
          tools: modelInput.tools,
        }, undefined, "compaction", undefined, source);
        const requestId = this.id("request");
        await this.append(input, "model.request_prepared", { turnId, requestId, attempt: 1, contentVersion: request.contentVersion, request });
        modelInput.onRequestIdentity = async (identity) => {
          throwIfTurnAborted(input.signal);
          await this.append(input, "model.request_identity", { turnId, requestId, attempt: 1, identity });
        };
      },
    };
    if (input.instructions !== undefined) compactInput.instructions = input.instructions;
    if (input.modelSelection !== undefined) compactInput.modelSelection = input.modelSelection;
    if (input.reasoningLevel !== undefined) compactInput.reasoningLevel = input.reasoningLevel;
    if (input.serviceTier !== undefined) compactInput.serviceTier = input.serviceTier;
    if (input.signal !== undefined) compactInput.signal = input.signal;
    throwIfTurnAborted(input.signal);
    const result = await this.compactor().compact(compactInput);
    try {
      throwIfTurnAborted(input.signal);
      const summaryMessage = this.compactionMessage(input, turnId, result);
      const prospectiveMessages = [...messages, summaryMessage];
      assertCompleteContext(prospectiveMessages, this.contextBuilder().build(prospectiveMessages, surface));
      throwIfTurnAborted(input.signal);
      // The existing store batch commits the replacement and its completion fact
      // together. Cancellation after this point must not relabel it as failed.
      await this.options.store.appendMany([
        this.event(input, "message.created", { messageId: summaryMessage.id, role: "user", turnId }),
        ...summaryMessage.parts.map((part) => this.event(input, "message.part_added", { messageId: summaryMessage.id, part })),
        this.event(input, "turn.compaction_completed", {
          turnId,
          messageId: summaryMessage.id,
          boundaryMessageId: result.boundary.boundaryMessageId,
          summaryChars: result.summary.length,
          sourceMessageCount: result.sourceMessageCount,
          estimatedCharsBefore: result.estimatedCharsBefore,
          estimatedCharsAfter: result.estimatedCharsAfter,
        }),
        ...(completeTurn ? [this.event(input, "turn.completed", { turnId, status: "completed" })] : []),
      ]);
      return {
        messageId: summaryMessage.id,
        boundaryMessageId: result.boundary.boundaryMessageId,
        summaryChars: result.summary.length,
        ...(result.usage ? { usage: result.usage } : {}),
      };
    } catch (error) {
      throw attachModelUsage(toError(error), result.usage);
    }
  }

  private compactionMessage(input: EventContext, turnId: TurnId, result: ContextCompactionResult): Message {
    const messageId = this.id<MessageId>("msg");
    const summaryText = renderContextSummary(result);
    const textPart: MessagePart = {
      id: this.id<PartId>("part"),
      messageId,
      sessionId: input.sessionId,
      type: "text",
      text: summaryText,
      synthetic: true,
    };
    const compactionPart: MessagePart = {
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
    };
    return { id: messageId, sessionId: input.sessionId, role: "user", turnId, createdAt: this.now(), parts: [textPart, compactionPart] };
  }

  private async appendTextDelta(
    input: RunTurnInput,
    assistantMessageId: MessageId,
    state: AssistantStreamState,
    text: string,
    index?: number,
    phase?: AssistantMessagePhase,
  ): Promise<void> {
    const textIndex = index ?? 0;
    let part = state.textParts.get(textIndex);
    if (!part) {
      part = {
        id: this.id<PartId>("part"),
        ordinal: this.nextAssistantPartOrdinal(assistantMessageId),
        messageId: assistantMessageId,
        sessionId: input.sessionId,
        type: "text",
        text: "",
        ...(phase === undefined ? {} : { phase }),
      };
      state.textParts.set(textIndex, part);
      state.pendingContent.set(part.id, part);
    }
    if (part.phase !== phase) {
      throw incompleteModelStreamError(
        `Model assistant text index ${textIndex} changed phase from ${String(part.phase)} to ${String(phase)}`,
      );
    }
    await this.streamContentDelta(input, assistantMessageId, state, part, text);
  }

  private async appendReasoningDelta(
    input: RunTurnInput,
    assistantMessageId: MessageId,
    state: AssistantStreamState,
    text: string,
    index?: number,
    redacted?: boolean,
  ): Promise<void> {
    const reasoningIndex = index ?? 0;
    let part = state.reasoningParts.get(reasoningIndex);
    if (!part) {
      part = {
        id: this.id<PartId>("part"),
        ordinal: this.nextAssistantPartOrdinal(assistantMessageId),
        messageId: assistantMessageId,
        sessionId: input.sessionId,
        type: "reasoning",
        text: "",
        ...(redacted ? { redacted } : {}),
      };
      state.reasoningParts.set(reasoningIndex, part);
      state.pendingContent.set(part.id, part);
    }
    if (redacted) part.redacted = true;
    await this.streamContentDelta(input, assistantMessageId, state, part, text);
  }

  private async streamContentDelta(
    input: EventContext,
    messageId: MessageId,
    state: AssistantStreamState,
    part: AssistantContentPart,
    delta: string,
  ): Promise<void> {
    if (!state.pendingContent.has(part.id)) {
      throw incompleteModelStreamError("Model emitted a delta after the content block ended");
    }
    const offset = part.text.length;
    part.text += delta;
    await this.append(input, "message.part_stream_delta", {
      messageId,
      partId: part.id,
      partType: part.type,
      ordinal: part.ordinal,
      delta,
      offset,
      ...(part.type === "text" && part.phase !== undefined ? { phase: part.phase } : {}),
      ...(part.type === "reasoning" && part.redacted ? { redacted: true } : {}),
    });
  }

  private async commitContentPart(
    input: EventContext,
    messageId: MessageId,
    state: AssistantStreamState,
    part: AssistantContentPart,
    completion: ContentCompletion,
  ): Promise<void> {
    if (!state.pendingContent.has(part.id)) return;
    await this.append(input, "message.part_committed", {
      messageId,
      part: { ...part, completion },
    });
    state.pendingContent.delete(part.id);
  }

  private async commitPendingContent(
    input: EventContext,
    messageId: MessageId,
    state: AssistantStreamState,
    completion: ContentCompletion,
  ): Promise<void> {
    for (const part of state.pendingContent.values()) {
      await this.commitContentPart(input, messageId, state, part, completion);
    }
  }

  private async appendReasoningItem(
    input: RunTurnInput,
    assistantMessageId: MessageId,
    modelOutput: NonNullable<ReasoningPart["modelOutput"]>,
  ): Promise<void> {
    await this.append(input, "message.part_committed", {
      messageId: assistantMessageId,
      part: {
        id: this.id<PartId>("part"),
        ordinal: this.nextAssistantPartOrdinal(assistantMessageId),
        messageId: assistantMessageId,
        sessionId: input.sessionId,
        type: "reasoning",
        text: "",
        modelOutput,
        completion: "completed",
      },
    });
  }

  private async queueToolCall(
    input: RunTurnInput,
    turnId: TurnId,
    assistantMessageId: MessageId,
    toolCall: PendingToolCall,
    guard: DoomLoopGuard,
    state: AssistantStreamState,
  ): Promise<void> {
    toolCall.callId = normalizeToolCallId(toolCall.callId);
    const persistedInput = boundedToolInput(toolCall.input);
    const persistedToolName = boundedToolName(toolCall.toolName);
    await this.appendPart(input, assistantMessageId, {
      id: this.id<PartId>("part"),
      messageId: assistantMessageId,
      sessionId: input.sessionId,
      type: "tool_call",
      ...(toolCall.ordinal === undefined ? {} : { ordinal: toolCall.ordinal }),
      callId: toolCall.callId,
      ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
      toolName: persistedToolName,
      input: persistedInput,
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
        toolName: persistedToolName,
        count: guardResult.count,
      });
      await this.append(input, "tool.call_started", {
        turnId,
        callId: toolCall.callId,
        ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
        toolName: persistedToolName,
        input: persistedInput,
      });
      const persistedError = normalizePersistedError(error);
      await this.append(input, "tool.call_finished", {
        callId: toolCall.callId,
        ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
        status: "failed",
        error: persistedError.message,
        ...persistedErrorDetailsPayload(persistedError),
        synthetic: true,
      });
      await this.appendPart(input, assistantMessageId, {
        id: this.id<PartId>("part"),
        messageId: assistantMessageId,
        sessionId: input.sessionId,
        type: "tool_result",
        callId: toolCall.callId,
        ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
        output: "",
        error: persistedError.message,
        synthetic: true,
      });
      throw error;
    }

    state.toolCalls.push(toolCall);
  }

  private async updateStreamingToolCall(input: EventContext, toolCall: StreamingToolCall): Promise<void> {
    toolCall.callId = normalizeToolCallId(toolCall.callId);
    await this.append(input, "tool.call_updated", {
      callId: toolCall.callId,
      ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
      status: "running",
      toolName: boundedToolName(toolCall.toolName),
      input: boundedToolInput(toolCall.input),
    });
  }

  private async finishUnfinishedStreamingToolCalls(
    input: EventContext,
    state: AssistantStreamState,
    status: "failed" | "cancelled",
    error: unknown,
  ): Promise<void> {
    const persistedError = normalizePersistedError(error);
    const unfinished = [...state.streamingToolCalls.values()];
    state.streamingToolCalls.clear();
    const seen = new Set<ToolCallId>();
    for (const toolCall of unfinished) {
      if (seen.has(toolCall.callId)) continue;
      seen.add(toolCall.callId);
      await this.append(input, "tool.call_finished", {
        callId: toolCall.callId,
        ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
        status,
        error: persistedError.message,
        ...persistedErrorDetailsPayload(persistedError),
        synthetic: true,
      });
    }
  }

  private async executeToolCalls(
    input: RunTurnInput,
    turnId: TurnId,
    assistantMessageId: MessageId,
    toolCalls: readonly PendingToolCall[],
    pendingToolCalls: Set<PendingToolCall>,
    advertisedCatalogRevision: number | undefined,
    dispatch: TurnToolDispatch,
    unloadedToolNames: ReadonlySet<string>,
    envelopeHiddenToolNames: ReadonlySet<string>,
  ): Promise<void> {
    const concurrentLimit = this.options.maxConcurrentToolCalls ?? 10;
    let batch: PendingToolCall[] = [];

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      throwIfTurnAborted(input.signal);
      const current = batch;
      batch = [];
      const results = await Promise.allSettled(
        current.map((toolCall) => {
          // ToolExecutor owns terminal events once a call is dispatched.
          pendingToolCalls.delete(toolCall);
          return this.runToolCall(input, turnId, assistantMessageId, toolCall, dispatch.scope);
        }),
      );
      let failure: Error | undefined;
      for (const result of results) {
        if (result.status === "rejected") {
          failure ??= toError(result.reason);
          continue;
        }
        await this.appendPart(input, assistantMessageId, result.value.part);
        failure ??= result.value.cancelledError;
      }
      failure ??= dispatch.guardError;
      if (failure) throw failure;
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
        pendingToolCalls.delete(toolCall);
        await this.appendPart(input, assistantMessageId, part);
        continue;
      }
      if (unloadedToolNames.has(toolCall.toolName) || envelopeHiddenToolNames.has(toolCall.toolName)) {
        await flush();
        const part = await this.failToolCallWithoutExecution(
          input,
          turnId,
          assistantMessageId,
          toolCall,
          unloadedToolNames.has(toolCall.toolName)
            ? `Tool is not loaded for direct calls. Use tool_search with query "select:${toolCall.toolName}" first, then call it on the next turn. Code-mode-enabled tools remain callable from scripts without loading.`
            : "Tool was not advertised to the model because its definition exceeded the context envelope.",
        );
        pendingToolCalls.delete(toolCall);
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
        pendingToolCalls.delete(toolCall);
        await this.appendPart(input, assistantMessageId, part);
        continue;
      }
      try {
        toolCall.prepared = await this.options.toolExecutor.prepare(this.executeInput(input, turnId, toolCall));
        if (advertisedCatalogRevision !== undefined && toolCall.prepared.registryRevision !== advertisedCatalogRevision) {
          throw new ToolValidationError(toolCall.toolName, "Tool catalog changed after this model request; retry with the refreshed tool definitions.");
        }
      } catch (error) {
        if (!(error instanceof ToolValidationError) && !(error instanceof UnknownToolError)) throw error;
        await flush();
        const part = await this.failToolCallWithoutExecution(input, turnId, assistantMessageId, toolCall, error);
        pendingToolCalls.delete(toolCall);
        await this.appendPart(input, assistantMessageId, part);
        continue;
      }
      if (toolCall.prepared.isConcurrencySafe) {
        batch.push(toolCall);
        if (batch.length >= concurrentLimit) await flush();
        continue;
      }

      await flush();
      throwIfTurnAborted(input.signal);
      pendingToolCalls.delete(toolCall);
      const result = await this.runToolCall(input, turnId, assistantMessageId, toolCall, dispatch.scope);
      await this.appendPart(input, assistantMessageId, result.part);
      if (result.cancelledError) throw result.cancelledError;
      if (dispatch.guardError) throw dispatch.guardError;
    }

    await flush();
  }

  private async failToolCallWithoutExecution(
    input: EventContext,
    turnId: TurnId,
    assistantMessageId: MessageId,
    toolCall: PendingToolCall,
    error: unknown,
    status: "failed" | "cancelled" = "failed",
  ): Promise<MessagePart> {
    const persistedError = normalizePersistedError(error);
    await this.append(input, "tool.call_started", {
      turnId,
      callId: toolCall.callId,
      ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
      toolName: boundedToolName(toolCall.toolName),
      input: boundedToolInput(toolCall.input),
    });
    await this.append(input, "tool.call_finished", {
      callId: toolCall.callId,
      ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
      status,
      error: persistedError.message,
      ...persistedErrorDetailsPayload(persistedError),
      synthetic: true,
    });
    return {
      id: this.id<PartId>("part"),
      messageId: assistantMessageId,
      sessionId: input.sessionId,
      type: "tool_result",
      callId: toolCall.callId,
      ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
      output: "",
      error: persistedError.message,
      synthetic: true,
    };
  }

  private async finishPendingToolCalls(
    input: EventContext,
    turnId: TurnId,
    assistantMessageId: MessageId,
    toolCalls: readonly PendingToolCall[],
    status: "failed" | "cancelled",
    error: unknown,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      const part = await this.failToolCallWithoutExecution(
        input,
        turnId,
        assistantMessageId,
        toolCall,
        error,
        status,
      );
      await this.appendPart(input, assistantMessageId, part);
    }
  }

  private executeInput(input: RunTurnInput, turnId: TurnId, toolCall: PendingToolCall): ExecuteToolInput {
    return {
      sessionId: input.sessionId,
      turnId,
      callId: toolCall.callId,
      ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
      toolName: toolCall.toolName,
      input: toolCall.input,
      cwd: input.cwd,
      ...(input.toolPolicy ? { policy: input.toolPolicy } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    };
  }

  private async runToolCall(
    input: RunTurnInput,
    turnId: TurnId,
    assistantMessageId: MessageId,
    toolCall: PendingToolCall,
    dispatchScope: ToolDispatchScope,
  ): Promise<{ part: MessagePart; cancelledError?: Error }> {
    const result = await this.options.toolExecutor.execute({
      ...this.executeInput(input, turnId, toolCall),
      dispatchScope,
      ...(toolCall.prepared ? { prepared: toolCall.prepared } : {}),
    });

    if (result.status === "completed") {
      const executionContext = toolResultExecutionContext(result.result.metadata);
      const part: MessagePart = {
        id: this.id<PartId>("part"),
        messageId: assistantMessageId,
        sessionId: input.sessionId,
        type: "tool_result",
        callId: toolCall.callId,
        ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
        output: result.result.output,
        ...(result.result.structuredData !== undefined ? { structuredData: result.result.structuredData } : {}),
        ...(executionContext ? { executionContext } : {}),
      };
      if (result.result.content) {
        part.content = result.result.content;
      }
      if (result.result.artifactIds) {
        part.artifactIds = result.result.artifactIds;
      }
      return { part };
    }

    const persistedError = normalizePersistedError(result.error);
    const part: MessagePart = {
      id: this.id<PartId>("part"),
      messageId: assistantMessageId,
      sessionId: input.sessionId,
      type: "tool_result",
      callId: toolCall.callId,
      ...(toolCall.providerCallId ? { providerCallId: toolCall.providerCallId } : {}),
      output: "",
      error: persistedError.message,
      synthetic: true,
    };
    if (result.status === "cancelled") {
      return { part, cancelledError: persistedError };
    }
    return { part };
  }

  private nextAssistantPartOrdinal(messageId: MessageId): number {
    const ordinal = this.assistantPartOrdinals.get(messageId);
    if (ordinal === undefined) throw new Error("Assistant content has no active message order");
    this.assistantPartOrdinals.set(messageId, ordinal + 1);
    return ordinal;
  }

  private async appendPart(input: EventContext, messageId: MessageId, part: MessagePart): Promise<void> {
    const orderedPart = part.ordinal === undefined && this.assistantPartOrdinals.has(messageId)
      ? { ...part, ordinal: this.nextAssistantPartOrdinal(messageId) }
      : part;
    await this.append(input, "message.part_added", {
      messageId,
      part: orderedPart,
    });
  }

  private async appendModelMetadata(
    input: EventContext,
    turnId: TurnId,
    metadata: Extract<ModelStreamEvent, { type: "metadata" | "finish" | "error" }>,
  ): Promise<void> {
    const provider = isModelMetadataEvent(metadata)
      ? boundedModelMetadataText(unknownErrorField(metadata, "provider"), "model provider")
      : undefined;
    const model = isModelMetadataEvent(metadata)
      ? boundedModelMetadataText(unknownErrorField(metadata, "model"), "model name")
      : undefined;
    const responseId = persistedModelResponseId(unknownErrorField(metadata, "responseId"));
    const usage = persistedModelUsage(unknownErrorField(metadata, "usage"));
    const contextWindowTokens = isModelMetadataEvent(metadata)
      ? persistedModelMetadataNumber(unknownErrorField(metadata, "contextWindowTokens"))
      : undefined;
    const maxOutputTokens = isModelMetadataEvent(metadata)
      ? persistedModelMetadataNumber(unknownErrorField(metadata, "maxOutputTokens"))
      : undefined;
    await this.append(input, "turn.model_metadata", {
      turnId,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(responseId ? { responseId } : {}),
      ...(usage ? { usage } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    });
  }

  private async append<TType extends RuntimeEvent["type"], TPayload>(
    input: EventContext,
    type: TType,
    payload: TPayload,
  ): Promise<void> {
    await this.options.store.append(this.event(input, type, payload));
  }

  private event<TType extends RuntimeEvent["type"], TPayload>(
    input: EventContext,
    type: TType,
    payload: TPayload,
  ): RuntimeEvent {
    const event: EventEnvelope<TType, TPayload> = {
      id: this.id("event"),
      type,
      time: this.now(),
      sessionId: input.sessionId,
      payload,
    };
    return event as RuntimeEvent;
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

function toolResultExecutionContext(
  metadata: Record<string, unknown> | undefined,
): ToolResultExecutionContext | undefined {
  if (!metadata) return undefined;
  const context: ToolResultExecutionContext = {};

  if (metadata.sandbox === "macos-seatbelt" || metadata.sandbox === "none") {
    context.sandbox = metadata.sandbox;
  }
  if (metadata.executionMode === "sandboxed" || metadata.executionMode === "unsandboxed") {
    context.executionMode = metadata.executionMode;
  }
  if (metadata.exitCode === null || isNonNegativeInteger(metadata.exitCode)) {
    context.exitCode = metadata.exitCode;
  }
  if (typeof metadata.timedOut === "boolean") context.timedOut = metadata.timedOut;
  if (typeof metadata.aborted === "boolean") context.aborted = metadata.aborted;
  if (metadata.signal === null || isProcessSignal(metadata.signal)) context.signal = metadata.signal;

  return Object.keys(context).length > 0 ? context : undefined;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isProcessSignal(value: unknown): value is string {
  return typeof value === "string" && /^SIG[A-Z0-9]{1,28}$/.test(value);
}

function toError(error: unknown): Error {
  const usage = takeModelUsage(error);
  const assistantMutated = didAssistantMutate(error);
  const retryable = isRetryableTransientError(error);
  const retryAfterMs = retryAfterDelayHint(error);
  const contextLimit = isContextLimitErrorValue(error, new Set<object>(), 0);
  const normalized = normalizePersistedError(error);
  copyRuntimeErrorScalar(error, normalized, "retryable", "boolean");
  copyRuntimeErrorScalar(error, normalized, "status", "number");
  copyRuntimeErrorScalar(error, normalized, "statusCode", "number");
  copyRuntimeErrorScalar(error, normalized, "httpStatus", "number");
  copyRuntimeErrorScalar(error, normalized, "retryAfterMs", "number");
  copyRuntimeErrorScalar(error, normalized, "errno", "string");
  copyRuntimeErrorScalar(error, normalized, "category", "string");
  copyRuntimeErrorScalar(error, normalized, "type", "string");
  copyRuntimeErrorScalar(error, normalized, "reason", "string");
  copyRuntimeErrorScalar(error, normalized, "errorCode", "string");
  Object.defineProperty(normalized, "retryable", {
    configurable: true,
    enumerable: true,
    value: retryable,
    writable: true,
  });
  if (retryAfterMs !== undefined) {
    Object.defineProperty(normalized, "retryAfterMs", {
      configurable: true,
      enumerable: true,
      value: retryAfterMs,
      writable: true,
    });
  }
  if (contextLimit) {
    Object.defineProperty(normalized, "type", {
      configurable: true,
      enumerable: true,
      value: "context_length_exceeded",
      writable: true,
    });
  }
  if (usage) attachModelUsage(normalized, usage);
  if (assistantMutated) markAssistantMutation(normalized, true);
  return normalized;
}

function copyRuntimeErrorScalar(
  source: unknown,
  target: Error,
  key: string,
  expectedType: "boolean" | "number" | "string",
): void {
  if ((typeof source !== "object" && typeof source !== "function") || source === null) return;
  let value: unknown;
  try {
    value = Reflect.get(source, key);
  } catch {
    return;
  }
  if (typeof value !== expectedType) return;
  if (expectedType === "number" && !Number.isFinite(value)) return;
  if (expectedType === "string" && !isSafeRuntimeErrorTag(value as string)) return;
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
}

function isSafeRuntimeErrorTag(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > 256 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) return false;
  const probe = normalizePersistedError(Object.assign(new Error("classification tag"), { code: value }));
  return probe.code === value;
}

function persistedErrorDetailsPayload(
  error: ReturnType<typeof normalizePersistedError>,
): { errorDetails?: ReturnType<typeof normalizePersistedError>["persistedErrorDetails"] } {
  const details = error.persistedErrorDetails;
  return (details.name !== "Error" && details.name !== "AbortError")
    || details.code !== undefined
    || details.truncated === true
    ? { errorDetails: details }
    : {};
}

function terminalPersistedError(error: Error, aborted: boolean): ReturnType<typeof normalizePersistedError> {
  const normalized = normalizePersistedError(error);
  if (!aborted) return normalized;
  normalized.name = "AbortError";
  return normalizePersistedError(normalized);
}

const assistantMutationByError = new WeakMap<object, boolean>();

function markAssistantMutation(error: Error, assistantMutated: boolean): void {
  assistantMutationByError.set(error, assistantMutated);
}

function didAssistantMutate(error: unknown): boolean {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return false;
  return assistantMutationByError.get(error) === true;
}

function isContextLimitError(error: Error): boolean {
  return isContextLimitErrorValue(error, new Set<object>(), 0);
}

function isContextLimitErrorValue(value: unknown, seen: Set<object>, depth: number): boolean {
  if (typeof value === "string") return isContextLimitMessage(value);
  if (typeof value !== "object" || value === null || seen.has(value) || depth > 8 || seen.size >= 256) return false;
  seen.add(value);

  const status = numericErrorField(value, "status")
    ?? numericErrorField(value, "statusCode")
    ?? numericErrorField(value, "httpStatus");
  if (status === 413) return true;

  for (const key of ["code", "type", "reason", "errorCode"] as const) {
    const tag = stringErrorField(value, key);
    if (tag && isContextLimitTag(tag)) return true;
  }

  const name = stringErrorField(value, "name");
  if (name && isContextLimitTag(name)) return true;
  const message = stringErrorField(value, "message");
  if (message && isContextLimitMessage(message)) return true;

  const cause = unknownErrorField(value, "cause");
  if (cause !== undefined && isContextLimitErrorValue(cause, seen, depth + 1)) return true;
  const errors = unknownErrorField(value, "errors");
  const errorCount = safeErrorArrayLength(errors);
  for (let index = 0; index < Math.min(errorCount, 64); index += 1) {
    if (isContextLimitErrorValue(unknownErrorField(errors, String(index)), seen, depth + 1)) return true;
  }
  return false;
}

function safeErrorArrayLength(value: unknown): number {
  try {
    if (!Array.isArray(value)) return 0;
    const length = Reflect.get(value, "length");
    return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : 0;
  } catch {
    return 0;
  }
}

function isContextLimitMessage(value: string): boolean {
  const message = value.toLowerCase();
  return message.includes("context window")
    || message.includes("context length")
    || message.includes("maximum context")
    || message.includes("prompt is too long")
    || message.includes("input is too long")
    || message.includes("too many tokens")
    || message.includes("request too large")
    || message.includes("http 413")
    || /\b413\b/.test(message);
}

function isContextLimitTag(value: string): boolean {
  const tag = value.trim().toLowerCase().replace(/[.\s-]+/g, "_");
  return tag === "context_length_exceeded"
    || tag === "context_window_exceeded"
    || tag === "max_context_length_exceeded"
    || tag === "maximum_context_length"
    || tag === "context_overflow"
    || tag === "prompt_too_long"
    || tag === "input_too_long"
    || tag === "request_too_large"
    || tag === "too_many_tokens"
    || tag === "token_limit_exceeded"
    || /(?:context|prompt|input|request).*(?:length|window|tokens?|size).*(?:error|exceed|limit|long|large|overflow)/.test(tag);
}

function stringErrorField(value: object, key: string): string | undefined {
  const field = unknownErrorField(value, key);
  return typeof field === "string" && field.trim() ? field : undefined;
}

function numericErrorField(value: object, key: string): number | undefined {
  const field = unknownErrorField(value, key);
  if (typeof field === "number" && Number.isFinite(field)) return field;
  if (typeof field !== "string" || !field.trim()) return undefined;
  const parsed = Number(field);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function unknownErrorField(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
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
  const persisted = normalizePersistedError(error);
  return persisted.name === "AbortError" || persisted.message.toLowerCase().includes("aborted");
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfTurnAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signalAbortError(signal, "Turn aborted");
}

function signalAbortError(signal: AbortSignal | undefined, fallbackMessage: string): Error {
  if (!signal?.aborted) return terminalPersistedError(toError(fallbackMessage), true);
  let reason: unknown;
  try {
    reason = signal.reason;
  } catch {
    return abortError(fallbackMessage);
  }
  if (reason === undefined
    || (typeof DOMException !== "undefined" && reason instanceof DOMException && reason.name === "AbortError")) {
    return abortError(fallbackMessage);
  }
  return terminalPersistedError(toError(reason), true);
}

function boundedToolInput(value: unknown): unknown {
  return boundPersistedJsonValue(value, {
    maxBytes: PERSISTED_JSON_LIMITS.eventValueBytes,
    maxStringBytes: PERSISTED_JSON_LIMITS.stringBytes,
    maxItems: PERSISTED_JSON_LIMITS.items,
    maxDepth: PERSISTED_JSON_LIMITS.depth,
    maxNodes: PERSISTED_JSON_LIMITS.nodes,
    label: "tool input",
  });
}

function boundedToolName(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!sanitized) return "unknown_tool";
  const bounded = boundPersistedJsonValue(sanitized, {
    maxBytes: 514,
    maxStringBytes: 512,
    maxItems: 1,
    maxDepth: 1,
    maxNodes: 1,
    label: "tool name",
  });
  return typeof bounded === "string" && bounded.trim() ? bounded : "unknown_tool";
}

function boundedModelMetadataText(value: unknown, label: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const redacted = normalizePersistedError(value).message;
  const sanitized = redacted.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!sanitized) return undefined;
  const bounded = boundPersistedJsonValue(sanitized, {
    maxBytes: MAX_MODEL_METADATA_TEXT_BYTES,
    maxStringBytes: MAX_MODEL_METADATA_TEXT_BYTES - 2,
    maxItems: 1,
    maxDepth: 1,
    maxNodes: 1,
    label,
  });
  return typeof bounded === "string" && bounded.trim() ? bounded : undefined;
}

function persistedModelResponseId(value: unknown): string | undefined {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > MAX_MODEL_RESPONSE_ID_CHARS
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value === "__proto__"
    || value === "prototype"
    || value === "constructor") {
    return undefined;
  }
  return value;
}

function persistedModelUsage(value: unknown): ModelUsage | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  const result: ModelUsage = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "totalTokens",
  ] as const) {
    const candidate = persistedModelMetadataNumber(unknownErrorField(value, key));
    if (candidate !== undefined) result[key] = candidate;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function persistedModelMetadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function toolCallKey(toolCallId: string, index: number | undefined): string {
  return `${normalizeToolCallId(toolCallId, index)}:${index ?? ""}`;
}

function isOutputLimitFinishReason(reason: string | undefined): boolean {
  if (!reason) return false;
  const normalized = reason.toLowerCase();
  return normalized === "length" || normalized === "max_tokens" || normalized === "max_output_tokens";
}

function incompleteModelStreamError(message: string): Error {
  return Object.assign(new Error(message), { name: "ModelStreamIncompleteError", retryable: false });
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
    "<context_summary>",
    stripContextSummary(result.summary),
    "</context_summary>",
  ].join("\n");
}

function assertCompleteContext(messages: readonly Message[], built: ContextBuildResult): void {
  if (built.overflow) throw new ContextWindowExceededError(built.overflow);
  const effectiveMessages = compactedMessageView(messages).filter((message) => message.parts.length > 0);
  const visibleById = new Map(built.messages.map((message) => [message.id, message]));
  for (const message of effectiveMessages) {
    const visible = visibleById.get(message.id);
    if (!visible) {
      throw Object.assign(new Error("Context budget would omit unsummarized history; reduce the current request or increase the context budget"), {
        name: "ContextWindowExceededError",
      });
    }
    if (!message.parts.some((part) => part.type === "compaction")) continue;
    const summaryText = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const visibleSummaryText = visible.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (summaryText !== visibleSummaryText) {
      throw Object.assign(new Error("Context budget would truncate the context summary; reduce the summary size or increase the context budget"), {
        name: "ContextWindowExceededError",
      });
    }
  }
}

function stripContextSummary(summary: string): string {
  const match = /<context_summary\b[^>]*>([\s\S]*?)<\/context_summary>/i.exec(summary.trim());
  return (match?.[1] ?? summary).trim();
}
