import type {
  ApprovalDecision,
  ApprovalId,
  ApprovalScope,
  ChiliEvent,
  EventEnvelope,
  SessionId,
  TimestampMs,
  ToolCallId,
  ToolMetadataUpdate,
  ToolOutputUpdate,
  ToolResult,
  TurnId,
} from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import { randomUUID } from "node:crypto";
import { ToolDeniedError, ToolValidationError, UnknownToolError, isAbortError, toError } from "./errors.js";
import { approvalDecisionWithinScope } from "./approval.js";
import { FileReadStateStore } from "./file-read-state.js";
import { authorizeToolByPolicy, filterToolsByPolicy, toolPolicyContext } from "./tool-policy.js";
import {
  persistToolOutput,
  truncateUtf8,
  validatePersistedToolOutput,
  type PersistedOutput,
} from "./tool-output-storage.js";
import type {
  ChiliToolDefinition,
  ChiliToolExecutionContext,
  ExecuteToolInput,
  ExecuteToolResult,
  ApprovalPreflightDecision,
  SnapshotRecord,
  ToolAccessPolicy,
  ToolApprovalSpecWithDefaults,
  ToolExecutorOptions,
  PersistedToolOutputRegistration,
} from "./types.js";

type ExecutableApprovalSpec = ToolApprovalSpecWithDefaults & { maxApprovalScope: ApprovalScope };

export class ToolExecutor {
  private readonly fileReads: FileReadStateStore;
  private readonly activeCallIds = new Set<string>();

  constructor(private readonly options: ToolExecutorOptions) {
    this.fileReads = options.fileReadState ?? new FileReadStateStore();
  }

  async execute(input: ExecuteToolInput): Promise<ExecuteToolResult> {
    const callId = input.callId ?? this.id<ToolCallId>("toolcall");
    const outputArtifactId = `tooloutput_${randomUUID()}` as ToolCallId;
    const activeCallKey = [input.cwd, input.sessionId, input.turnId, callId].join("\0");
    const tool = this.options.registry.get(input.toolName);

    await this.publish("tool.call_started", input, {
      turnId: input.turnId,
      callId,
      toolName: input.toolName,
      input: input.input,
    });

    if (this.activeCallIds.has(activeCallKey)) {
      return this.fail(input, callId, new Error(`Tool call id is already active: ${callId}`));
    }
    this.activeCallIds.add(activeCallKey);

    try {
      if (!tool) {
        return await this.fail(input, callId, new UnknownToolError(input.toolName));
      }
      try {
        await this.update(input, callId, "validating");
        const validated = await this.validate(tool, input.input);
        const spec = this.approvalSpec(tool, validated);
        for (const policy of await this.policies(input)) {
          await authorizeToolByPolicy({
            tool,
            executeInput: input,
            validatedInput: validated,
            approvalSpec: spec === false
              ? { permission: tool.name, patterns: ["*"], maxApprovalScope: "persistent", metadata: {} }
              : spec,
            policy,
            isReadOnly: (definition, toolInput) => this.resolvePredicate(definition.isReadOnly, toolInput),
          });
        }

        const approval = await this.requestLifecycleApproval(tool, input, callId, spec);
        if (!isApprovalDecisionAction(approval.action)) {
          throw new ToolDeniedError(tool.name, `Invalid approval decision action: ${String(approval.action)}`);
        }
        if (approval.action === "deny") {
          throw new ToolDeniedError(tool.name, approval.feedback);
        }

        await this.createSnapshotIfNeeded(tool, input, callId, validated, spec);

        await this.update(input, callId, "running");
        let registeredOutput: PersistedOutput | undefined;
        let invalidRegisteredOutputError: Error | undefined;
        let outputRegistrationClaimed = false;
        const registerPersistedOutput = async (registration: PersistedToolOutputRegistration): Promise<void> => {
          if (outputRegistrationClaimed) {
            throw new Error("Tool output sidecar has already been registered for this call");
          }
          outputRegistrationClaimed = true;
          try {
            registeredOutput = await validatePersistedToolOutput(
              input.cwd,
              outputArtifactId,
              registration,
              this.persistedOutputOptions(),
            );
          } catch (error) {
            invalidRegisteredOutputError = toError(error);
            throw error;
          }
        };
        const rawResult = await tool.execute(
          validated,
          this.context(tool, validated, input, callId, outputArtifactId, registerPersistedOutput),
        );
        if (registeredOutput) {
          try {
            registeredOutput = await validatePersistedToolOutput(
              input.cwd,
              outputArtifactId,
              registeredOutput,
              this.persistedOutputOptions(),
            );
          } catch (error) {
            invalidRegisteredOutputError = toError(error);
            registeredOutput = undefined;
          }
        }
        const result = await this.processResult(
          tool,
          input,
          outputArtifactId,
          rawResult,
          registeredOutput,
          invalidRegisteredOutputError,
        );

        await this.publish("tool.call_finished", input, {
          callId,
          status: "completed",
          output: result.output,
        });

        return { status: "completed", callId, result };
      } catch (error) {
        if (isAbortError(error)) {
          return this.cancel(input, callId, toError(error));
        }
        return this.fail(input, callId, toError(error));
      }
    } finally {
      this.activeCallIds.delete(activeCallKey);
    }
  }

  async canRunConcurrently(toolName: string, input: unknown): Promise<boolean> {
    const tool = this.options.registry.get(toolName);
    if (!tool) return false;
    const explicit = await this.resolvePredicate(tool.isConcurrencySafe, input);
    if (explicit !== undefined) return explicit;
    return (await this.resolvePredicate(tool.isReadOnly, input)) ?? false;
  }

  private async validate<Input>(tool: ChiliToolDefinition<Input>, input: unknown): Promise<Input> {
    if (!tool.validate) return input as Input;
    const result = await tool.validate(input);
    if (!result.ok) throw new ToolValidationError(tool.name, result.message);
    return result.value;
  }

  private async requestLifecycleApproval<Input>(
    tool: ChiliToolDefinition<Input>,
    input: ExecuteToolInput,
    callId: ToolCallId,
    spec: false | ExecutableApprovalSpec,
  ): Promise<ApprovalDecision> {
    if (spec === false) return { action: "allow_once" };

    const preflight = await this.preflightApproval(input, callId, tool, spec);
    if (preflight.action === "allow") return { action: "allow_once" };
    if (preflight.action === "deny") return denyDecision(preflight);

    await this.update(input, callId, "waiting_for_approval");
    return this.createApprovalRequest(input, callId, tool, spec, preflight);
  }

  private approvalSpec<Input>(tool: ChiliToolDefinition<Input>, input: Input): false | ExecutableApprovalSpec {
    const spec = tool.approval ? tool.approval(input) : { patterns: ["*"] };
    if (spec === false) return false;
    return validateApprovalSpec(tool.name, {
      permission: spec.permission ?? tool.name,
      patterns: spec.patterns,
      maxApprovalScope: spec.maxApprovalScope ?? "persistent",
      metadata: spec.metadata ?? {},
    });
  }

  private async createSnapshotIfNeeded<Input>(
    tool: ChiliToolDefinition<Input>,
    input: ExecuteToolInput,
    callId: ToolCallId,
    validated: Input,
    spec: false | ExecutableApprovalSpec,
  ): Promise<SnapshotRecord | undefined> {
    if (spec === false) return undefined;
    if (!this.options.snapshotProvider) return undefined;

    const shouldSnapshot = this.options.snapshotPolicy
      ? this.options.snapshotPolicy({ tool, spec })
      : tool.risk === "write" || tool.risk === "dangerous";
    if (!shouldSnapshot) return undefined;

    const snapshot = await this.createSnapshot(tool, input, callId, spec);
    if (!snapshot) return undefined;

    await this.publish("snapshot.created", input, {
      snapshotId: snapshot.id,
      callId,
      toolName: tool.name,
      paths: snapshot.paths,
      reason: `before ${tool.name}`,
    });
    await this.metadata(input, callId, {
      metadata: {
        snapshotId: snapshot.id,
        snapshotPaths: snapshot.paths,
      },
    });
    return snapshot;
  }

  private async createSnapshot<Input>(
    tool: ChiliToolDefinition<Input>,
    input: ExecuteToolInput,
    callId: ToolCallId,
    spec: ExecutableApprovalSpec,
  ): Promise<SnapshotRecord | undefined> {
    try {
      return await this.options.snapshotProvider?.create({
        cwd: input.cwd,
        sessionId: input.sessionId,
        callId,
        toolName: tool.name,
        patterns: spec.patterns,
        reason: `before ${tool.name}`,
        metadata: spec.metadata,
      });
    } catch (error) {
      const err = toError(error);
      await this.metadata(input, callId, {
        metadata: {
          snapshotError: err.message,
        },
      });
      throw new Error(`Snapshot failed before ${tool.name}; refusing to run tool: ${err.message}`);
    }
  }

  private async processResult(
    tool: ChiliToolDefinition,
    input: ExecuteToolInput,
    outputArtifactId: ToolCallId,
    result: ToolResult,
    registeredOutput?: PersistedOutput,
    invalidRegisteredOutputError?: Error,
  ): Promise<ToolResult> {
    const normalizedResult = withRegisteredOutput(stripUntrustedOutputPathMetadata(result), registeredOutput);
    const maxBytes = tool.maxResultOutputBytes ?? this.options.maxResultOutputBytes ?? 256_000;
    const truncated = truncateUtf8(normalizedResult.output, maxBytes);
    if (invalidRegisteredOutputError) {
      const unavailable = `registered output artifact unavailable: ${invalidRegisteredOutputError.message}`;
      return {
        ...normalizedResult,
        output: truncated.truncated
          ? `${truncated.text}\n[tool output truncated after ${maxBytes} bytes; ${unavailable}]`
          : `${normalizedResult.output}${normalizedResult.output ? "\n" : ""}[${unavailable}]`,
        metadata: {
          ...normalizedResult.metadata,
          ...(truncated.truncated
            ? {
                outputTruncated: true,
                outputBytes: truncated.bytes,
                outputLimitBytes: maxBytes,
              }
            : {}),
          outputPersistenceError: invalidRegisteredOutputError.message,
        },
      };
    }
    if (!truncated.truncated) {
      return registeredOutput
        ? appendRegisteredOutputNotice(normalizedResult, registeredOutput)
        : normalizedResult;
    }

    if (registeredOutput) {
      const savedDescription = registeredOutput.truncated
        ? `first ${registeredOutput.bytes} of ${registeredOutput.originalBytes} bytes saved to ${registeredOutput.relativePath}`
        : `full output saved to ${registeredOutput.relativePath}`;
      return {
        ...normalizedResult,
        output: `${truncated.text}\n[tool output truncated after ${maxBytes} bytes; ${savedDescription}]`,
        metadata: {
          ...normalizedResult.metadata,
          outputTruncated: true,
          outputBytes: registeredOutput.originalBytes,
          outputLimitBytes: maxBytes,
        },
      };
    }

    let persisted: PersistedOutput;
    try {
      persisted = await this.persistLargeOutput(input.cwd, outputArtifactId, normalizedResult.output);
    } catch (error) {
      const persistenceError = toError(error);
      return {
        ...normalizedResult,
        output: `${truncated.text}\n[tool output truncated after ${maxBytes} bytes; remaining output could not be safely persisted]`,
        metadata: {
          ...normalizedResult.metadata,
          outputTruncated: true,
          outputBytes: truncated.bytes,
          outputLimitBytes: maxBytes,
          outputPersistenceError: persistenceError.message,
        },
      };
    }
    const savedDescription = persisted.truncated
      ? `first ${persisted.bytes} of ${persisted.originalBytes} bytes saved to ${persisted.relativePath}`
      : `full output saved to ${persisted.relativePath}`;

    return {
      ...normalizedResult,
      output: `${truncated.text}\n[tool output truncated after ${maxBytes} bytes; ${savedDescription}]`,
      metadata: {
        ...normalizedResult.metadata,
        outputTruncated: true,
        outputBytes: truncated.bytes,
        outputLimitBytes: maxBytes,
        outputPath: persisted.relativePath,
        outputPersistedBytes: persisted.bytes,
        outputPersistedLimitBytes: persisted.limitBytes,
        outputPersistedTruncated: persisted.truncated,
      },
    };
  }

  private context<Input>(
    tool: ChiliToolDefinition<Input>,
    validatedInput: Input,
    input: ExecuteToolInput,
    callId: ToolCallId,
    outputArtifactId: ToolCallId,
    registerPersistedOutput: (output: PersistedToolOutputRegistration) => Promise<void>,
  ): ChiliToolExecutionContext {
    let outputSequence = 0;
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      callId,
      outputArtifactId,
      signal: input.signal ?? new AbortController().signal,
      cwd: input.cwd,
      fileReads: this.fileReads,
      visibleTools: () => this.visibleTools(input),
      persistedOutputLimits: {
        ...(this.options.maxPersistedOutputBytes !== undefined
          ? { maxBytes: this.options.maxPersistedOutputBytes }
          : {}),
        ...(this.options.maxPersistedOutputDirectoryBytes !== undefined
          ? { maxDirectoryBytes: this.options.maxPersistedOutputDirectoryBytes }
          : {}),
      },
      registerPersistedOutput,
      metadata: (update) => this.metadata(input, callId, update),
      streamOutput: (update) => {
        outputSequence += 1;
        return this.streamOutput(input, callId, outputSequence, update);
      },
      requestApproval: async (request) => {
        const spec = validateApprovalSpec(tool.name, {
          permission: request.permission,
          patterns: request.patterns,
          maxApprovalScope: request.maxApprovalScope ?? "persistent",
          metadata: request.metadata ?? {},
        });
        for (const policy of await this.policies(input)) {
          await authorizeToolByPolicy({
            tool,
            executeInput: input,
            validatedInput,
            approvalSpec: spec,
            policy,
            isReadOnly: (definition, toolInput) => this.resolvePredicate(definition.isReadOnly, toolInput),
          });
        }
        return this.approveOrRequest(input, callId, tool, spec);
      },
    };
  }

  private async approveOrRequest(
    input: ExecuteToolInput,
    callId: ToolCallId,
    tool: ChiliToolDefinition,
    spec: ExecutableApprovalSpec,
  ): Promise<ApprovalDecision> {
    const preflight = await this.preflightApproval(input, callId, tool, spec);
    if (preflight.action === "allow") return { action: "allow_once" };
    if (preflight.action === "deny") return denyDecision(preflight);
    return this.createApprovalRequest(input, callId, tool, spec, preflight);
  }

  private async createApprovalRequest(
    input: ExecuteToolInput,
    callId: ToolCallId,
    tool: ChiliToolDefinition,
    spec: ExecutableApprovalSpec,
    preflight?: ApprovalPreflightDecision,
  ): Promise<ApprovalDecision> {
    const approvalId = this.id<ApprovalId>("approval");

    await this.publish("approval.requested", input, {
      approvalId,
      callId,
      permission: spec.permission,
      patterns: spec.patterns,
      maxApprovalScope: spec.maxApprovalScope,
      ...metadataPayload(approvalRequestMetadata(spec, preflight)),
    });

    let rawDecision: ApprovalDecision;
    try {
      rawDecision = await withAbort(this.options.approvals.decide({
        approvalId,
        sessionId: input.sessionId,
        callId,
        toolName: tool.name,
        risk: tool.risk,
        permission: spec.permission,
        patterns: spec.patterns,
        maxApprovalScope: spec.maxApprovalScope,
        metadata: spec.metadata,
      }, input.signal), input.signal);
      throwIfAborted(input.signal);
    } catch (error) {
      if (input.signal?.aborted || isAbortError(error)) {
        await this.publish("approval.resolved", input, {
          approvalId,
          decision: "deny",
          feedback: "Approval cancelled because tool execution was aborted.",
        });
      }
      throw error;
    }
    const decision = normalizeApprovalDecision(rawDecision, spec.maxApprovalScope);

    await this.publish("approval.resolved", input, {
      approvalId,
      decision: decision.action,
      ...(decision.feedback ? { feedback: decision.feedback } : {}),
    });

    return decision;
  }

  private async preflightApproval(
    input: ExecuteToolInput,
    callId: ToolCallId,
    tool: ChiliToolDefinition,
    spec: ExecutableApprovalSpec,
  ): Promise<ApprovalPreflightDecision> {
    if (!this.options.approvals.preflight) {
      return {
        action: "ask",
        source: "approval_broker",
        reason: "Approval broker does not support preflight.",
        metadata: {
          permission: spec.permission,
          patterns: spec.patterns,
        },
      };
    }
    return this.options.approvals.preflight({
      sessionId: input.sessionId,
      callId,
      toolName: tool.name,
      risk: tool.risk,
      permission: spec.permission,
      patterns: spec.patterns,
      maxApprovalScope: spec.maxApprovalScope,
      metadata: spec.metadata,
    });
  }

  private async metadata(input: ExecuteToolInput, callId: ToolCallId, update: ToolMetadataUpdate): Promise<void> {
    await this.publish("tool.call_updated", input, {
      callId,
      status: update.status ?? "running",
      ...(update.metadata ? { metadata: update.metadata } : {}),
    });
  }

  private async streamOutput(
    input: ExecuteToolInput,
    callId: ToolCallId,
    sequence: number,
    update: ToolOutputUpdate,
  ): Promise<void> {
    if (!update.delta) return;
    await this.publish("tool.output_delta", input, {
      callId,
      stream: update.stream,
      delta: update.delta,
      ...(update.bytes === undefined ? {} : { bytes: update.bytes }),
      ...(update.truncated === undefined ? {} : { truncated: update.truncated }),
      sequence,
    });
  }

  private async visibleTools(input: ExecuteToolInput): Promise<ChiliToolDefinition[]> {
    const policies = await this.policies(input);
    return policies.reduce(
      (tools, policy) => filterToolsByPolicy(tools, policy),
      this.options.registry.list(),
    );
  }

  private async policies(input: ExecuteToolInput): Promise<ToolAccessPolicy[]> {
    const policies: ToolAccessPolicy[] = [];
    if (input.policy) policies.push(input.policy);
    const resolved = await this.options.policyResolver?.resolve(toolPolicyContext(input));
    if (resolved) policies.push(resolved);
    return policies;
  }

  private async update(
    input: ExecuteToolInput,
    callId: ToolCallId,
    status: "validating" | "waiting_for_approval" | "running",
  ): Promise<void> {
    await this.publish("tool.call_updated", input, { callId, status });
  }

  private async fail(input: ExecuteToolInput, callId: ToolCallId, error: Error): Promise<ExecuteToolResult> {
    await this.publish("tool.call_finished", input, {
      callId,
      status: "failed",
      error: error.message,
      synthetic: true,
    });
    return { status: "failed", callId, error };
  }

  private async cancel(input: ExecuteToolInput, callId: ToolCallId, error: Error): Promise<ExecuteToolResult> {
    await this.publish("tool.call_finished", input, {
      callId,
      status: "cancelled",
      error: error.message,
      synthetic: true,
    });
    return { status: "cancelled", callId, error };
  }

  private async publish<TType extends ChiliEvent["type"], TPayload>(
    type: TType,
    input: ExecuteToolInput,
    payload: TPayload,
  ): Promise<void> {
    const event: EventEnvelope<TType, TPayload> = {
      id: this.id("event"),
      type,
      time: this.now(),
      sessionId: input.sessionId,
      payload,
    };
    await this.options.events.publish(event as ChiliEvent);
  }

  private id<T extends string>(prefix: string): T {
    const create = this.options.createId ?? defaultCreateId;
    return create(prefix) as T;
  }

  private now(): TimestampMs {
    return this.options.now ? this.options.now() : timestampNow();
  }

  private async resolvePredicate<Input>(
    predicate: ChiliToolDefinition<Input>["isConcurrencySafe"],
    input: unknown,
  ): Promise<boolean | undefined> {
    if (predicate === undefined) return undefined;
    if (typeof predicate === "boolean") return predicate;
    return predicate(input as Input);
  }

  private async persistLargeOutput(
    cwd: string,
    callId: ToolCallId,
    output: string,
  ): Promise<PersistedOutput> {
    return persistToolOutput(cwd, callId, output, this.persistedOutputOptions());
  }

  private persistedOutputOptions(): {
    maxBytes?: number;
    maxDirectoryBytes?: number;
  } {
    return {
      ...(this.options.maxPersistedOutputBytes !== undefined
        ? { maxBytes: this.options.maxPersistedOutputBytes }
        : {}),
      ...(this.options.maxPersistedOutputDirectoryBytes !== undefined
        ? { maxDirectoryBytes: this.options.maxPersistedOutputDirectoryBytes }
        : {}),
    };
  }
}

function approvalRequestMetadata(
  spec: ExecutableApprovalSpec,
  preflight: ApprovalPreflightDecision | undefined,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = { ...spec.metadata };
  if (preflight) {
    metadata.preflightDecision = preflight;
    if (preflight.reason) metadata.reason = preflight.reason;
    if (preflight.feedback) metadata.feedback = preflight.feedback;
    metadata.source = preflight.source;
    if (preflight.matchedRule) metadata.matchedRule = preflight.matchedRule;
    if (preflight.suggestions) metadata.suggestions = preflight.suggestions;
    if (preflight.metadata) {
      for (const key of ["patternDecisions", "risks", "approvalRisks"] as const) {
        if (preflight.metadata[key] !== undefined) metadata[key] = preflight.metadata[key];
      }
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function metadataPayload(metadata: Record<string, unknown> | undefined): { metadata?: Record<string, unknown> } {
  return metadata ? { metadata } : {};
}

function validateApprovalSpec(toolName: string, spec: ExecutableApprovalSpec): ExecutableApprovalSpec {
  if (!Array.isArray(spec.patterns) || spec.patterns.length === 0) {
    throw new ToolValidationError(toolName, "Approval spec must include at least one pattern.");
  }
  const invalidIndex = spec.patterns.findIndex((pattern) => typeof pattern !== "string" || pattern.trim().length === 0);
  if (invalidIndex >= 0) {
    throw new ToolValidationError(toolName, `Approval spec pattern at index ${invalidIndex} must be a non-empty string.`);
  }
  if (!isApprovalScope(spec.maxApprovalScope)) {
    throw new ToolValidationError(toolName, `Invalid maximum approval scope: ${String(spec.maxApprovalScope)}`);
  }
  return spec;
}

function isApprovalDecisionAction(action: unknown): action is ApprovalDecision["action"] {
  return action === "allow_once" || action === "allow_session" || action === "allow_always" || action === "deny";
}

function normalizeApprovalDecision(decision: ApprovalDecision, maxApprovalScope: ApprovalScope): ApprovalDecision {
  const action = (decision as { action?: unknown } | null | undefined)?.action;
  if (isApprovalDecisionAction(action)) {
    if (approvalDecisionWithinScope(action, maxApprovalScope)) return decision;
    return {
      action: "deny",
      feedback: `Approval decision ${action} exceeds the maximum approval scope ${maxApprovalScope}.`,
    };
  }
  return { action: "deny", feedback: `Invalid approval decision action: ${String(action)}` };
}

function isApprovalScope(scope: unknown): scope is ApprovalScope {
  return scope === "once" || scope === "session" || scope === "persistent";
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortReason(signal);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Tool execution aborted");
  error.name = "AbortError";
  return error;
}

function stripUntrustedOutputPathMetadata(result: ToolResult): ToolResult {
  if (!result.metadata) return result;
  const metadata = { ...result.metadata };
  delete metadata.outputPath;
  delete metadata.outputPersistedBytes;
  delete metadata.outputPersistedLimitBytes;
  delete metadata.outputPersistedTruncated;
  return { ...result, metadata };
}

function withRegisteredOutput(
  result: ToolResult,
  registeredOutput: PersistedOutput | undefined,
): ToolResult {
  if (!registeredOutput) return result;
  return {
    ...result,
    metadata: {
      ...result.metadata,
      outputPath: registeredOutput.relativePath,
      outputPersistedBytes: registeredOutput.bytes,
      outputPersistedLimitBytes: registeredOutput.limitBytes,
      outputPersistedTruncated: registeredOutput.truncated,
    },
  };
}

function appendRegisteredOutputNotice(
  result: ToolResult,
  registeredOutput: PersistedOutput,
): ToolResult {
  const savedDescription = registeredOutput.truncated
    ? `first ${registeredOutput.bytes} of ${registeredOutput.originalBytes} bytes saved to ${registeredOutput.relativePath}`
    : `full output saved to ${registeredOutput.relativePath}`;
  return {
    ...result,
    output: `${result.output}${result.output ? "\n" : ""}[${savedDescription}]`,
  };
}

function denyDecision(decision: ApprovalPreflightDecision): ApprovalDecision {
  const feedback = decision.feedback ?? decision.reason;
  return feedback ? { action: "deny", feedback } : { action: "deny" };
}
