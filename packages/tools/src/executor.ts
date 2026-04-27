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
  ToolResult,
  TurnId,
} from "@chili/protocol";
import { timestampNow } from "@chili/protocol";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolDeniedError, ToolValidationError, UnknownToolError, isAbortError, toError } from "./errors.js";
import { FileReadStateStore } from "./file-read-state.js";
import { authorizeToolByPolicy, filterToolsByPolicy, toolPolicyContext } from "./tool-policy.js";
import type {
  ChiliToolDefinition,
  ChiliToolExecutionContext,
  ExecuteToolInput,
  ExecuteToolResult,
  SnapshotRecord,
  ToolApprovalSpec,
  ToolExecutorOptions,
} from "./types.js";

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
      const policy = await this.policy(input);
      await authorizeToolByPolicy({
        tool,
        executeInput: input,
        validatedInput: validated,
        approvalSpec: spec === false ? { permission: tool.name, patterns: ["*"], metadata: {} } : spec,
        policy,
        isReadOnly: (definition, toolInput) => this.resolvePredicate(definition.isReadOnly, toolInput),
      });

      const approval = await this.requestLifecycleApproval(tool, input, callId, validated, spec);
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
    validated: Input,
    spec: false | Required<ToolApprovalSpec>,
  ): Promise<ApprovalDecision> {
    if (spec === false) return { action: "allow_once" };

    await this.update(input, callId, "waiting_for_approval");
    return this.requestApproval(input, callId, tool, spec);
  }

  private approvalSpec<Input>(tool: ChiliToolDefinition<Input>, input: Input): false | Required<ToolApprovalSpec> {
    const spec = tool.approval ? tool.approval(input) : { patterns: ["*"] };
    if (spec === false) return false;
    return {
      permission: spec.permission ?? tool.name,
      patterns: spec.patterns,
      metadata: spec.metadata ?? {},
    };
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

    const persisted = await this.persistLargeOutput(input.cwd, callId, result.output);

    return {
      ...result,
      output: `${truncated.text}\n[tool output truncated after ${maxBytes} bytes; full output saved to ${persisted.relativePath}]`,
      metadata: {
        ...result.metadata,
        outputTruncated: true,
        outputBytes: truncated.bytes,
        outputLimitBytes: maxBytes,
        outputPath: persisted.relativePath,
      },
    };
  }

  private context(tool: ChiliToolDefinition, input: ExecuteToolInput, callId: ToolCallId): ChiliToolExecutionContext {
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
      requestApproval: (request) =>
        this.requestApproval(input, callId, tool, {
          permission: request.permission,
          patterns: request.patterns,
          metadata: request.metadata ?? {},
        }),
    };
  }

  private async requestApproval(
    input: ExecuteToolInput,
    callId: ToolCallId,
    tool: ChiliToolDefinition,
    spec: Required<ToolApprovalSpec>,
  ): Promise<ApprovalDecision> {
    const approvalId = this.id<ApprovalId>("approval");

    await this.publish("approval.requested", input, {
      approvalId,
      callId,
      permission: spec.permission,
      patterns: spec.patterns,
    });

    const decision = await this.options.approvals.decide({
      approvalId,
      sessionId: input.sessionId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      callId,
      toolName: tool.name,
      risk: tool.risk,
      permission: spec.permission,
      patterns: spec.patterns,
      metadata: spec.metadata,
    });

    await this.publish("approval.resolved", input, {
      approvalId,
      decision: decision.action,
      ...(decision.feedback ? { feedback: decision.feedback } : {}),
    });

    return decision;
  }

  private async metadata(input: ExecuteToolInput, callId: ToolCallId, update: ToolMetadataUpdate): Promise<void> {
    await this.publish("tool.call_updated", input, {
      callId,
      status: update.status ?? "running",
      ...(update.metadata ? { metadata: update.metadata } : {}),
    });
  }

  private async visibleTools(input: ExecuteToolInput): Promise<ChiliToolDefinition[]> {
    return filterToolsByPolicy(this.options.registry.list(), await this.policy(input));
  }

  private async policy(input: ExecuteToolInput) {
    return this.options.policyResolver?.resolve(toolPolicyContext(input));
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
  ): Promise<{ relativePath: string; absolutePath: string }> {
    const relativePath = join(".chili", "tool-results", `${callId}.txt`);
    const absolutePath = join(cwd, relativePath);
    await mkdir(join(cwd, ".chili", "tool-results"), { recursive: true });
    await writeFile(absolutePath, output, "utf8");
    return { relativePath, absolutePath };
  }
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  return {
    text: Buffer.from(text).subarray(0, maxBytes).toString("utf8"),
    bytes,
    truncated: true,
  };
}
