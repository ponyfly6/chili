import type {
  ApprovalDecision,
  ApprovalId,
  ApprovalScope,
  ChiliEvent,
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
import type { PermissionDecision } from "@chili/policy";
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
  approval?(input: Input): false | ToolApprovalSpec;
  execute(input: Input, context: ChiliToolExecutionContext): Promise<Output>;
}

export interface ToolApprovalSpec {
  permission?: string;
  patterns: string[];
  maxApprovalScope?: ApprovalScope;
  metadata?: Record<string, unknown>;
}

export type ToolApprovalSpecWithDefaults =
  & Required<Omit<ToolApprovalSpec, "maxApprovalScope">>
  & Pick<ToolApprovalSpec, "maxApprovalScope">;

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
  /** Backend-enforced resource constraints; approval is not an isolation boundary. */
  executionPolicy?: ToolAccessPolicy;
  /** Recheck revocation after waiting on a resource lock, immediately before effects. */
  assertCurrentAuthorization?: () => Promise<void>;
  currentResourceDenials?: () => Promise<ToolResourceDenials | undefined>;
  assertFileResourceAccess?: (paths: readonly string[], access: "read" | "write") => Promise<void>;
  fileReads?: FileReadStateStore;
  visibleTools?: () => Promise<ChiliToolDefinition[]> | ChiliToolDefinition[];
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
  /** Defaults to true: runtime advertises the complete catalog, without hidden activation. */
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
  publish(event: ChiliEvent): Promise<void>;
}

export interface ApprovalBrokerRequest {
  approvalId: ApprovalId;
  sessionId: SessionId;
  callId: ToolCallId;
  toolName: string;
  risk: ChiliToolDefinition["risk"];
  permission: string;
  patterns: string[];
  maxApprovalScope?: ApprovalScope;
  metadata?: Record<string, unknown>;
  workspaceRoot?: string;
}

export type ApprovalPreflightAction = "allow" | "ask" | "deny";

export interface ApprovalPreflightDecision extends Omit<PermissionDecision, "action"> {
  action: ApprovalPreflightAction;
  revision?: string;
}

export interface ApprovalPreflightRequest extends Omit<ApprovalBrokerRequest, "approvalId"> {}

/**
 * One ruleset observation shared by checks at a single execution boundary.
 * Capture again after waiting; this is not authority for the lifetime of a call.
 */
export interface ApprovalPolicySnapshot {
  preflight(): Promise<ApprovalPreflightDecision>;
  resourceDenials(): Promise<ToolResourceDenials | undefined>;
  assertFileResourceAccess(paths: readonly string[], access: "read" | "write"): Promise<void>;
}

export interface ApprovalResolution {
  decision: ApprovalDecision;
  /** The exact policy observation that accepted the decision. */
  authority: ApprovalPreflightDecision;
}

export interface ApprovalBroker {
  /** Optional snapshot API; simple brokers may implement only the legacy hooks. */
  capturePolicy?(request: ApprovalPreflightRequest): Promise<ApprovalPolicySnapshot>;
  /** Return the accepted version with its decision instead of rereading it later. */
  resolve?(request: ApprovalBrokerRequest, signal?: AbortSignal): Promise<ApprovalResolution>;
  preflight?(request: ApprovalPreflightRequest): Promise<ApprovalPreflightDecision>;
  decide(request: ApprovalBrokerRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  resourceDenials?(request: ApprovalPreflightRequest): Promise<ToolResourceDenials | undefined>;
  assertFileResourceAccess?(request: ApprovalPreflightRequest, paths: readonly string[], access: "read" | "write"): Promise<void>;
}

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  events: ToolEventSink;
  approvals: ApprovalBroker;
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
  teamId?: string;
  taskId?: string;
  memberPath?: string;
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
  spec: ToolApprovalSpecWithDefaults;
}) => boolean;

export type ToolContextFactory = (tool: ChiliToolDefinition, input: ExecuteToolInput, callId: ToolCallId) => ToolExecutionContext;

export type ToolEventFactory<TType extends ChiliEvent["type"], TPayload> = (
  type: TType,
  payload: TPayload,
) => Extract<ChiliEvent, EventEnvelope<TType, TPayload>>;
