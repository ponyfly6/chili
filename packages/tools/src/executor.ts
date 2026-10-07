import type {
  RuntimeEvent,
  EventEnvelope,
  SessionId,
  TimestampMs,
  ToolCallId,
  ToolMetadataUpdate,
  ToolOutputUpdate,
  ToolResult,
  ToolResultContent,
  TurnId,
} from "@chili/protocol";
import {
  boundPersistedJsonValue,
  normalizeToolCallId,
  PERSISTED_JSON_LIMITS,
  timestampNow,
} from "@chili/protocol";
import { randomUUID } from "node:crypto";
import { ToolDeniedError, ToolValidationError, UnknownToolError, isAbortError, toError } from "./errors.js";
import { validateToolSchema } from "./input-schema.js";
import { canonicalToolResources } from "./resource-policy.js";
import { validateStructuredToolData } from "./structured-data.js";
import { FileReadStateStore } from "./file-read-state.js";
import { ToolDispatchScope } from "./dispatch-scope.js";
import { authorizeToolByPolicy, filterToolsByPolicy, executionPolicyFor, toolPolicyContext } from "./tool-policy.js";
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
  SnapshotRecord,
  ToolAccessPolicy,
  ToolResourceSpecWithDefaults,
  ToolReviewRequest,
  ToolReviewResult,
  ToolLifecycleContext,
  ToolLifecycleOutcome,
  ToolLifecyclePhase,
  ToolExecutorOptions,
  PersistedToolOutputRegistration,
  ToolRegistryContext,
  PreparedToolCall,
} from "./types.js";

type ExecutableResourceSpec = ToolResourceSpecWithDefaults;

interface ToolLifecycleState {
  context: ToolLifecycleContext;
  phase: ToolLifecyclePhase;
  status: ToolLifecycleOutcome["status"];
  handlerEntered: boolean;
  executionSucceeded: boolean;
  result?: ToolResult;
  canonicalResult?: ToolResult;
  error?: Error;
  resultProcessingError?: Error;
}

const MAX_TOOL_RESULT_CONTENT_ITEMS = 64;
// The desktop outbox admits at most 2,000,000 bytes for one retained envelope.
// Content is measured as serialized JSON and leaves 750 KB for worst-case JSON
// escaping of the output preview, artifact ids, execution context, and the
// DesktopEventEnvelope. This also leaves ample room in the 4 MB session replay
// response for its required message anchor, 1 MB of approvals, and metadata.
const MAX_DESKTOP_EVENT_ENVELOPE_BYTES = 2_000_000;
const MAX_TOOL_RESULT_EVENT_FIELDS_RESERVE_BYTES = 750_000;
const MAX_TOOL_RESULT_CONTENT_TOTAL_BYTES =
  MAX_DESKTOP_EVENT_ENVELOPE_BYTES - MAX_TOOL_RESULT_EVENT_FIELDS_RESERVE_BYTES;
const MAX_TOOL_RESULT_CONTENT_ITEM_BYTES = MAX_TOOL_RESULT_CONTENT_TOTAL_BYTES;
const MAX_TOOL_RESULT_METADATA_BYTES = 512_000;
const MAX_TOOL_RESULT_METADATA_STRING_BYTES = 128_000;
const MAX_TOOL_RESULT_METADATA_ITEMS = 128;
const MAX_TOOL_RESULT_METADATA_DEPTH = 12;
const MAX_TOOL_RESULT_METADATA_NODES = 2_048;
const MAX_TOOL_RESULT_TITLE_BYTES = 8_192;
// Keep the complete ToolResult comfortably below the desktop's 12 MiB serialized
// event limit even when every output character requires JSON escaping.
const MAX_TOOL_RESULT_OUTPUT_PREVIEW_BYTES = 256_000;
const MAX_TOOL_RESULT_WIRE_OUTPUT_BYTES = 280_000;
const MAX_TOOL_RESULT_ARTIFACT_ID_CHARS = 512;
const MAX_TOOL_RESULT_ARTIFACT_IDS_BYTES = 64_000;
const MAX_TOOL_RESULT_ARTIFACT_IDS_SCAN = 256;
const MAX_TOOL_STREAM_DELTA_BYTES = 256_000;
const MAX_TOOL_STREAM_TOTAL_BYTES = 4_000_000;
const MAX_RESOURCE_PERMISSION_BYTES = 512;
const MAX_RESOURCE_PATTERNS = 64;
const MAX_RESOURCE_PATTERN_BYTES = 8_192;
const MAX_RESOURCE_PATTERNS_BYTES = 64_000;

export class ToolExecutor {
  private readonly fileReads: FileReadStateStore;
  private readonly preparedCalls = new WeakMap<PreparedToolCall, {
    tool: ChiliToolDefinition;
    context: string;
    fingerprint: string;
    spec: false | ExecutableResourceSpec;
    originalSpec: false | ExecutableResourceSpec;
  }>();
  private readonly activeCallIds = new Set<string>();
  private readonly eventPublishFailures = new WeakSet<object>();

  constructor(private readonly options: ToolExecutorOptions) {
    this.fileReads = options.fileReadState ?? new FileReadStateStore();
  }

  async execute(input: ExecuteToolInput): Promise<ExecuteToolResult> {
    const dispatchScope = input.dispatchScope ?? new ToolDispatchScope();
    dispatchScope.throwIfFailed();
    const signal = AbortSignal.any(input.signal ? [input.signal, dispatchScope.signal] : [dispatchScope.signal]);
    const scopedInput = { ...input, dispatchScope, signal };
    return this.options.executionContext
      ? this.options.executionContext(() => this.executeOwned(scopedInput))
      : this.executeOwned(scopedInput);
  }

  private async executeOwned(input: ExecuteToolInput): Promise<ExecuteToolResult> {
    const callId = input.callId === undefined
      ? this.id<ToolCallId>("toolcall")
      : normalizeToolCallId(input.callId);
    const outputArtifactId = `tooloutput_${randomUUID()}` as ToolCallId;
    const activeCallKey = [input.cwd, input.sessionId, input.turnId, callId].join("\0");
    const startedAt = this.now();
    const attemptedInput = boundToolEventValue(input.input, "tool input");
    const lifecycle: ToolLifecycleState = {
      context: Object.freeze({
        sessionId: input.sessionId, turnId: input.turnId, callId,
        ...(input.providerCallId === undefined ? {} : { providerCallId: input.providerCallId }),
        ...(input.parentCallId === undefined ? {} : { parentCallId: input.parentCallId }),
        toolName: input.toolName, cwd: input.cwd, input: freezePreparedValue(attemptedInput),
        invocationMode: input.parentCallId ? "code" : "direct", prepared: false,
      }),
      phase: "starting", status: "failed", handlerEntered: false, executionSucceeded: false,
    };
    let ownsCallId = false;
    let release: (() => void) | undefined;

    try {
      // Lifecycle accounting starts at the attempted durable-start boundary, even
      // when audit storage itself fails and execution must fail closed.
      await this.publish("tool.call_started", input, {
        turnId: input.turnId,
        callId,
        ...(input.providerCallId === undefined ? {} : { providerCallId: input.providerCallId }),
        ...(input.parentCallId === undefined ? {} : { parentCallId: input.parentCallId }),
        toolName: boundToolEventName(input.toolName),
        input: attemptedInput,
      });
      if (this.activeCallIds.has(activeCallKey)) {
        const error = new Error(`Tool call id is already active: ${callId}`);
        lifecycle.error = toError(error);
        return await this.fail(input, callId, error);
      }
      this.activeCallIds.add(activeCallKey);
      ownsCallId = true;
      if (input.signal?.aborted) {
        lifecycle.status = "cancelled";
        lifecycle.error = abortReason(input.signal);
        return await this.cancel(input, callId, lifecycle.error);
      }
      try {
        lifecycle.phase = "validating";
        if (input.parentCallId) await input.dispatchScope?.checkNestedCall({ toolName: input.toolName, input: input.input });
        const prepared = input.prepared ?? await this.prepare(input);
        await this.update(input, callId, "validating");
        const details = this.preparedCalls.get(prepared);
        if (!details || details.context !== preparationContext(input)) {
          throw new ToolValidationError(input.toolName, "Prepared call does not belong to this execution context.");
        }
        const { tool, spec } = details;
        const validated = prepared.validatedInput;
        lifecycle.context = Object.freeze({
          ...lifecycle.context, toolName: tool.name, toolDescription: tool.description,
          risk: tool.risk, input: validated, prepared: true,
          ...(spec === false ? {} : { resources: freezePreparedValue(spec) as ToolResourceSpecWithDefaults }),
        });
        lifecycle.phase = "authorizing";
        if (input.parentCallId && (tool.codeMode !== true || tool.isOrchestrator)) {
          throw new ToolDeniedError(tool.name, "Tool is not available to code mode.");
        }
        if (!tool.isOrchestrator) {
          release = await input.dispatchScope!.acquire(prepared.isConcurrencySafe, input.signal);
        }
        await this.assertPreparedCurrent(prepared, input);
        const workerAuthorization = await this.authorizeWorkerPolicy(tool, validated, input, spec);
        const { executionPolicy, callerToolPolicy } = workerAuthorization;

        lifecycle.phase = "reviewing";
        const review = await this.review(tool, validated, input, callId, spec);
        const assertCurrentAuthorization = () => this.assertExecutionAuthorized(
          prepared, input, review, workerAuthorization,
        );
        lifecycle.phase = "snapshotting";
        await this.createSnapshotIfNeeded(tool, input, callId, validated, spec, assertCurrentAuthorization);
        throwIfAborted(input.signal);
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
        const context = this.context(tool, validated, input, callId, outputArtifactId, registerPersistedOutput,
          executionPolicy, assertCurrentAuthorization, callerToolPolicy);
        // No lifecycle event or policy preparation may await after this final check.
        lifecycle.phase = "authorizing";
        await context.assertCurrentAuthorization?.();
        lifecycle.phase = "executing";
        lifecycle.handlerEntered = true;
        const rawResult = await tool.execute(validated, context);
        lifecycle.executionSucceeded = true;
        lifecycle.phase = "processing_result";
        input.dispatchScope?.throwIfFailed();
        throwIfAborted(input.signal);
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
        const descriptor = Object.getOwnPropertyDescriptor(rawResult, "structuredData");
        if (descriptor && !("value" in descriptor)) throw new Error("Tool structured data cannot contain accessors.");
        const programResult = descriptor?.value === undefined ? rawResult : {
          ...boundToolResult(rawResult), structuredData: validateStructuredToolData(descriptor.value),
        };
        const canonicalResult = boundToolResult(await this.processResult(
          tool,
          input,
          outputArtifactId,
          programResult,
          registeredOutput,
          invalidRegisteredOutputError,
        ));
        lifecycle.result = canonicalResult;
        lifecycle.canonicalResult = canonicalResult;
        const result = await this.processLifecycleResult(tool, lifecycle, canonicalResult, input.signal!);
        lifecycle.result = result;

        throwIfAborted(input.signal);
        lifecycle.phase = "publishing_result";
        await this.publish("tool.call_finished", input, {
          callId,
          ...(input.providerCallId === undefined ? {} : { providerCallId: input.providerCallId }),
          status: "completed",
          output: canonicalResult.output,
        });

        lifecycle.status = "completed";
        lifecycle.phase = "completed";
        return { status: "completed", callId, result };
      } catch (error) {
        if (this.isEventPublishFailure(error)) throw error;
        input.dispatchScope?.throwIfFailed();
        const normalizedError = input.signal?.aborted
          ? abortReason(input.signal)
          : toError(error);
        lifecycle.error = normalizedError;
        if (lifecycle.phase === "processing_result" && lifecycle.executionSucceeded) {
          lifecycle.resultProcessingError ??= normalizedError;
        }
        if (input.signal?.aborted || isAbortError(normalizedError)) {
          lifecycle.status = "cancelled";
          return await this.cancel(input, callId, normalizedError);
        }
        lifecycle.status = normalizedError.name === "ToolDeniedError" ? "blocked" : "failed";
        return await this.fail(input, callId, normalizedError);
      }
    } catch (error) {
      // Audit failures escape the ordinary tool-result path and retain their
      // original failure even though they also abort the dispatch scope.
      lifecycle.error = toError(error);
      lifecycle.status = isAbortError(error) ? "cancelled" : "failed";
      throw error;
    } finally {
      release?.();
      if (ownsCallId) this.activeCallIds.delete(activeCallKey);
      this.notifyLifecycleEnded(lifecycle, startedAt);
    }
  }

  async prepare(input: ExecuteToolInput): Promise<PreparedToolCall> {
    throwIfAborted(input.signal);
    await this.assertCatalogCurrent(input);
    const registryRevision = this.options.registry.getRevision?.();
    const tool = input.catalogTool ?? await this.toolForContext(input.toolName, toolRegistryContext(input));
    if (!tool) throw new UnknownToolError(input.toolName);
    const validated = await this.validate(tool, input.input, toolRegistryContext(input), input.signal);
    const originalSpec = this.resourceSpec(tool, validated);
    if (originalSpec !== false) await canonicalToolResources(input.cwd, originalSpec);
    const preparedInput = tool.prepareInput ? await tool.prepareInput(validated, toolRegistryContext(input)) : validated;
    await validateToolSchema(tool, preparedInput, input.signal);
    const validatedInput = freezePreparedValue(preparedInput);
    const preparedSpec = this.resourceSpec(tool, validatedInput);
    const spec = preparedSpec === false ? false : await canonicalToolResources(input.cwd, preparedSpec);
    const explicit = await this.resolvePredicate(tool.isConcurrencySafe, validatedInput);
    const isConcurrencySafe = !tool.isOrchestrator && (explicit ?? (await this.resolvePredicate(tool.isReadOnly, validatedInput)) ?? false);
    throwIfAborted(input.signal);
    const prepared: PreparedToolCall = Object.freeze({
      toolName: tool.name,
      validatedInput,
      ...(registryRevision === undefined ? {} : { registryRevision }),
      isConcurrencySafe,
    });
    this.preparedCalls.set(prepared, {
      tool: { ...tool },
      context: preparationContext(input),
      fingerprint: toolFingerprint(tool),
      originalSpec,
      spec,
    });
    return prepared;
  }

  async canRunConcurrently(toolName: string, input: unknown, context?: ToolRegistryContext): Promise<boolean> {
    if (context) return (await this.prepare({ ...context, toolName, input })).isConcurrencySafe;
    const tool = this.options.registry.get(toolName);
    if (!tool) return false;
    if (tool.isOrchestrator) return false;
    const validated = await this.validate(tool, input);
    return (await this.resolvePredicate(tool.isConcurrencySafe, validated))
      ?? (await this.resolvePredicate(tool.isReadOnly, validated)) ?? false;
  }

  private async assertCatalogCurrent(input: ExecuteToolInput): Promise<void> {
    if (input.catalogRevision !== undefined && input.catalogRevision !== this.options.registry.getRevision?.()) {
      throw new ToolDeniedError(input.toolName, "Tool catalog changed; start a new code_mode call.");
    }
    if (input.catalogTool) {
      const current = await this.toolForContext(input.toolName, toolRegistryContext(input));
      if (!current || toolFingerprint(current) !== toolFingerprint(input.catalogTool)) {
        throw new ToolDeniedError(input.toolName, "Tool catalog changed; start a new code_mode call.");
      }
    }
  }

  private async validate<Input>(tool: ChiliToolDefinition<Input>, input: unknown, context?: ToolRegistryContext, signal?: AbortSignal): Promise<Input> {
    const result = tool.validate ? await tool.validate(input, context) : { ok: true as const, value: input as Input };
    if (!result.ok) throw new ToolValidationError(tool.name, result.message);
    await validateToolSchema(tool, result.value, signal);
    return result.value;
  }

  private async assertPreparedCurrent(prepared: PreparedToolCall, input: ExecuteToolInput): Promise<void> {
    await this.assertCatalogCurrent(input);
    const details = this.preparedCalls.get(prepared)!;
    const current = await this.toolForContext(input.toolName, toolRegistryContext(input));
    if (!current || prepared.registryRevision !== this.options.registry.getRevision?.()
      || details.fingerprint !== toolFingerprint(current)) {
      throw new ToolDeniedError(prepared.toolName, "Tool catalog changed after preparation; prepare a new call.");
    }
    if (details.originalSpec !== false) {
      const resolved = await canonicalToolResources(input.cwd, details.originalSpec);
      if (JSON.stringify(resolved.patterns) !== JSON.stringify(details.spec && details.spec.patterns)) {
        throw new ToolDeniedError(prepared.toolName, "Resource target changed after preparation; prepare a new call.");
      }
    }
  }

  private async authorizeWorkerPolicy<Input>(
    tool: ChiliToolDefinition<Input>, validatedInput: Input, input: ExecuteToolInput,
    spec: false | ExecutableResourceSpec,
  ): Promise<{ executionPolicy?: ToolAccessPolicy; callerToolPolicy?: ToolAccessPolicy }> {
    const policies = await this.policies(input);
    for (const policy of policies) {
      await authorizeToolByPolicy({
        tool, executeInput: input, validatedInput,
        resourceSpec: spec === false ? { permission: tool.name, patterns: ["*"], metadata: {} } : spec,
        policy, isReadOnly: (definition, value) => this.resolvePredicate(definition.isReadOnly, value),
      });
    }
    // Backend scopes and delegated authority must describe the same observation.
    const executionPolicy = await executionPolicyFor(input.cwd, policies);
    if (policies.length === 0) return {};
    const callerToolPolicy: ToolAccessPolicy = { ...executionPolicy };
    if (policies.some((policy) => policy.allowedTools !== undefined)) {
      const registered = this.options.registry.listForContext
        ? await this.options.registry.listForContext(toolRegistryContext(input))
        : this.options.registry.list();
      // Materializing canonical names preserves wildcard and alias semantics
      // without granting a child capabilities absent from the caller's catalog.
      callerToolPolicy.allowedTools = policies.reduce(
        (tools, policy) => filterToolsByPolicy(tools, policy), registered,
      ).map((candidate) => candidate.name).sort();
    }
    const deniedTools = [...new Set(policies.flatMap((policy) => policy.deniedTools ?? [])
      .map((name) => name.trim().toLowerCase()))].sort();
    if (deniedTools.length > 0) callerToolPolicy.deniedTools = deniedTools;
    return { ...(executionPolicy ? { executionPolicy } : {}), callerToolPolicy };
  }

  private async assertExecutionAuthorized(
    prepared: PreparedToolCall, input: ExecuteToolInput,
    review: ToolReviewResult,
    workerAuthorization: { executionPolicy?: ToolAccessPolicy; callerToolPolicy?: ToolAccessPolicy },
  ): Promise<void> {
    throwIfAborted(input.signal);
    await this.assertPreparedCurrent(prepared, input);
    const { tool, spec } = this.preparedCalls.get(prepared)!;
    const current = await this.authorizeWorkerPolicy(tool, prepared.validatedInput, input, spec);
    if (JSON.stringify(current) !== JSON.stringify(workerAuthorization)) {
      throw new ToolDeniedError(tool.name, "Execution resource scope changed or caller tool policy changed; prepare a new operation and backend isolation profile.");
    }
    await review.assertCurrent?.();
    throwIfAborted(input.signal);
  }

  private async review<Input>(
    tool: ChiliToolDefinition<Input>, validatedInput: Input, input: ExecuteToolInput,
    callId: ToolCallId, spec: false | ExecutableResourceSpec,
  ): Promise<ToolReviewResult> {
    const request: ToolReviewRequest = Object.freeze({
      sessionId: input.sessionId,
      turnId: input.turnId,
      callId,
      ...(input.parentCallId ? { parentCallId: input.parentCallId } : {}),
      toolName: tool.name,
      toolDescription: tool.description,
      risk: tool.risk,
      input: validatedInput,
      cwd: input.cwd,
      ...(spec === false ? {} : { resources: freezePreparedValue(spec) as ToolResourceSpecWithDefaults }),
    });
    const result = await withAbort(this.options.gate.review(request, input.signal), input.signal);
    throwIfAborted(input.signal);
    const decision = result?.decision;
    const assertCurrent = result?.assertCurrent;
    if (decision !== "allow" && decision !== "deny") {
      throw new ToolDeniedError(tool.name, "Execution review returned an invalid decision.");
    }
    const reason = typeof result.reason === "string" ? result.reason : undefined;
    if (assertCurrent !== undefined && typeof assertCurrent !== "function") {
      throw new ToolDeniedError(tool.name, "Execution review returned an invalid authorization check.");
    }
    await this.publish("tool.call_updated", input, {
      callId, status: "validating",
      metadata: boundToolEventMetadata({ review: { decision, ...(reason ? { reason } : {}) } }),
    });
    if (decision === "deny") {
      throw new ToolDeniedError(tool.name, reason ?? "Execution review rejected this operation.");
    }
    // Copy the permit so a mutable gate result cannot replace its check later.
    return Object.freeze({ decision: "allow", ...(reason ? { reason } : {}),
      ...(assertCurrent ? { assertCurrent } : {}) });
  }

  private resourceSpec<Input>(tool: ChiliToolDefinition<Input>, input: Input): false | ExecutableResourceSpec {
    const spec = tool.resources ? tool.resources(input) : { patterns: ["*"] };
    if (spec === false) return false;
    return validateResourceSpec(tool.name, {
      permission: spec.permission ?? tool.name,
      patterns: spec.patterns,
      metadata: spec.metadata ?? {},
    });
  }

  private async createSnapshotIfNeeded<Input>(
    tool: ChiliToolDefinition<Input>,
    input: ExecuteToolInput,
    callId: ToolCallId,
    validated: Input,
    spec: false | ExecutableResourceSpec,
    assertCurrentAuthorization?: () => Promise<void>,
  ): Promise<SnapshotRecord | undefined> {
    if (spec === false) return undefined;
    if (!this.options.snapshotProvider) return undefined;

    const shouldSnapshot = this.options.snapshotPolicy
      ? this.options.snapshotPolicy({ tool, spec })
      : tool.risk === "write" || tool.risk === "dangerous";
    if (!shouldSnapshot) return undefined;

    // A custom snapshot provider may have effects before using its callback.
    await assertCurrentAuthorization?.();
    const snapshot = await this.createSnapshot(tool, input, callId, spec, assertCurrentAuthorization);
    if (!snapshot) return undefined;

    const rawSnapshotId = safeRecordValue(snapshot, "id");
    if (!isSafePersistedIdentifier(rawSnapshotId)) {
      throw new ToolValidationError(tool.name, "Snapshot provider returned an invalid snapshot id.");
    }
    const rawSnapshotPaths = safeRecordValue(snapshot, "paths");
    const boundedSnapshotPaths = boundToolEventValue(
      Array.isArray(rawSnapshotPaths) ? rawSnapshotPaths : [],
      "snapshot paths",
    );
    const snapshotPaths = Array.isArray(boundedSnapshotPaths)
      ? boundedSnapshotPaths.filter((path): path is string => typeof path === "string")
      : [];
    const snapshotToolName = boundToolEventName(tool.name);
    const snapshotReason = boundToolEventName(`before ${tool.name}`);

    await this.publish("snapshot.created", input, {
      snapshotId: rawSnapshotId as import("@chili/protocol").SnapshotId,
      callId,
      toolName: snapshotToolName,
      paths: snapshotPaths,
      reason: snapshotReason,
    });
    await this.metadata(input, callId, {
      metadata: {
        snapshotId: rawSnapshotId,
        snapshotPaths,
      },
    });
    return snapshot;
  }

  private async createSnapshot<Input>(
    tool: ChiliToolDefinition<Input>,
    input: ExecuteToolInput,
    callId: ToolCallId,
    spec: ExecutableResourceSpec,
    assertCurrentAuthorization?: () => Promise<void>,
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
        ...(input.signal ? { signal: input.signal } : {}),
        ...(assertCurrentAuthorization ? { assertCurrentAuthorization } : {}),
      });
    } catch (error) {
      const err = toError(error);
      await this.metadata(input, callId, {
        metadata: {
          snapshotError: err.message,
        },
      });
      throw toError(new Error(`Snapshot failed before ${tool.name}; refusing to run tool: ${err.message}`));
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
    const processed = await this.processResultWithPersistence(
      tool,
      input,
      outputArtifactId,
      result,
      registeredOutput,
      invalidRegisteredOutputError,
    );
    return {
      ...processed,
      output: boundToolWireOutput(processed.output),
    };
  }

  private async processLifecycleResult(
    tool: ChiliToolDefinition,
    lifecycle: ToolLifecycleState,
    canonical: ToolResult,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const process = this.options.lifecycle?.processResult;
    if (!process) return canonical;
    try {
      const transformed = await withAbort(
        process(lifecycle.context, freezePreparedValue(canonical) as ToolResult, signal),
        signal,
      );
      throwIfAborted(signal);
      const presentation = validateToolResultPresentation(transformed);
      const limit = effectiveToolResultOutputLimit(tool.maxResultOutputBytes ?? this.options.maxResultOutputBytes);
      const preview = truncateUtf8(presentation.output, limit);
      const bounded = boundToolResult({
        title: presentation.title,
        output: boundToolWireOutput(preview.truncated
          ? `${preview.text}\n[processed tool output truncated after ${limit} bytes]`
          : presentation.output),
        ...(presentation.content === undefined ? {} : { content: presentation.content }),
      });
      // These fields describe the executed operation and its canonical artifacts,
      // not its display. A content processor cannot replace or forge them.
      return {
        ...bounded,
        ...(canonical.structuredData === undefined ? {} : { structuredData: canonical.structuredData }),
        ...(canonical.metadata === undefined ? {} : { metadata: canonical.metadata }),
        ...(canonical.artifactIds === undefined ? {} : { artifactIds: canonical.artifactIds }),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      const normalized = toError(error);
      lifecycle.resultProcessingError = normalized;
      const notice = `[Tool execution succeeded, but result content processing failed: ${normalized.message}. Do not rerun the tool solely because of this content-processing failure.]`;
      return boundToolResult({
        ...canonical,
        output: boundToolWireOutput(`${notice}\n${canonical.output}`),
        metadata: { ...canonical.metadata, resultProcessingError: normalized.message, executionSucceeded: true },
      });
    }
  }

  private notifyLifecycleEnded(lifecycle: ToolLifecycleState, startedAt: TimestampMs): void {
    const ended = this.options.lifecycle?.ended;
    if (!ended) return;
    try {
      const endedAt = this.now();
      const outcome: ToolLifecycleOutcome = Object.freeze({
        ...lifecycle,
        ...(lifecycle.result ? { result: freezePreparedValue(lifecycle.result) as ToolResult } : {}),
        ...(lifecycle.canonicalResult ? { canonicalResult: freezePreparedValue(lifecycle.canonicalResult) as ToolResult } : {}),
        ...(lifecycle.error ? { error: copyLifecycleError(lifecycle.error) } : {}),
        ...(lifecycle.resultProcessingError ? { resultProcessingError: copyLifecycleError(lifecycle.resultProcessingError) } : {}),
        startedAt, endedAt, durationMs: Math.max(0, endedAt - startedAt),
      });
      // The public contract is synchronous. Absorb a JavaScript caller's accidental
      // returned promise as well, without delaying or changing tool completion.
      const returned: unknown = ended(outcome);
      if (returned !== undefined) void Promise.resolve(returned).catch(() => undefined);
    } catch { /* Observation cannot change an executed operation or its terminal event. */ }
  }

  private async processResultWithPersistence(
    tool: ChiliToolDefinition,
    input: ExecuteToolInput,
    outputArtifactId: ToolCallId,
    result: ToolResult,
    registeredOutput?: PersistedOutput,
    invalidRegisteredOutputError?: Error,
  ): Promise<ToolResult> {
    const boundedResult = boundToolResult(result);
    const normalizedResult = withRegisteredOutput(stripUntrustedOutputPathMetadata(boundedResult), registeredOutput);
    const maxBytes = effectiveToolResultOutputLimit(
      tool.maxResultOutputBytes ?? this.options.maxResultOutputBytes,
    );
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
    executionPolicy?: ToolAccessPolicy,
    assertCurrentAuthorization?: () => Promise<void>,
    callerToolPolicy?: ToolAccessPolicy,
  ): ChiliToolExecutionContext {
    let outputSequence = 0;
    let streamedOutputBytes = 0;
    let catalog: Promise<{ tools: ChiliToolDefinition[]; revision: number | undefined }> | undefined;
    const loadCatalog = () => catalog ??= (async () => {
      const revision = this.options.registry.getRevision?.();
      const tools = (await this.visibleTools(input)).map(snapshotToolDefinition);
      if (revision !== this.options.registry.getRevision?.()) throw new Error("Tool catalog changed; start a new code_mode call.");
      return { tools, revision };
    })();
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      callId,
      outputArtifactId,
      signal: input.signal ?? new AbortController().signal,
      cwd: input.cwd,
      fileReads: this.fileReads.forSession(input.sessionId),
      ...(executionPolicy ? { executionPolicy } : {}),
      ...(callerToolPolicy ? { callerToolPolicy: structuredClone(callerToolPolicy) } : {}),
      ...(assertCurrentAuthorization ? { assertCurrentAuthorization } : {}),
      visibleTools: tool.isOrchestrator ? async () => (await loadCatalog()).tools : () => this.visibleTools(input),
      invocationMode: input.parentCallId ? "code" : "direct",
      loadTools: async (names) => {
        const requested = new Set(names);
        const available = await this.visibleTools(input);
        const loaded = available.filter((candidate) => requested.has(candidate.name)).map((candidate) => candidate.name).sort();
        throwIfAborted(input.signal);
        await assertCurrentAuthorization?.();
        if (loaded.length > 0) {
          await this.publish("session.tools_loaded", input, { sessionId: input.sessionId, turnId: input.turnId, callId, names: loaded });
        }
        return loaded;
      },
      ...(tool.isOrchestrator ? {
        invokeTool: async (name: string, childInput: unknown, childSignal?: AbortSignal): Promise<ToolResult> => {
          input.dispatchScope?.throwIfFailed();
          const snapshot = await loadCatalog();
          const child = snapshot.tools.find((candidate) => candidate.name === name);
          if (!child || child.codeMode !== true || child.isOrchestrator) {
            throw new ToolDeniedError(name, "Tool is not in this script's callable catalog.");
          }
          const signals = [input.signal, childSignal].filter((signal): signal is AbortSignal => signal !== undefined);
          const signal = AbortSignal.any(signals);
          signal.throwIfAborted();
          const result = await this.execute({
            sessionId: input.sessionId, turnId: input.turnId, cwd: input.cwd,
            toolName: child.name, input: childInput, parentCallId: callId,
            ...(input.policy ? { policy: input.policy } : {}),
            ...(input.dispatchScope ? { dispatchScope: input.dispatchScope } : {}),
            ...(snapshot.revision === undefined ? {} : { catalogRevision: snapshot.revision }),
            catalogTool: child, signal,
          });
          if (result.status !== "completed") throw Object.assign(result.error, { callId: result.callId });
          return result.result;
        },
      } : {}),
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
        const bounded = boundToolOutputUpdate(
          update,
          Math.max(0, MAX_TOOL_STREAM_TOTAL_BYTES - streamedOutputBytes),
        );
        if (!bounded) return Promise.resolve();
        streamedOutputBytes += Buffer.byteLength(bounded.delta, "utf8");
        outputSequence += 1;
        return this.streamOutput(input, callId, outputSequence, bounded);
      },
    };
  }

  private async metadata(input: ExecuteToolInput, callId: ToolCallId, update: ToolMetadataUpdate): Promise<void> {
    const rawStatus = safeRecordValue(update, "status");
    const rawMetadata = safeRecordValue(update, "metadata");
    if (rawStatus !== undefined && rawStatus !== "running") {
      throw new ToolValidationError("metadata", "Tool metadata updates may only report running status.");
    }
    await this.publish("tool.call_updated", input, {
      callId,
      status: "running",
      ...(isPlainRecord(rawMetadata) ? { metadata: boundToolEventMetadata(rawMetadata) } : {}),
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
    const tools = this.options.registry.listForContext
      ? await this.options.registry.listForContext(toolRegistryContext(input))
      : this.options.registry.list();
    return policies.reduce(
      (tools, policy) => filterToolsByPolicy(tools, policy),
      tools,
    );
  }

  private toolForContext(
    name: string,
    context: ToolRegistryContext,
  ): Promise<ChiliToolDefinition | undefined> | ChiliToolDefinition | undefined {
    return this.options.registry.getForContext
      ? this.options.registry.getForContext(name, context)
      : this.options.registry.get(name);
  }

  private async policies(input: ExecuteToolInput): Promise<ToolAccessPolicy[]> {
    const policies: ToolAccessPolicy[] = [];
    if (input.policy) policies.push(structuredClone(input.policy));
    const resolved = await this.options.policyResolver?.resolve(toolPolicyContext(input));
    if (resolved) policies.push(structuredClone(resolved));
    return policies;
  }

  private async update(
    input: ExecuteToolInput,
    callId: ToolCallId,
    status: "validating" | "running",
  ): Promise<void> {
    await this.publish("tool.call_updated", input, { callId, status });
  }

  private async fail(input: ExecuteToolInput, callId: ToolCallId, error: Error): Promise<ExecuteToolResult> {
    const normalizedError = toError(error);
    await this.publish("tool.call_finished", input, {
      callId,
      ...(input.providerCallId === undefined ? {} : { providerCallId: input.providerCallId }),
      status: "failed",
      error: normalizedError.message,
      ...errorDetailsPayload(normalizedError),
      synthetic: true,
    });
    return { status: "failed", callId, error: normalizedError };
  }

  private async cancel(input: ExecuteToolInput, callId: ToolCallId, error: Error): Promise<ExecuteToolResult> {
    const normalizedError = toError(error);
    await this.publish("tool.call_finished", input, {
      callId,
      ...(input.providerCallId === undefined ? {} : { providerCallId: input.providerCallId }),
      status: "cancelled",
      error: normalizedError.message,
      ...errorDetailsPayload(normalizedError),
      synthetic: true,
    });
    return { status: "cancelled", callId, error: normalizedError };
  }

  private async publish<TType extends RuntimeEvent["type"], TPayload>(
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
    try {
      await this.options.events.publish(event as RuntimeEvent);
    } catch (error) {
      const normalizedError = toError(error);
      this.eventPublishFailures.add(normalizedError);
      input.dispatchScope?.fail(normalizedError);
      throw normalizedError;
    }
  }

  private isEventPublishFailure(value: unknown): value is Error {
    return (typeof value === "object" || typeof value === "function")
      && value !== null
      && this.eventPublishFailures.has(value);
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

function errorDetailsPayload(
  error: ReturnType<typeof toError>,
): { errorDetails?: ReturnType<typeof toError>["persistedErrorDetails"] } {
  const details = error.persistedErrorDetails;
  return (details.name !== "Error" && details.name !== "AbortError")
    || details.code !== undefined
    || details.truncated === true
    ? { errorDetails: details }
    : {};
}

function toolRegistryContext(
  input: Pick<ExecuteToolInput, "sessionId" | "turnId" | "cwd">,
): ToolRegistryContext {
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    cwd: input.cwd,
  };
}

function validateResourceSpec(toolName: string, spec: ExecutableResourceSpec): ExecutableResourceSpec {
  if (typeof spec.permission !== "string"
    || spec.permission.length === 0
    || spec.permission !== spec.permission.trim()
    || Buffer.byteLength(spec.permission, "utf8") > MAX_RESOURCE_PERMISSION_BYTES
    || /[\u0000-\u001f\u007f]/u.test(spec.permission)) {
    throw new ToolValidationError(toolName, "Resource category must be a canonical bounded string.");
  }
  if (!Array.isArray(spec.patterns) || spec.patterns.length === 0) {
    throw new ToolValidationError(toolName, "Tool resource spec must include at least one pattern.");
  }
  if (spec.patterns.length > MAX_RESOURCE_PATTERNS) {
    throw new ToolValidationError(toolName, `Tool resource spec must include at most ${MAX_RESOURCE_PATTERNS} patterns.`);
  }
  const invalidIndex = spec.patterns.findIndex((pattern) => typeof pattern !== "string" || pattern.trim().length === 0);
  if (invalidIndex >= 0) {
    throw new ToolValidationError(toolName, `Tool resource spec pattern at index ${invalidIndex} must be a non-empty string.`);
  }
  let serializedPatternBytes = 2;
  for (const [index, pattern] of spec.patterns.entries()) {
    const patternBytes = boundedJsonBytes(pattern);
    if (patternBytes > MAX_RESOURCE_PATTERN_BYTES) {
      throw new ToolValidationError(toolName, `Tool resource spec pattern at index ${index} exceeds the byte limit.`);
    }
    serializedPatternBytes += (index === 0 ? 0 : 1) + patternBytes;
    if (serializedPatternBytes > MAX_RESOURCE_PATTERNS_BYTES) {
      throw new ToolValidationError(toolName, "Tool resource spec patterns exceed the aggregate byte limit.");
    }
  }
  return spec;
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
  const reason = signal.reason === undefined
    ? toError("Tool execution aborted")
    : toError(signal.reason);
  reason.name = "AbortError";
  return toError(reason);
}

/** Validate one processor's presentation before passing it to the next processor. */
export function validateToolResultPresentation(result: unknown): Pick<ToolResult, "title" | "output" | "content"> {
  if (!isPlainRecord(result)) throw new Error("Result processor must return a ToolResult object.");
  const allowedKeys = new Set(["title", "output", "content", "metadata", "structuredData", "artifactIds"]);
  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new Error("Result processor cannot return execution status, errors, or unknown fields.");
    }
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(result, key)!, "value")) {
      throw new Error("Result processor cannot return accessors.");
    }
  }
  const title = resultPresentationField(result, "title");
  const output = resultPresentationField(result, "output");
  const content = resultPresentationField(result, "content");
  if (typeof title !== "string" || typeof output !== "string") {
    throw new Error("Result processor must return string title and output fields.");
  }
  let items: ToolResultContent[] | undefined;
  if (content !== undefined) {
    if (!Array.isArray(content)) throw new Error("Result processor content must be an array.");
    const count = resultPresentationField(content, "length");
    if (typeof count !== "number" || count > MAX_TOOL_RESULT_CONTENT_ITEMS) {
      throw new Error(`Result processor content exceeds ${MAX_TOOL_RESULT_CONTENT_ITEMS} items.`);
    }
    items = [];
    for (let index = 0; index < count; index++) {
      const item = resultPresentationField(content, String(index));
      const type = resultPresentationField(item, "type");
      const text = resultPresentationField(item, "text");
      if (type === "text" && typeof text === "string") {
        items.push({ type, text });
        continue;
      }
      const data = resultPresentationField(item, "data");
      const mimeType = resultPresentationField(item, "mimeType");
      if (type === "image" && typeof data === "string" && typeof mimeType === "string") {
        items.push({ type, data, mimeType });
        continue;
      }
      throw new Error("Result processor returned invalid content.");
    }
  }
  return { title, output, ...(items === undefined ? {} : { content: items }) };
}

function resultPresentationField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) throw new Error("Result processor cannot return accessors.");
  return descriptor?.value;
}

function copyLifecycleError(error: Error): Error {
  const normalized = toError(error);
  const copy = new Error(normalized.message);
  copy.name = normalized.name;
  return Object.freeze(copy);
}

function boundToolResult(result: ToolResult): ToolResult {
  const rawTitle = safeRecordValue(result, "title");
  const rawOutput = safeRecordValue(result, "output");
  const rawContent = safeRecordValue(result, "content");
  const rawMetadata = safeRecordValue(result, "metadata");
  const rawArtifactIds = safeRecordValue(result, "artifactIds");
  const structuredData = Object.getOwnPropertyDescriptor(result, "structuredData")?.value as unknown;
  const boundedContent = boundToolResultContent(Array.isArray(rawContent) ? rawContent : undefined);
  const boundedMetadata = isPlainRecord(rawMetadata)
    ? boundToolMetadata(rawMetadata)
    : undefined;
  const metadata = boundedContent.truncated
    ? {
        ...boundedMetadata,
        contentTruncated: true,
        contentItems: Array.isArray(rawContent) ? safeArrayLength(rawContent) : 0,
        contentLimitBytes: MAX_TOOL_RESULT_CONTENT_TOTAL_BYTES,
      }
    : boundedMetadata;
  return {
    title: truncateUtf8WithoutFullCopy(typeof rawTitle === "string" ? rawTitle : "Tool result", MAX_TOOL_RESULT_TITLE_BYTES),
    output: typeof rawOutput === "string" ? rawOutput : safeString(rawOutput),
    ...(structuredData === undefined ? {} : { structuredData }),
    ...(boundedContent.content === undefined ? {} : { content: boundedContent.content }),
    ...(metadata === undefined ? {} : { metadata }),
    ...boundArtifactIds(Array.isArray(rawArtifactIds) ? rawArtifactIds : undefined),
  };
}

function boundToolResultContent(content: unknown[] | undefined): {
  content: ToolResultContent[] | undefined;
  truncated: boolean;
} {
  if (!content || content.length === 0) return { content: undefined, truncated: false };
  const bounded: ToolResultContent[] = [];
  let serializedBytes = 2;
  let truncated = content.length > MAX_TOOL_RESULT_CONTENT_ITEMS;
  for (const item of content.slice(0, MAX_TOOL_RESULT_CONTENT_ITEMS)) {
    const separatorBytes = bounded.length === 0 ? 0 : 1;
    const itemBudget = Math.min(
      MAX_TOOL_RESULT_CONTENT_ITEM_BYTES,
      MAX_TOOL_RESULT_CONTENT_TOTAL_BYTES - serializedBytes - separatorBytes,
    );
    if (itemBudget <= 0) {
      truncated = true;
      break;
    }
    const type = safeRecordValue(item, "type");
    if (type === "text") {
      const rawText = safeRecordValue(item, "text");
      const textValue = typeof rawText === "string" ? rawText : safeString(rawText);
      const emptyItemBytes = boundedJsonBytes({ type: "text", text: "" });
      const stringBudget = Math.max(2, itemBudget - (emptyItemBytes - 2));
      const text = fitJsonString(textValue, stringBudget, "tool text content");
      const value: ToolResultContent = { type: "text", text };
      const bytes = boundedJsonBytes(value);
      if (bytes > itemBudget) {
        truncated = true;
        break;
      }
      bounded.push(value);
      serializedBytes += separatorBytes + bytes;
      if (boundedJsonBytes(textValue) > boundedJsonBytes(text)) truncated = true;
      continue;
    }
    if (type !== "image") {
      truncated = true;
      continue;
    }
    const rawData = safeRecordValue(item, "data");
    const rawMimeType = safeRecordValue(item, "mimeType");
    const data = typeof rawData === "string" ? rawData : "";
    const dataBytes = Buffer.byteLength(data, "utf8");
    const mimeType = truncateUtf8WithoutFullCopy(
      typeof rawMimeType === "string" ? rawMimeType : "application/octet-stream",
      256,
    ) || "application/octet-stream";
    const value: ToolResultContent = { type: "image", data, mimeType };
    const itemBytes = boundedJsonBytes(value);
    if (dataBytes > MAX_TOOL_RESULT_CONTENT_ITEM_BYTES || itemBytes > itemBudget) {
      const placeholderText = `[image omitted: ${dataBytes} encoded bytes exceeds tool content limit]`;
      const emptyItemBytes = boundedJsonBytes({ type: "text", text: "" });
      const placeholder: ToolResultContent = {
        type: "text",
        text: fitJsonString(placeholderText, Math.max(2, itemBudget - (emptyItemBytes - 2))),
      };
      const placeholderBytes = boundedJsonBytes(placeholder);
      if (placeholderBytes <= itemBudget) {
        bounded.push(placeholder);
        serializedBytes += separatorBytes + placeholderBytes;
      }
      truncated = true;
      continue;
    }
    bounded.push(value);
    serializedBytes += separatorBytes + itemBytes;
  }
  return { content: bounded.length > 0 ? bounded : undefined, truncated };
}

function boundArtifactIds(value: unknown[] | undefined): { artifactIds?: import("@chili/protocol").ArtifactId[] } {
  if (!value || value.length === 0) return {};
  const artifactIds: import("@chili/protocol").ArtifactId[] = [];
  let serializedBytes = 2;
  const rawLength = safeArrayLength(value);
  for (let index = 0; index < Math.min(rawLength, MAX_TOOL_RESULT_ARTIFACT_IDS_SCAN); index += 1) {
    if (artifactIds.length >= MAX_TOOL_RESULT_CONTENT_ITEMS) break;
    const candidate = safeRecordValue(value, String(index));
    if (!isSafeArtifactId(candidate)) continue;
    const separatorBytes = artifactIds.length === 0 ? 0 : 1;
    const artifactId = candidate as import("@chili/protocol").ArtifactId;
    const bytes = boundedJsonBytes(artifactId);
    if (serializedBytes + separatorBytes + bytes > MAX_TOOL_RESULT_ARTIFACT_IDS_BYTES) break;
    artifactIds.push(artifactId);
    serializedBytes += separatorBytes + bytes;
  }
  return artifactIds.length > 0 ? { artifactIds } : {};
}

function isSafePersistedIdentifier(value: unknown): value is string {
  if (typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > MAX_TOOL_RESULT_ARTIFACT_ID_CHARS) {
    return false;
  }
  if (value === "__proto__" || value === "prototype" || value === "constructor") return false;
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

const isSafeArtifactId = isSafePersistedIdentifier;

function boundToolEventValue(value: unknown, label: string): unknown {
  return boundPersistedJsonValue(value, {
    maxBytes: PERSISTED_JSON_LIMITS.eventValueBytes,
    maxStringBytes: PERSISTED_JSON_LIMITS.stringBytes,
    maxItems: PERSISTED_JSON_LIMITS.items,
    maxDepth: PERSISTED_JSON_LIMITS.depth,
    maxNodes: PERSISTED_JSON_LIMITS.nodes,
    label,
  });
}

function boundToolEventMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return boundToolMetadata(metadata);
}

function boundToolEventName(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return truncateWithNotice(sanitized || "unknown_tool", 512, "tool name");
}

function boundToolMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const state = {
    nodes: 0,
    seen: new WeakSet<object>(),
  };
  const bounded = visitToolMetadata(
    metadata,
    state,
    0,
    MAX_TOOL_RESULT_METADATA_BYTES,
    [],
  );
  return isPlainRecord(bounded) ? bounded : { value: bounded };
}

function visitToolMetadata(
  value: unknown,
  state: { nodes: number; seen: WeakSet<object> },
  depth: number,
  maxSerializedBytes: number,
  path: readonly string[],
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_TOOL_RESULT_METADATA_NODES) {
    return fitJsonString("[omitted: metadata node limit exceeded]", maxSerializedBytes);
  }
  if (typeof value === "string") {
    return fitJsonString(
      value,
      Math.min(maxSerializedBytes, MAX_TOOL_RESULT_METADATA_STRING_BYTES + 2),
      "metadata string",
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") {
    return fitJsonString(safeString(value), maxSerializedBytes, "metadata value");
  }
  if (depth >= MAX_TOOL_RESULT_METADATA_DEPTH) {
    return fitJsonString("[omitted: metadata depth limit exceeded]", maxSerializedBytes);
  }
  if (state.seen.has(value)) return fitJsonString("[omitted: circular metadata]", maxSerializedBytes);
  state.seen.add(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    let bytes = 2;
    const rawLength = safeArrayLength(value);
    const keptItems = Math.min(rawLength, MAX_TOOL_RESULT_METADATA_ITEMS);
    for (let index = 0; index < keptItems; index += 1) {
      const separatorBytes = result.length === 0 ? 0 : 1;
      const childBudget = maxSerializedBytes - bytes - separatorBytes;
      if (childBudget < 2) break;
      const child = visitToolMetadata(
        safeValueAt(value, index),
        state,
        depth + 1,
        childBudget,
        path,
      );
      const childBytes = boundedJsonBytes(child);
      if (childBytes > childBudget) break;
      result.push(child);
      bytes += separatorBytes + childBytes;
    }
    if (rawLength > result.length) {
      appendArrayMarker(result, `[${rawLength - result.length} metadata items omitted]`, maxSerializedBytes);
    }
    state.seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let bytes = 2;
  let visitedEntries = 0;
  let omitted = false;
  try {
    for (const rawKey in value) {
      if (!safeHasOwn(value, rawKey)) continue;
      if (visitedEntries >= MAX_TOOL_RESULT_METADATA_ITEMS) {
        omitted = true;
        break;
      }
      visitedEntries += 1;
      const key = truncateUtf8WithoutFullCopy(rawKey, 512);
      const separatorBytes = Object.keys(result).length === 0 ? 0 : 1;
      const entryPrefixBytes = separatorBytes + boundedJsonBytes(key) + 1;
      const childBudget = maxSerializedBytes - bytes - entryPrefixBytes;
      if (childBudget < 2) {
        omitted = true;
        break;
      }
      const rawChild = safeRecordValue(value, rawKey);
      const normalizedKey = normalizedToolMetadataKey(rawKey);
      const childValue = isToolMetadataDiagnosticField(normalizedKey, path)
        ? toError(rawChild).message
        : rawChild;
      const child = visitToolMetadata(
        childValue,
        state,
        depth + 1,
        childBudget,
        [...path, normalizedKey],
      );
      const childBytes = boundedJsonBytes(child);
      if (childBytes > childBudget) {
        omitted = true;
        break;
      }
      result[key] = child;
      bytes += entryPrefixBytes + childBytes;
    }
  } catch {
    omitted = true;
  }
  if (omitted) appendRecordMarker(result, "additional metadata keys omitted", maxSerializedBytes);
  state.seen.delete(value);
  return result;
}

function isToolMetadataDiagnosticField(
  key: string,
  path: readonly string[],
): boolean {
  if (key === "reason" || key === "error" || key === "failurereason") return true;
  if (key !== "feedback") return false;
  return path.some((segment) =>
    segment === "diagnostic"
      || segment === "diagnostics"
      || segment === "failure"
      || segment === "failures"
      || segment === "error"
      || segment === "errors"
      || segment === "preflight"
      || segment === "preflightdecision"
      || segment === "verification"
  );
}

function normalizedToolMetadataKey(value: string): string {
  return value.toLowerCase().replace(/[_ -]/gu, "");
}

function appendArrayMarker(result: unknown[], marker: string, maxBytes: number): void {
  const separatorBytes = result.length === 0 ? 0 : 1;
  const currentBytes = boundedJsonBytes(result);
  const budget = maxBytes - currentBytes - separatorBytes;
  if (budget < 2) return;
  const bounded = fitJsonString(marker, budget);
  if (boundedJsonBytes(bounded) <= budget) result.push(bounded);
}

function appendRecordMarker(result: Record<string, unknown>, marker: string, maxBytes: number): void {
  const key = Object.prototype.hasOwnProperty.call(result, "__omitted__")
    ? "__chili_omitted__"
    : "__omitted__";
  const separatorBytes = Object.keys(result).length === 0 ? 0 : 1;
  const currentBytes = boundedJsonBytes(result);
  const budget = maxBytes - currentBytes - separatorBytes - boundedJsonBytes(key) - 1;
  if (budget < 2) return;
  const bounded = fitJsonString(marker, budget);
  if (boundedJsonBytes(bounded) <= budget) result[key] = bounded;
}

function fitJsonString(value: string, maxSerializedBytes: number, label?: string): string {
  if (maxSerializedBytes < 2) return "";
  if (boundedJsonBytes(value) <= maxSerializedBytes) return value;
  const originalBytes = Buffer.byteLength(value, "utf8");
  const marker = label ? `\n[${label} truncated from ${originalBytes} bytes]` : "";
  const boundedMarker = boundedJsonBytes(marker) <= maxSerializedBytes
    ? marker
    : jsonStringPrefix(marker, maxSerializedBytes);
  if (!boundedMarker) return "";
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const prefix = safeUtf16Prefix(value, middle);
    if (boundedJsonBytes(`${prefix}${boundedMarker}`) <= maxSerializedBytes) low = middle;
    else high = middle - 1;
  }
  return `${safeUtf16Prefix(value, low)}${boundedMarker}`;
}

function jsonStringPrefix(value: string, maxSerializedBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (boundedJsonBytes(safeUtf16Prefix(value, middle)) <= maxSerializedBytes) low = middle;
    else high = middle - 1;
  }
  return safeUtf16Prefix(value, low);
}

function safeUtf16Prefix(value: string, end: number): string {
  let safeEnd = end;
  if (safeEnd > 0) {
    const code = value.charCodeAt(safeEnd - 1);
    if (code >= 0xd800 && code <= 0xdbff) safeEnd -= 1;
  }
  return value.slice(0, safeEnd);
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[omitted: metadata value could not be read]";
  }
}

function safeArrayLength(value: unknown[]): number {
  try {
    const length = Reflect.get(value, "length");
    return typeof length === "number" && Number.isSafeInteger(length) && length >= 0 ? length : 0;
  } catch {
    return 0;
  }
}

function safeValueAt(value: unknown[], index: number): unknown {
  try {
    return Reflect.get(value, index);
  } catch {
    return "[omitted: metadata item getter threw]";
  }
}

function safeHasOwn(value: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, key);
  } catch {
    return false;
  }
}

function safeRecordValue(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return "[omitted: metadata property getter threw]";
  }
}

function boundedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundToolOutputUpdate(
  update: ToolOutputUpdate,
  remainingBytes: number,
): ToolOutputUpdate | undefined {
  const stream = safeRecordValue(update, "stream");
  const rawDelta = safeRecordValue(update, "delta");
  if (stream !== "stdout" && stream !== "stderr") {
    throw new ToolValidationError("streamOutput", "Tool output stream must be stdout or stderr.");
  }
  if (typeof rawDelta !== "string") {
    throw new ToolValidationError("streamOutput", "Tool output delta must be a string.");
  }
  if (!rawDelta) return undefined;
  if (remainingBytes <= 0) return undefined;
  const limit = Math.min(remainingBytes, MAX_TOOL_STREAM_DELTA_BYTES);
  const delta = truncateWithNotice(rawDelta, limit, "tool stream delta");
  const actualBytes = Buffer.byteLength(delta, "utf8");
  return {
    stream,
    delta,
    bytes: actualBytes,
    truncated: safeRecordValue(update, "truncated") === true || Buffer.byteLength(rawDelta, "utf8") > actualBytes,
  };
}

function truncateWithNotice(value: string, maxBytes: number, label: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return value;
  if (maxBytes <= 0) return "";
  const notice = `\n[${label} truncated from ${bytes} bytes]`;
  const noticeBytes = Buffer.byteLength(notice, "utf8");
  if (noticeBytes >= maxBytes) return truncateUtf8WithoutFullCopy(notice, maxBytes);
  return `${truncateUtf8WithoutFullCopy(value, maxBytes - noticeBytes)}${notice}`;
}

function effectiveToolResultOutputLimit(configured: number | undefined): number {
  if (configured === undefined) return MAX_TOOL_RESULT_OUTPUT_PREVIEW_BYTES;
  if (!Number.isFinite(configured) || configured < 0) return MAX_TOOL_RESULT_OUTPUT_PREVIEW_BYTES;
  return Math.min(Math.trunc(configured), MAX_TOOL_RESULT_OUTPUT_PREVIEW_BYTES);
}

function boundToolWireOutput(value: string): string {
  const escapedControls = value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return truncateWithNotice(escapedControls, MAX_TOOL_RESULT_WIRE_OUTPUT_BYTES, "tool output wire preview");
}

function truncateUtf8WithoutFullCopy(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function preparationContext(input: ExecuteToolInput): string {
  return [input.sessionId, input.turnId, input.cwd, input.toolName].join("\0");
}

function toolFingerprint(tool: ChiliToolDefinition): string {
  return JSON.stringify([
    tool.name, tool.revision, tool.inputSchema, tool.risk, tool.aliases, tool.resourcePolicy,
    tool.codeMode, tool.isOrchestrator, tool.inputSchemaSource, tool.outputSchema,
    tool.description, String(tool.isReadOnly), String(tool.isConcurrencySafe), String(tool.isDestructive),
  ]);
}

function snapshotToolDefinition(tool: ChiliToolDefinition): ChiliToolDefinition {
  return {
    ...tool,
    inputSchema: freezePreparedValue(tool.inputSchema),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: freezePreparedValue(tool.outputSchema) }),
    ...(tool.aliases === undefined ? {} : { aliases: [...tool.aliases] }),
  };
}

function freezePreparedValue(value: unknown): unknown {
  const copy = structuredClone(value);
  function freeze(item: unknown): void {
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  }
  freeze(copy);
  return copy;
}
