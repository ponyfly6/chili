import type {
  ChiliEvent,
  EventEnvelope,
  Message,
  MessageId,
  ModelSelection,
  PartId,
  ReasoningLevel,
  RuntimeModelConfig,
  RuntimeModelDescriptor,
  RuntimeSessionStatus,
  RuntimeSkillMention,
  SessionId,
  ThreadId,
  TimestampMs,
  TurnId,
} from "@chili/protocol";
import { REASONING_LEVELS, timestampNow } from "@chili/protocol";
import type { EventStore } from "@chili/store";
import {
  ContextWindowBuilder,
  conversationPromptFragment,
  type ContextBudgetOptions,
} from "./context/index.js";
import {
  PromptAssembler,
  type PromptAssembly,
  type PromptDebugManifest,
  type PromptFragment,
  type RenderedPromptFragment,
} from "./prompt/index.js";
import type { AgentRunner, RunTurnInput, RunTurnResult } from "./runner.js";
import type { CompactContextResult } from "./single-agent-runtime.js";

const FINAL_RESPONSE_AFTER_MAX_TURNS_SYSTEM =
  "The automatic tool-use continuation limit has been reached. Do not call tools. Use the information already available in the conversation to give the best final answer now, and briefly state anything that remains uncertain.";
const DEFAULT_MAX_TURNS = 128;

export type RuntimeModelCatalogProvider = () =>
  | Promise<readonly RuntimeModelDescriptor[]>
  | readonly RuntimeModelDescriptor[];

export interface RuntimeServiceOptions {
  runtime: AgentRunner;
  store: EventStore;
  cwd: string;
  maxTurns?: number;
  contextBudget?: ContextBudgetOptions;
  contextBuilder?: ContextWindowBuilder;
  promptFragments?: RuntimePromptFragmentsProvider;
  models?: RuntimeModelCatalogProvider | readonly RuntimeModelDescriptor[];
  defaultModelSelection?: ModelSelection;
  defaultReasoningLevel?: ReasoningLevel;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
}

export type RuntimePromptFragmentsProvider = (input: {
  sessionId: SessionId;
  threadId: ThreadId;
  cwd: string;
  turn?: RuntimePromptTurnContext;
}) => Promise<PromptFragment[]> | PromptFragment[];

export interface RuntimePromptTurnContext {
  text: string;
  skillMentions?: readonly RuntimeSkillMention[];
}

export interface CreateRuntimeSessionInput {
  sessionId?: SessionId;
  threadId?: ThreadId;
  cwd?: string;
}

export interface RuntimeSessionHandle {
  sessionId: SessionId;
  threadId: ThreadId;
}

export interface SubmitPromptInput {
  sessionId: SessionId;
  threadId: ThreadId;
  text: string;
  displayText?: string;
  skillMentions?: readonly RuntimeSkillMention[];
  cwd?: string;
  maxTurns?: number;
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
  signal?: AbortSignal;
}

export interface InspectPromptInput {
  sessionId: SessionId;
  threadId: ThreadId;
  cwd: string;
  text?: string;
  skillMentions?: readonly RuntimeSkillMention[];
  includeContent?: boolean;
}

export interface InspectPromptWithContentResult {
  debug: PromptDebugManifest;
  fragments: RenderedPromptFragment[];
}

export interface CompactSessionInput {
  sessionId: SessionId;
  threadId: ThreadId;
  instructions?: string;
  signal?: AbortSignal;
}

export interface SetRuntimeModelInput {
  sessionId: SessionId;
  threadId?: ThreadId;
  modelSelection: ModelSelection;
}

export interface SetRuntimeReasoningInput {
  sessionId: SessionId;
  threadId?: ThreadId;
  reasoningLevel: ReasoningLevel;
}

interface RuntimeSessionModelState {
  modelSelection?: ModelSelection;
  reasoningLevel?: ReasoningLevel;
}

export type SubmitPromptResult =
  | {
      status: "completed";
      turns: RunTurnResult[];
      finishReason?: string;
    }
  | {
      status: "failed" | "cancelled" | "max_turns";
      turns: RunTurnResult[];
      error?: Error;
      finishReason?: string;
    };

export type RuntimeBackgroundErrorHandler = (error: unknown) => void;

export class RuntimeBusyError extends Error {
  constructor(readonly sessionId: SessionId) {
    super(`Session is already running: ${sessionId}`);
    this.name = "RuntimeBusyError";
  }
}

export class RuntimeService {
  private readonly running = new Map<SessionId, AbortController>();
  private readonly sessionModelState = new Map<SessionId, RuntimeSessionModelState>();
  private globalModelState?: RuntimeSessionModelState;

  constructor(private readonly options: RuntimeServiceOptions) {}

  async createSession(input: CreateRuntimeSessionInput = {}): Promise<RuntimeSessionHandle> {
    const threadId = input.threadId ?? this.id<ThreadId>("thread");
    const createInput: {
      sessionId?: SessionId;
      threadId: ThreadId;
      cwd: string;
    } = {
      threadId,
      cwd: input.cwd ?? this.options.cwd,
    };
    if (input.sessionId) createInput.sessionId = input.sessionId;
    const sessionId = await this.options.runtime.createSession(createInput);
    await this.publishStatus({ sessionId, threadId, status: "idle", reason: "session_created" });
    return { sessionId, threadId };
  }

  appendUserMessage(input: { sessionId: SessionId; threadId: ThreadId; text: string; displayText?: string }): Promise<MessageId> {
    return this.options.runtime.appendUserMessage(input);
  }

  async listModels(input: { provider?: string } = {}): Promise<RuntimeModelDescriptor[]> {
    const models = await this.resolveModelCatalog();
    return models
      .filter((model) => !input.provider || model.provider === input.provider)
      .map(cloneModelDescriptor);
  }

  async getModelConfig(sessionId: SessionId): Promise<RuntimeModelConfig> {
    return this.buildModelConfig(sessionId, await this.resolveSessionModelState(sessionId));
  }

  async setModel(input: SetRuntimeModelInput): Promise<RuntimeModelConfig> {
    const modelSelection = normalizeModelSelection(input.modelSelection);
    const state = await this.resolveSessionModelState(input.sessionId);
    state.modelSelection = modelSelection;
    this.sessionModelState.set(input.sessionId, cloneSessionModelState(state));
    this.globalModelState = cloneSessionModelState(state);
    await this.append(input, "session.model_changed", {
      sessionId: input.sessionId,
      modelSelection,
    });
    return this.buildModelConfig(input.sessionId, state);
  }

  async setReasoning(input: SetRuntimeReasoningInput): Promise<RuntimeModelConfig> {
    if (!isReasoningLevel(input.reasoningLevel)) {
      throw new Error(`Invalid reasoning level: ${input.reasoningLevel}`);
    }
    const state = await this.resolveSessionModelState(input.sessionId);
    state.reasoningLevel = input.reasoningLevel;
    this.sessionModelState.set(input.sessionId, cloneSessionModelState(state));
    this.globalModelState = cloneSessionModelState(state);
    await this.append(input, "session.reasoning_changed", {
      sessionId: input.sessionId,
      reasoningLevel: input.reasoningLevel,
    });
    return this.buildModelConfig(input.sessionId, state);
  }

  async compactSession(input: CompactSessionInput): Promise<CompactContextResult> {
    if (this.running.has(input.sessionId)) {
      throw new RuntimeBusyError(input.sessionId);
    }
    const runtime = this.options.runtime as AgentRunner & {
      compactContext?: (compactInput: {
        sessionId: SessionId;
        threadId: ThreadId;
        reason: "manual";
        instructions?: string;
        signal?: AbortSignal;
      }) => Promise<CompactContextResult>;
    };
    if (!runtime.compactContext) {
      throw new Error("Runtime does not support context compaction");
    }

    const controller = this.createRunController({ ...input, text: "" });
    try {
      await this.publishStatus({
        sessionId: input.sessionId,
        threadId: input.threadId,
        status: "running",
        reason: "manual_compaction",
      });
      const compactInput: {
        sessionId: SessionId;
        threadId: ThreadId;
        reason: "manual";
        instructions?: string;
        signal?: AbortSignal;
      } = {
        sessionId: input.sessionId,
        threadId: input.threadId,
        reason: "manual",
        signal: controller.signal,
      };
      if (input.instructions) compactInput.instructions = input.instructions;
      const result = await runtime.compactContext(compactInput);
      await this.publishStatus({
        sessionId: input.sessionId,
        threadId: input.threadId,
        status: result.status === "failed" || result.status === "cancelled" ? result.status : "idle",
        ...(result.status === "failed" || result.status === "cancelled" ? { reason: result.error.message } : {}),
      });
      return result;
    } finally {
      this.running.delete(input.sessionId);
    }
  }

  async submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult> {
    if (this.running.has(input.sessionId)) {
      throw new RuntimeBusyError(input.sessionId);
    }

    const controller = this.createRunController(input);
    return this.runReservedPrompt(input, controller);
  }

  async inspectPrompt(input: InspectPromptInput & { includeContent: true }): Promise<InspectPromptWithContentResult>;
  async inspectPrompt(input: InspectPromptInput & { includeContent?: false | undefined }): Promise<PromptDebugManifest>;
  async inspectPrompt(input: InspectPromptInput): Promise<PromptDebugManifest | InspectPromptWithContentResult>;
  async inspectPrompt(input: InspectPromptInput): Promise<PromptDebugManifest | InspectPromptWithContentResult> {
    const prompt = await this.resolvePromptAssembly({
      sessionId: input.sessionId,
      threadId: input.threadId,
      cwd: input.cwd,
      ...(input.text !== undefined ? { turn: turnContext(input), previewTurnInConversation: true } : {}),
    });
    if (!input.includeContent) return prompt.debug;
    return {
      debug: prompt.debug,
      fragments: prompt.fragments,
    };
  }

  submitPromptAsync(input: SubmitPromptInput, onError?: RuntimeBackgroundErrorHandler): void {
    if (this.running.has(input.sessionId)) {
      throw new RuntimeBusyError(input.sessionId);
    }

    const controller = this.createRunController(input);
    queueMicrotask(() => {
      void this.runReservedPrompt(input, controller).catch((error: unknown) => {
        onError?.(error);
      });
    });
  }

  isRunning(sessionId: SessionId): boolean {
    return this.running.has(sessionId);
  }

  private async runReservedPrompt(input: SubmitPromptInput, controller: AbortController): Promise<SubmitPromptResult> {
    const turns: RunTurnResult[] = [];
    const maxTurns = input.maxTurns ?? this.options.maxTurns ?? DEFAULT_MAX_TURNS;
    const cwd = input.cwd ?? this.options.cwd;

    try {
      const promptModelState = await this.resolvePromptModelState(input);

      await this.publishStatus({
        sessionId: input.sessionId,
        threadId: input.threadId,
        status: "running",
        reason: "prompt_submitted",
      });

      await this.options.runtime.appendUserMessage({
        sessionId: input.sessionId,
        threadId: input.threadId,
        text: input.text,
        ...(input.displayText ? { displayText: input.displayText } : {}),
      });

      for (let index = 0; index < maxTurns; index++) {
        if (controller.signal.aborted) {
          return await this.cancelledPrompt(input, turns, "Prompt aborted");
        }

        const prompt = await this.resolvePromptAssembly({
          sessionId: input.sessionId,
          threadId: input.threadId,
          cwd,
          turn: turnContext(input),
        });
        const runInput = this.buildRunTurnInput({
          input,
          cwd,
          prompt,
          signal: controller.signal,
          modelState: promptModelState,
        });
        const result = await this.options.runtime.runTurn(runInput);
        turns.push(result);
        await this.publishTurnProgress(input, result);

        if (result.status !== "completed") {
          return {
            status: result.status,
            turns,
            error: result.error,
          };
        }

        if (controller.signal.aborted) {
          return await this.cancelledPrompt(input, turns, "Prompt aborted");
        }

        if (!isToolUseFinishReason(result.finishReason)) {
          return await this.completedPrompt(input, turns, result);
        }
      }

      if (controller.signal.aborted) {
        return await this.cancelledPrompt(input, turns, "Prompt aborted");
      }

      const prompt = await this.resolvePromptAssembly({
        sessionId: input.sessionId,
        threadId: input.threadId,
        cwd,
        turn: turnContext(input),
      });
      const finalRunInput = this.buildRunTurnInput({
        input,
        cwd,
        prompt: this.withFinalResponsePrompt(prompt),
        signal: controller.signal,
        modelState: promptModelState,
        toolMode: "disabled",
      });
      const finalResult = await this.options.runtime.runTurn(finalRunInput);
      turns.push(finalResult);
      await this.publishTurnProgress(input, finalResult);

      if (finalResult.status !== "completed") {
        return {
          status: finalResult.status,
          turns,
          error: finalResult.error,
        };
      }

      if (controller.signal.aborted) {
        return await this.cancelledPrompt(input, turns, "Prompt aborted");
      }

      if (!isToolUseFinishReason(finalResult.finishReason)) {
        return await this.completedPrompt(input, turns, finalResult);
      }

      await this.publishStatus({
        sessionId: input.sessionId,
        threadId: input.threadId,
        status: "failed",
        turnId: finalResult.turnId,
        reason: "max_turns",
      });
      return {
        status: "max_turns",
        turns,
        finishReason: finalResult.finishReason ?? "tool_use",
      };
    } catch (error) {
      const err = toError(error);
      const status: Extract<RuntimeSessionStatus, "cancelled" | "failed"> = isAbortError(err) ? "cancelled" : "failed";
      await this.publishStatus({
        sessionId: input.sessionId,
        threadId: input.threadId,
        status,
        reason: err.message,
      });
      return {
        status,
        turns,
        error: err,
      };
    } finally {
      this.running.delete(input.sessionId);
    }
  }

  private buildRunTurnInput(input: {
    input: SubmitPromptInput;
    cwd: string;
    prompt: PromptAssembly;
    signal: AbortSignal;
    modelState: RuntimeSessionModelState;
    toolMode?: "auto" | "disabled";
  }): RunTurnInput {
    const runInput: RunTurnInput = {
      sessionId: input.input.sessionId,
      threadId: input.input.threadId,
      cwd: input.cwd,
      system: input.prompt.system,
      signal: input.signal,
    };
    if (input.prompt.developer.length > 0) runInput.developer = input.prompt.developer;
    if (input.prompt.contextualUser.length > 0) runInput.contextualUser = input.prompt.contextualUser;
    runInput.promptDebug = input.prompt.debug;
    if (input.toolMode) runInput.toolMode = input.toolMode;
    if (input.modelState.modelSelection) runInput.modelSelection = input.modelState.modelSelection;
    if (input.modelState.reasoningLevel !== undefined) runInput.reasoningLevel = input.modelState.reasoningLevel;
    return runInput;
  }

  private async publishTurnProgress(input: SubmitPromptInput, result: RunTurnResult): Promise<void> {
    const turnStatus: {
      sessionId: SessionId;
      threadId: ThreadId;
      status: RuntimeSessionStatus;
      turnId: TurnId;
      reason?: string;
    } = {
      sessionId: input.sessionId,
      threadId: input.threadId,
      status: result.status === "completed" ? "running" : result.status,
      turnId: result.turnId,
    };
    const turnReason = result.status === "completed" ? result.finishReason : result.error.message;
    if (turnReason) turnStatus.reason = turnReason;
    await this.publishStatus(turnStatus);
  }

  private async completedPrompt(
    input: SubmitPromptInput,
    turns: RunTurnResult[],
    result: Extract<RunTurnResult, { status: "completed" }>,
  ): Promise<Extract<SubmitPromptResult, { status: "completed" }>> {
    const idleStatus: {
      sessionId: SessionId;
      threadId: ThreadId;
      status: RuntimeSessionStatus;
      turnId: TurnId;
      reason?: string;
    } = {
      sessionId: input.sessionId,
      threadId: input.threadId,
      status: "idle",
      turnId: result.turnId,
    };
    if (result.finishReason) idleStatus.reason = result.finishReason;
    await this.publishStatus(idleStatus);

    const completed: Extract<SubmitPromptResult, { status: "completed" }> = {
      status: "completed",
      turns,
    };
    if (result.finishReason) completed.finishReason = result.finishReason;
    return completed;
  }

  private async resolvePromptAssembly(input: {
    sessionId: SessionId;
    threadId: ThreadId;
    cwd: string;
    turn?: RuntimePromptTurnContext;
    previewTurnInConversation?: boolean;
  }): Promise<PromptAssembly> {
    const fragments = await this.options.promptFragments?.({
      sessionId: input.sessionId,
      threadId: input.threadId,
      cwd: input.cwd,
      ...(input.turn ? { turn: input.turn } : {}),
    });
    const conversation = await this.resolveConversationPromptFragment(input);
    return new PromptAssembler().addMany(fragments).add(conversation).assemble();
  }

  private async resolveConversationPromptFragment(input: {
    sessionId: SessionId;
    threadId: ThreadId;
    turn?: RuntimePromptTurnContext;
    previewTurnInConversation?: boolean;
  }): Promise<PromptFragment | undefined> {
    const messages = await this.options.store.messages(input.sessionId);
    const conversationMessages =
      input.turn && input.previewTurnInConversation
        ? [...messages, this.syntheticInspectUserMessage(input.sessionId, input.turn.text)]
        : messages;
    const context = this.contextBuilder().build(conversationMessages);
    return conversationPromptFragment({
      messages: context.messages,
      usage: context.usage,
      ...(context.compactionBoundary ? { compactionBoundary: context.compactionBoundary } : {}),
    });
  }

  private syntheticInspectUserMessage(sessionId: SessionId, text: string): Message {
    const messageId = "msg_prompt_inspect_current_user" as MessageId;
    return {
      id: messageId,
      sessionId,
      role: "user",
      createdAt: this.now(),
      parts: [
        {
          id: "part_prompt_inspect_current_user" as PartId,
          messageId,
          sessionId,
          type: "text",
          text,
          synthetic: true,
        },
      ],
    };
  }

  private withFinalResponsePrompt(prompt: PromptAssembly): PromptAssembly {
    return new PromptAssembler()
      .addMany(prompt.fragments)
      .add({
        id: "runtime.final_response_after_max_turns",
        layer: "base",
        source: "runtime",
        priority: Number.MAX_SAFE_INTEGER,
        lifecycle: "turn",
        trust: "system",
        content: FINAL_RESPONSE_AFTER_MAX_TURNS_SYSTEM,
      })
      .assemble();
  }

  private contextBuilder(): ContextWindowBuilder {
    return this.options.contextBuilder ?? new ContextWindowBuilder(this.options.contextBudget);
  }

  private async resolvePromptModelState(input: SubmitPromptInput): Promise<RuntimeSessionModelState> {
    const state = await this.resolveSessionModelState(input.sessionId);
    if (input.modelSelection) state.modelSelection = normalizeModelSelection(input.modelSelection);
    if (input.reasoningLevel !== undefined) {
      if (!isReasoningLevel(input.reasoningLevel)) throw new Error(`Invalid reasoning level: ${input.reasoningLevel}`);
      state.reasoningLevel = input.reasoningLevel;
    }
    return state;
  }

  private async resolveSessionModelState(sessionId: SessionId): Promise<RuntimeSessionModelState> {
    const cached = this.sessionModelState.get(sessionId);
    if (cached) return cloneSessionModelState(cached);

    const state = await this.resolveGlobalModelState();
    const modelEvents = await this.options.store.events({
      sessionId,
      type: "session.model_changed",
      limit: 10_000,
    });
    for (const event of modelEvents) {
      if (event.type === "session.model_changed" && isModelSelectionPayload(event.payload)) {
        state.modelSelection = normalizeModelSelection(event.payload.modelSelection);
      }
    }

    const reasoningEvents = await this.options.store.events({
      sessionId,
      type: "session.reasoning_changed",
      limit: 10_000,
    });
    for (const event of reasoningEvents) {
      if (event.type === "session.reasoning_changed" && isReasoningPayload(event.payload)) {
        state.reasoningLevel = event.payload.reasoningLevel;
      }
    }

    this.sessionModelState.set(sessionId, cloneSessionModelState(state));
    return state;
  }

  private async resolveGlobalModelState(): Promise<RuntimeSessionModelState> {
    if (this.globalModelState) return cloneSessionModelState(this.globalModelState);

    const state = defaultSessionModelState(this.options);
    const modelEvents = await this.options.store.events({
      type: "session.model_changed",
      limit: 10_000,
    });
    for (const event of modelEvents) {
      if (event.type === "session.model_changed" && isModelSelectionPayload(event.payload)) {
        state.modelSelection = normalizeModelSelection(event.payload.modelSelection);
      }
    }

    const reasoningEvents = await this.options.store.events({
      type: "session.reasoning_changed",
      limit: 10_000,
    });
    for (const event of reasoningEvents) {
      if (event.type === "session.reasoning_changed" && isReasoningPayload(event.payload)) {
        state.reasoningLevel = event.payload.reasoningLevel;
      }
    }

    this.globalModelState = cloneSessionModelState(state);
    return cloneSessionModelState(state);
  }

  private async buildModelConfig(
    sessionId: SessionId,
    state: RuntimeSessionModelState,
  ): Promise<RuntimeModelConfig> {
    const config: RuntimeModelConfig = {
      sessionId,
      availableReasoningLevels: [...REASONING_LEVELS],
      models: await this.listModels(),
    };
    if (state.modelSelection) config.modelSelection = cloneModelSelection(state.modelSelection);
    if (state.reasoningLevel !== undefined) config.reasoningLevel = state.reasoningLevel;
    return config;
  }

  private async resolveModelCatalog(): Promise<readonly RuntimeModelDescriptor[]> {
    const source = this.options.models;
    if (typeof source === "function") return source();
    if (source) return source;
    const runtime = this.options.runtime as AgentRunner & { listModels?: RuntimeModelCatalogProvider };
    return runtime.listModels?.() ?? [];
  }

  async interrupt(sessionId: SessionId, reason = "user_interrupt"): Promise<boolean> {
    const controller = this.running.get(sessionId);
    if (!controller) return false;
    await this.publishStatus({ sessionId, status: "cancelling", reason });
    controller.abort();
    return true;
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.append({ sessionId }, "session.archived", { sessionId });
  }

  private async cancelledPrompt(
    input: SubmitPromptInput,
    turns: RunTurnResult[],
    reason: string,
  ): Promise<SubmitPromptResult> {
    const error = abortError(reason);
    await this.publishStatus({
      sessionId: input.sessionId,
      threadId: input.threadId,
      status: "cancelled",
      reason,
    });
    return {
      status: "cancelled",
      turns,
      error,
    };
  }

  private createRunController(input: SubmitPromptInput): AbortController {
    const controller = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) {
        controller.abort();
      } else {
        input.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    this.running.set(input.sessionId, controller);
    return controller;
  }

  private async publishStatus(input: {
    sessionId: SessionId;
    threadId?: ThreadId;
    status: RuntimeSessionStatus;
    turnId?: TurnId;
    reason?: string;
  }): Promise<void> {
    const payload: {
      sessionId: SessionId;
      status: RuntimeSessionStatus;
      turnId?: TurnId;
      reason?: string;
    } = {
      sessionId: input.sessionId,
      status: input.status,
    };
    if (input.turnId) payload.turnId = input.turnId;
    if (input.reason) payload.reason = input.reason;
    await this.append(input, "session.status_changed", payload);
  }

  private async append<TType extends ChiliEvent["type"], TPayload>(
    input: { sessionId: SessionId; threadId?: ThreadId },
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
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function turnContext(input: { text?: string; skillMentions?: readonly RuntimeSkillMention[] }): RuntimePromptTurnContext {
  const turn: RuntimePromptTurnContext = {
    text: input.text ?? "",
  };
  if (input.skillMentions && input.skillMentions.length > 0) turn.skillMentions = input.skillMentions;
  return turn;
}

function defaultSessionModelState(options: RuntimeServiceOptions): RuntimeSessionModelState {
  const state: RuntimeSessionModelState = {};
  if (options.defaultModelSelection) state.modelSelection = normalizeModelSelection(options.defaultModelSelection);
  if (options.defaultReasoningLevel !== undefined) {
    if (!isReasoningLevel(options.defaultReasoningLevel)) {
      throw new Error(`Invalid default reasoning level: ${options.defaultReasoningLevel}`);
    }
    state.reasoningLevel = options.defaultReasoningLevel;
  }
  return state;
}

function cloneSessionModelState(state: RuntimeSessionModelState): RuntimeSessionModelState {
  const clone: RuntimeSessionModelState = {};
  if (state.modelSelection) clone.modelSelection = cloneModelSelection(state.modelSelection);
  if (state.reasoningLevel !== undefined) clone.reasoningLevel = state.reasoningLevel;
  return clone;
}

function normalizeModelSelection(selection: ModelSelection): ModelSelection {
  const provider = typeof selection.provider === "string" ? selection.provider.trim() : "";
  const model = typeof selection.model === "string" ? selection.model.trim() : "";
  if (!provider || !model) throw new Error("Model selection requires provider and model");
  return { provider, model };
}

function cloneModelSelection(selection: ModelSelection): ModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
  };
}

function cloneModelDescriptor(model: RuntimeModelDescriptor): RuntimeModelDescriptor {
  const clone: RuntimeModelDescriptor = {
    provider: model.provider,
    model: model.model,
  };
  if (model.displayName !== undefined) clone.displayName = model.displayName;
  if (model.providerDisplayName !== undefined) clone.providerDisplayName = model.providerDisplayName;
  if (model.available !== undefined) clone.available = model.available;
  if (model.capabilities) clone.capabilities = { ...model.capabilities };
  if (model.inputCapabilities) clone.inputCapabilities = [...model.inputCapabilities];
  if (model.contextWindowTokens !== undefined) clone.contextWindowTokens = model.contextWindowTokens;
  if (model.maxOutputTokens !== undefined) clone.maxOutputTokens = model.maxOutputTokens;
  if (model.default !== undefined) clone.default = model.default;
  return clone;
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

function isModelSelectionPayload(payload: unknown): payload is { modelSelection: ModelSelection } {
  return isRecord(payload) && isRecord(payload.modelSelection) && typeof payload.modelSelection.provider === "string" && typeof payload.modelSelection.model === "string";
}

function isReasoningPayload(payload: unknown): payload is { reasoningLevel: ReasoningLevel } {
  return isRecord(payload) && isReasoningLevel(payload.reasoningLevel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

function isToolUseFinishReason(reason: string | undefined): boolean {
  return reason === "tool_use" || reason === "tool_calls" || reason === "function_call";
}
