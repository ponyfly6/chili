import type {
  ApprovalDecision,
  ApprovalId,
  ChiliEvent,
  EventEnvelope,
  SessionId,
  ThreadId,
  TimestampMs,
  ToolCallId,
  ToolMetadataUpdate,
  ToolOutputUpdate,
  ToolResult,
  TurnId,
} from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import { createHash } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolDeniedError, ToolValidationError, UnknownToolError, isAbortError, toError } from "./errors.js";
import { FileReadStateStore } from "./file-read-state.js";
import { authorizeToolByPolicy, filterToolsByPolicy, toolPolicyContext } from "./tool-policy.js";
import { assertExistingPathInsideWorkspace, assertWritablePathInsideWorkspace, resolveWorkspacePath } from "./workspace-path.js";
import type {
  ChiliToolDefinition,
  ChiliToolExecutionContext,
  ExecuteToolInput,
  ExecuteToolResult,
  ApprovalPreflightDecision,
  SnapshotRecord,
  ToolAccessPolicy,
  ToolApprovalSpec,
  ToolExecutorOptions,
} from "./types.js";

const DEFAULT_MAX_PERSISTED_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_PERSISTED_OUTPUT_DIRECTORY_BYTES = 64 * 1024 * 1024;
const sidecarDirectoryLocks = new Map<string, Promise<void>>();

interface PersistedOutput {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  originalBytes: number;
  limitBytes: number;
  truncated: boolean;
}

export class ToolExecutor {
  private readonly fileReads: FileReadStateStore;

  constructor(private readonly options: ToolExecutorOptions) {
    this.fileReads = options.fileReadState ?? new FileReadStateStore();
  }

  async execute(input: ExecuteToolInput): Promise<ExecuteToolResult> {
    const callId = input.callId ?? this.id<ToolCallId>("toolcall");
    const tool = this.options.registry.get(input.toolName);

    await this.publish("tool.call_started", input, {
      turnId: input.turnId,
      callId,
      toolName: input.toolName,
      input: input.input,
    });

    if (!tool) {
      return this.fail(input, callId, new UnknownToolError(input.toolName));
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
          approvalSpec: spec === false ? { permission: tool.name, patterns: ["*"], metadata: {} } : spec,
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
      const rawResult = await tool.execute(validated, this.context(tool, input, callId));
      const result = await this.processResult(tool, input, callId, rawResult);

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
    spec: false | Required<ToolApprovalSpec>,
  ): Promise<ApprovalDecision> {
    if (spec === false) return { action: "allow_once" };

    const preflight = await this.preflightApproval(input, callId, tool, spec);
    if (preflight.action === "allow") return { action: "allow_once" };
    if (preflight.action === "deny") return denyDecision(preflight);

    await this.update(input, callId, "waiting_for_approval");
    return this.createApprovalRequest(input, callId, tool, spec, preflight);
  }

  private approvalSpec<Input>(tool: ChiliToolDefinition<Input>, input: Input): false | Required<ToolApprovalSpec> {
    const spec = tool.approval ? tool.approval(input) : { patterns: ["*"] };
    if (spec === false) return false;
    return validateApprovalSpec(tool.name, {
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
    spec: false | Required<ToolApprovalSpec>,
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
    spec: Required<ToolApprovalSpec>,
  ): Promise<SnapshotRecord | undefined> {
    try {
      return await this.options.snapshotProvider?.create({
        cwd: input.cwd,
        sessionId: input.sessionId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
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
    callId: ToolCallId,
    result: ToolResult,
  ): Promise<ToolResult> {
    const maxBytes = tool.maxResultOutputBytes ?? this.options.maxResultOutputBytes ?? 256_000;
    if (maxBytes === Infinity) return result;
    const truncated = truncateUtf8(result.output, maxBytes);
    if (!truncated.truncated) return result;

    let persisted: PersistedOutput;
    try {
      persisted = await this.persistLargeOutput(input.cwd, callId, result.output);
    } catch (error) {
      const persistenceError = toError(error);
      return {
        ...result,
        output: `${truncated.text}\n[tool output truncated after ${maxBytes} bytes; remaining output could not be safely persisted]`,
        metadata: {
          ...result.metadata,
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
      ...result,
      output: `${truncated.text}\n[tool output truncated after ${maxBytes} bytes; ${savedDescription}]`,
      metadata: {
        ...result.metadata,
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

  private context(tool: ChiliToolDefinition, input: ExecuteToolInput, callId: ToolCallId): ChiliToolExecutionContext {
    let outputSequence = 0;
    return {
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      turnId: input.turnId,
      callId,
      signal: input.signal ?? new AbortController().signal,
      cwd: input.cwd,
      fileReads: this.fileReads,
      visibleTools: () => this.visibleTools(input),
      metadata: (update) => this.metadata(input, callId, update),
      streamOutput: (update) => {
        outputSequence += 1;
        return this.streamOutput(input, callId, outputSequence, update);
      },
      requestApproval: (request) =>
        this.approveOrRequest(input, callId, tool, validateApprovalSpec(tool.name, {
          permission: request.permission,
          patterns: request.patterns,
          metadata: request.metadata ?? {},
        })),
    };
  }

  private async approveOrRequest(
    input: ExecuteToolInput,
    callId: ToolCallId,
    tool: ChiliToolDefinition,
    spec: Required<ToolApprovalSpec>,
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
    spec: Required<ToolApprovalSpec>,
    preflight?: ApprovalPreflightDecision,
  ): Promise<ApprovalDecision> {
    const approvalId = this.id<ApprovalId>("approval");

    await this.publish("approval.requested", input, {
      approvalId,
      callId,
      permission: spec.permission,
      patterns: spec.patterns,
      ...metadataPayload(approvalRequestMetadata(spec, preflight)),
    });

    let rawDecision: ApprovalDecision;
    try {
      rawDecision = await withAbort(this.options.approvals.decide({
        approvalId,
        sessionId: input.sessionId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        callId,
        toolName: tool.name,
        risk: tool.risk,
        permission: spec.permission,
        patterns: spec.patterns,
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
    const decision = normalizeApprovalDecision(rawDecision);

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
    spec: Required<ToolApprovalSpec>,
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
      ...(input.threadId ? { threadId: input.threadId } : {}),
      callId,
      toolName: tool.name,
      risk: tool.risk,
      permission: spec.permission,
      patterns: spec.patterns,
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
    if (input.threadId) {
      event.threadId = input.threadId;
    }
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
    const limitBytes = this.options.maxPersistedOutputBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_BYTES;
    const persisted = truncateUtf8(output, limitBytes);
    const relativePath = join(".chili", "tool-results", toolResultFilename(callId));
    const directoryTarget = resolveWorkspacePath(cwd, join(".chili", "tool-results"));
    const fileTarget = resolveWorkspacePath(cwd, relativePath);
    await assertWritablePathInsideWorkspace(cwd, fileTarget, relativePath);
    return withSidecarDirectoryLock(directoryTarget.absolutePath, async () => {
      await mkdir(directoryTarget.absolutePath, { recursive: true });
      await assertExistingPathInsideWorkspace(cwd, directoryTarget, join(".chili", "tool-results"));
      await assertWritablePathInsideWorkspace(cwd, fileTarget, relativePath);
      await writeFile(fileTarget.absolutePath, persisted.text, "utf8");
      const bytes = Buffer.byteLength(persisted.text, "utf8");
      await enforceSidecarDirectoryBudget(
        directoryTarget.absolutePath,
        fileTarget.absolutePath,
        this.options.maxPersistedOutputDirectoryBytes ?? DEFAULT_MAX_PERSISTED_OUTPUT_DIRECTORY_BYTES,
      );
      return {
        relativePath,
        absolutePath: fileTarget.absolutePath,
        bytes,
        originalBytes: persisted.bytes,
        limitBytes,
        truncated: persisted.truncated,
      };
    });
  }
}

function approvalRequestMetadata(
  spec: Required<ToolApprovalSpec>,
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

function validateApprovalSpec(toolName: string, spec: Required<ToolApprovalSpec>): Required<ToolApprovalSpec> {
  if (!Array.isArray(spec.patterns) || spec.patterns.length === 0) {
    throw new ToolValidationError(toolName, "Approval spec must include at least one pattern.");
  }
  const invalidIndex = spec.patterns.findIndex((pattern) => typeof pattern !== "string" || pattern.trim().length === 0);
  if (invalidIndex >= 0) {
    throw new ToolValidationError(toolName, `Approval spec pattern at index ${invalidIndex} must be a non-empty string.`);
  }
  return spec;
}

function isApprovalDecisionAction(action: unknown): action is ApprovalDecision["action"] {
  return action === "allow_once" || action === "allow_session" || action === "allow_always" || action === "deny";
}

function normalizeApprovalDecision(decision: ApprovalDecision): ApprovalDecision {
  const action = (decision as { action?: unknown } | null | undefined)?.action;
  if (isApprovalDecisionAction(action)) return decision;
  return { action: "deny", feedback: `Invalid approval decision action: ${String(action)}` };
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

function toolResultFilename(callId: ToolCallId): string {
  const value = String(callId);
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !value.includes("..")) {
    return `${value}.txt`;
  }
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `toolcall_${hash}.txt`;
}

async function enforceSidecarDirectoryBudget(directory: string, currentPath: string, maxBytes: number): Promise<void> {
  if (maxBytes === Infinity) return;
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const path = join(directory, entry.name);
    const info = await stat(path);
    return { path, bytes: info.size, modifiedAt: info.mtimeMs };
  }));
  let totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  const current = files.find((file) => file.path === currentPath);
  const effectiveLimit = Math.max(0, Math.trunc(maxBytes), current?.bytes ?? 0);
  files.sort((left, right) => {
    if (left.path === currentPath) return 1;
    if (right.path === currentPath) return -1;
    return left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path);
  });
  for (const file of files) {
    if (totalBytes <= effectiveLimit || file.path === currentPath) break;
    await unlink(file.path).catch((error) => {
      if (!isNotFoundError(error)) throw error;
    });
    totalBytes -= file.bytes;
  }
}

async function withSidecarDirectoryLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const previous = sidecarDirectoryLocks.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  const tail = previous.then(() => current);
  sidecarDirectoryLocks.set(directory, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sidecarDirectoryLocks.get(directory) === tail) sidecarDirectoryLocks.delete(directory);
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  const bytes = buffer.byteLength;
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  let end = Math.max(0, Math.min(Math.trunc(maxBytes), bytes));
  while (end > 0 && ((buffer[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return {
    text: buffer.subarray(0, end).toString("utf8"),
    bytes,
    truncated: true,
  };
}

function denyDecision(decision: ApprovalPreflightDecision): ApprovalDecision {
  const feedback = decision.feedback ?? decision.reason;
  return feedback ? { action: "deny", feedback } : { action: "deny" };
}
