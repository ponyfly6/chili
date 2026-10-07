import type {
  RuntimeEvent,
  EventEnvelope,
  SessionId,
  SnapshotId,
  TimestampMs,
  ToolCallId,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  TurnId,
} from "@chili/protocol";
import type { FileReadStateStore } from "./file-read-state.js";
import type { ToolDispatchScope } from "./dispatch-scope.js";

export type ValidationResult<Input> =
  | { ok: true; value: Input }
  | { ok: false; message: string };

export interface ChiliToolDefinition<Input = any, Output extends ToolResult = ToolResult>
  extends Omit<ToolDefinition<Input, Output>, "execute"> {
  aliases?: string[];
  searchHint?: string;
  alwaysLoad?: boolean;
  shouldDefer?: boolean;
  interruptBehavior?: "cancel" | "block";
  maxResultOutputBytes?: number;
  /** Stable identity for contextual tools whose handler is recreated on lookup. */
  revision?: string;
  /** Trusted host declaration; remote annotations must not populate this field. */
  resourcePolicy?: "filesystem" | "process" | "internal";
  /** Explicit host opt-in for calls made by an isolated orchestration script. */
  codeMode?: boolean;
  /** Host-assigned trust classification; external schemas validate in a terminable worker. */
  inputSchemaSource?: "external";
  /** Describes structuredData, not the human-readable output preview. */
  outputSchema?: unknown;
  /** An orchestrator does not hold its child tools' execution permit. */
  isOrchestrator?: boolean;
  isReadOnly?: ToolBooleanPredicate<Input>;
  isConcurrencySafe?: ToolBooleanPredicate<Input>;
  isDestructive?: ToolBooleanPredicate<Input>;
  validate?(input: unknown, context?: ToolRegistryContext): Promise<ValidationResult<Input>> | ValidationResult<Input>;
  /** Resolve trusted resource identities without performing the operation. */
  prepareInput?(input: Input, context: ToolRegistryContext): Promise<Input> | Input;
  /** Resource identities for scope enforcement and snapshots; never bypasses execution review. */
  resources?(input: Input): false | ToolResourceSpec;
  execute(input: Input, context: ChiliToolExecutionContext): Promise<Output>;
}

export interface ToolResourceSpec {
  permission?: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
}

export type ToolResourceSpecWithDefaults = Required<ToolResourceSpec>;

export type ToolBooleanPredicate<Input = any> = boolean | ((input: Input) => boolean | Promise<boolean>);

export interface PersistedToolOutputRegistration {
  relativePath: string;
  bytes: number;
  originalBytes: number;
  limitBytes: number;
  truncated: boolean;
}

export interface ChiliToolExecutionContext extends ToolExecutionContext {
  outputArtifactId: ToolCallId;
  /** Backend-enforced resource constraints; model review is not an isolation boundary. */
  executionPolicy?: ToolAccessPolicy;
  /** Trusted effective caller grants, denials and scopes for delegated authority. */
  callerToolPolicy?: ToolAccessPolicy;
  /** Recheck revocation after waiting on a resource lock, immediately before effects. */
  assertCurrentAuthorization?: () => Promise<void>;
  currentResourceDenials?: () => Promise<ToolResourceDenials | undefined>;
  assertFileResourceAccess?: (paths: readonly string[], access: "read" | "write") => Promise<void>;
  fileReads?: FileReadStateStore;
  visibleTools?: () => Promise<ChiliToolDefinition[]> | ChiliToolDefinition[];
  /** Discovery records model exposure, never grants execution authority. */
  loadTools?: (names: readonly string[]) => Promise<string[]>;
  invocationMode?: "direct" | "code";
  invokeTool?: (name: string, input: unknown, signal?: AbortSignal) => Promise<ToolResult>;
  persistedOutputLimits?: {
    maxBytes?: number;
    maxDirectoryBytes?: number;
  };
  registerPersistedOutput(output: PersistedToolOutputRegistration): Promise<void>;
}

export interface ToolRegistryEntry {
  tool: ChiliToolDefinition;
  source?: string;
}

export interface ToolRegistryRegisterOptions {
  source?: string;
  replace?: boolean;
}

export interface ToolRegistrySelector {
  source?: string;
  namePrefix?: string;
}

export interface ToolRegistryListOptions {
  /** Defaults to true. Model exposure is selected separately from the execution catalog. */
  includeDeferred?: boolean;
}

export interface ToolRegistryContext {
  sessionId: SessionId;
  turnId: TurnId;
  cwd: string;
}

export type ContextualToolProvider = (
  context: ToolRegistryContext,
) => Promise<readonly ChiliToolDefinition[]> | readonly ChiliToolDefinition[];

export interface ToolRegistry {
  getRevision?(): number;
  register(tool: ChiliToolDefinition, options?: ToolRegistryRegisterOptions): void;
  get(name: string): ChiliToolDefinition | undefined;
  list(options?: ToolRegistryListOptions): ChiliToolDefinition[];
  entries?(options?: ToolRegistryListOptions): ToolRegistryEntry[];
  getForContext?(name: string, context: ToolRegistryContext): Promise<ChiliToolDefinition | undefined>;
  listForContext?(
    context: ToolRegistryContext,
    options?: ToolRegistryListOptions,
  ): Promise<ChiliToolDefinition[]>;
}

export interface MutableToolRegistry extends ToolRegistry {
  unregister(name: string): boolean;
  unregisterMatching(selector: ToolRegistrySelector): ChiliToolDefinition[];
  unregisterSource(source: string): ChiliToolDefinition[];
  replaceMatching(selector: ToolRegistrySelector, tools: readonly ChiliToolDefinition[], options?: ToolRegistryRegisterOptions): ChiliToolDefinition[];
  replaceSource(source: string, tools: readonly ChiliToolDefinition[]): ChiliToolDefinition[];
  replaceContextualSource(source: string, provider: ContextualToolProvider): void;
  unregisterContextualSource(source: string): boolean;
}

export interface ToolEventSink {
  publish(event: RuntimeEvent): Promise<void>;
}

/** The host reviews the exact immutable operation prepared by the executor. */
export interface ToolReviewRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly callId: ToolCallId;
  readonly parentCallId?: ToolCallId;
  readonly toolName: string;
  readonly toolDescription: string;
  readonly risk: ChiliToolDefinition["risk"];
  readonly input: unknown;
  readonly cwd: string;
  readonly resources?: ToolResourceSpecWithDefaults;
}

export interface ToolReviewResult {
  decision: "allow" | "deny";
  reason?: string;
  /** Check revocation/configuration changes without calling the model again. */
  assertCurrent?: () => Promise<void>;
}

export interface ToolExecutionGate {
  review(request: ToolReviewRequest, signal?: AbortSignal): Promise<ToolReviewResult>;
}

export type ToolLifecyclePhase =
  | "starting"
  | "validating"
  | "authorizing"
  | "reviewing"
  | "snapshotting"
  | "executing"
  | "processing_result"
  | "publishing_result"
  | "completed";

/** A copied operation description, never an execution capability. */
export interface ToolLifecycleContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly callId: ToolCallId;
  readonly parentCallId?: ToolCallId;
  readonly providerCallId?: string;
  readonly toolName: string;
  readonly cwd: string;
  /** Prepared input when available; otherwise a bounded attempted input. */
  readonly input: unknown;
  readonly invocationMode: "direct" | "code";
  readonly prepared: boolean;
  readonly toolDescription?: string;
  readonly risk?: ChiliToolDefinition["risk"];
  readonly resources?: ToolResourceSpecWithDefaults;
}

/** Executor-owned facts, including failures after an effect has already succeeded. */
export interface ToolLifecycleOutcome {
  readonly context: ToolLifecycleContext;
  readonly phase: ToolLifecyclePhase;
  readonly handlerEntered: boolean;
  readonly executionSucceeded: boolean;
  readonly status: "completed" | "failed" | "blocked" | "cancelled";
  readonly startedAt: TimestampMs;
  readonly endedAt: TimestampMs;
  readonly durationMs: number;
  /** The returned presentation, after optional content processing. */
  readonly result?: ToolResult;
  /** The canonical tool result, before presentation processing. */
  readonly canonicalResult?: ToolResult;
  readonly error?: Error;
  readonly resultProcessingError?: Error;
}

export interface ToolLifecycleHooks {
  /** Transform title/output/content only, after canonical artifact processing. */
  processResult?(context: ToolLifecycleContext, result: ToolResult, signal: AbortSignal): Promise<ToolResult>;
  /** Synchronous observation after permits are released; failures cannot change the outcome. */
  ended?(outcome: ToolLifecycleOutcome): void;
}

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  events: ToolEventSink;
  gate: ToolExecutionGate;
  lifecycle?: ToolLifecycleHooks;
  policyResolver?: ToolAccessPolicyResolver;
  snapshotProvider?: SnapshotProvider;
  snapshotPolicy?: SnapshotPolicy;
  fileReadState?: FileReadStateStore;
  maxResultOutputBytes?: number;
  maxPersistedOutputBytes?: number;
  maxPersistedOutputDirectoryBytes?: number;
  createId?: (prefix: string) => string;
  now?: () => TimestampMs;
  executionContext?: <T>(operation: () => T) => T;
}

export interface ExecuteToolInput {
  sessionId: SessionId;
  turnId: TurnId;
  callId?: ToolCallId;
  providerCallId?: string;
  toolName: string;
  input: unknown;
  cwd: string;
  policy?: ToolAccessPolicy;
  signal?: AbortSignal;
  prepared?: PreparedToolCall;
  parentCallId?: ToolCallId;
  dispatchScope?: ToolDispatchScope;
  /** Trusted catalog snapshot held by the parent orchestration call. */
  catalogTool?: ChiliToolDefinition;
  catalogRevision?: number;
}

export interface PreparedToolCall {
  readonly toolName: string;
  readonly validatedInput: unknown;
  readonly registryRevision?: number;
  readonly isConcurrencySafe: boolean;
}

export interface ToolPolicyContext {
  sessionId: SessionId;
  turnId?: TurnId;
  cwd: string;
}

export interface ToolAccessPolicy {
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
  writeScope?: readonly string[];
  executeScope?: readonly string[];
  metadata?: Record<string, unknown>;
}

/** Explicit filesystem denials shared by direct tools and enforcing process backends. */
export interface ToolResourceDenials {
  readPaths: readonly string[];
  writePaths: readonly string[];
}

export interface ToolAccessPolicyResolver {
  resolve(context: ToolPolicyContext): Promise<ToolAccessPolicy | undefined> | ToolAccessPolicy | undefined;
}

export type ExecuteToolResult =
  | { status: "completed"; callId: ToolCallId; result: ToolResult }
  | { status: "failed"; callId: ToolCallId; error: Error }
  | { status: "cancelled"; callId: ToolCallId; error: Error };

export interface SnapshotCreateRequest {
  cwd: string;
  sessionId: SessionId;
  callId: ToolCallId;
  toolName: string;
  patterns: string[];
  reason: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  assertCurrentAuthorization?: () => Promise<void>;
}

export interface SnapshotRecord {
  id: SnapshotId;
  cwd: string;
  paths: string[];
  createdAt: TimestampMs;
}

export interface SnapshotRevertResult {
  snapshotId: SnapshotId;
  paths: string[];
  restored: string[];
  removed: string[];
}

export interface SnapshotRevertOptions {
  cwd?: string;
  signal?: AbortSignal;
}

export interface SnapshotProvider {
  create(request: SnapshotCreateRequest): Promise<SnapshotRecord | undefined>;
  revert(snapshotId: SnapshotId, options?: SnapshotRevertOptions): Promise<SnapshotRevertResult>;
}

export type SnapshotPolicy = (input: {
  tool: ChiliToolDefinition;
  spec: ToolResourceSpecWithDefaults;
}) => boolean;

export type ToolContextFactory = (tool: ChiliToolDefinition, input: ExecuteToolInput, callId: ToolCallId) => ToolExecutionContext;

export type ToolEventFactory<TType extends RuntimeEvent["type"], TPayload> = (
  type: TType,
  payload: TPayload,
) => Extract<RuntimeEvent, EventEnvelope<TType, TPayload>>;
