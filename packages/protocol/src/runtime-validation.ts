import {
  parseUserInputAnswers,
  parseUserInputQuestions,
  type ChiliEvent,
  type RuntimeEvent,
  type PendingUserInputRequest,
} from "./event.js";
import {
  DELEGATION_POLICIES,
  DELEGATION_POLICY_SOURCES,
  REASONING_LEVELS,
  RUNTIME_MODEL_AUTH_SOURCES,
  RUNTIME_PERMISSION_PROFILE_IDS,
  SERVICE_TIERS,
  type ModelSelection,
  type RuntimeDelegationConfig,
  type RuntimeInterruptResult,
  type RuntimeMcpAuthResponse,
  type RuntimeMcpListResponse,
  type RuntimeMcpLogoutResponse,
  type RuntimeMcpReloadResponse,
  type RuntimeMcpRemoveServerResponse,
  type RuntimeMcpServerDescriptor,
  type RuntimeMcpStatusResponse,
  type RuntimeMcpToolsResponse,
  type RuntimeModelConfig,
  type RuntimeModelDescriptor,
  type RuntimePermissionConfig,
  type RuntimePermissionUpdateOptions,
  type RuntimePromptAccepted,
  type RuntimePromptResult,
  type RuntimeSessionRef,
} from "./runtime.js";
import type { Message } from "./message.js";
import type { RuntimeInputQueue, RuntimeSessionInput } from "./session-input.js";
import type { ExecutionIdentity } from "./execution-identity.js";
import type { PreparedModelIdentity } from "./prepared-request.js";
import { assertAgentSegment, normalizeAgentPath } from "./agent-path.js";
import type { PersistedToolPolicy, SessionAgentMetadata } from "./session-agent.js";
import type { MessageId } from "./ids.js";

const MAX_VALIDATION_PATH_CHARS = 512;
const MAX_VALIDATION_EXPECTATION_CHARS = 512;
const MAX_IDENTIFIER_CHARS = 512;
const MAX_TEXT_CHARS = 8_000_000;
const MAX_IMAGE_DATA_CHARS = 32_000_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f]/gu;
const UNSAFE_TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * A bounded, value-free error for data received across a process or network
 * boundary. Messages deliberately identify only the contract path and expected
 * shape so a hostile response cannot reflect secrets into logs.
 */
export class RuntimeValidationError extends TypeError {
  readonly code = "RUNTIME_VALIDATION_ERROR";
  declare readonly path: string;

  constructor(
    path: string,
    expectation: string,
  ) {
    const boundedPath = path
      .slice(0, MAX_VALIDATION_PATH_CHARS)
      .replace(CONTROL_CHARACTERS_GLOBAL, "?");
    const boundedExpectation = expectation
      .slice(0, MAX_VALIDATION_EXPECTATION_CHARS)
      .replace(CONTROL_CHARACTERS_GLOBAL, "?");
    super(`${boundedPath} ${boundedExpectation}`);
    this.name = "RuntimeValidationError";
    Object.defineProperty(this, "path", {
      configurable: false,
      enumerable: false,
      value: boundedPath,
      writable: false,
    });
  }
}

export type RuntimeParser<T> = (value: unknown, path: string) => T;

export function parseRuntimeRecord(value: unknown, path = "value"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeValidationError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

export function parseRuntimeObject<T extends object>(value: unknown, path = "value"): T {
  return parseRuntimeRecord(value, path) as T;
}

export function parseRuntimeArray<T>(
  value: unknown,
  itemParser: RuntimeParser<T>,
  path = "value",
): T[] {
  if (!Array.isArray(value)) throw new RuntimeValidationError(path, "must be an array");
  return value.map((item, index) => itemParser(item, `${path}[${index}]`));
}

export function parseRuntimeObjectArray<T extends object>(value: unknown, path = "value"): T[] {
  return parseRuntimeArray(value, parseRuntimeObject<T>, path);
}

export function parseRuntimeString(
  value: unknown,
  path = "value",
  options: { allowEmpty?: boolean; maxChars?: number; allowControls?: boolean } = {},
): string {
  if (typeof value !== "string") throw new RuntimeValidationError(path, "must be a string");
  if (options.allowEmpty !== true && value.length === 0) {
    throw new RuntimeValidationError(path, "must not be empty");
  }
  if (value.length > (options.maxChars ?? MAX_TEXT_CHARS)) {
    throw new RuntimeValidationError(path, `must not exceed ${options.maxChars ?? MAX_TEXT_CHARS} characters`);
  }
  if (options.allowControls !== true && UNSAFE_TEXT_CONTROL_CHARACTERS.test(value)) {
    throw new RuntimeValidationError(path, "must not contain unsafe control characters");
  }
  return value;
}

export function parseRuntimeIdentifier(value: unknown, path = "value"): string {
  const identifier = parseRuntimeString(value, path, { maxChars: MAX_IDENTIFIER_CHARS });
  if (CONTROL_CHARACTERS.test(identifier)) {
    throw new RuntimeValidationError(path, "must not contain control characters");
  }
  return identifier;
}

export function parseRuntimeBoolean(value: unknown, path = "value"): boolean {
  if (typeof value !== "boolean") throw new RuntimeValidationError(path, "must be a boolean");
  return value;
}

export function parseRuntimeFiniteNumber(value: unknown, path = "value"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RuntimeValidationError(path, "must be a finite number");
  }
  return value;
}

export function parseRuntimeNonNegativeInteger(value: unknown, path = "value"): number {
  const number = parseRuntimeFiniteNumber(value, path);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RuntimeValidationError(path, "must be a non-negative integer");
  }
  return number;
}

export function parseRuntimePositiveInteger(value: unknown, path = "value"): number {
  const number = parseRuntimeFiniteNumber(value, path);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RuntimeValidationError(path, "must be a positive integer");
  }
  return number;
}

export function parseRuntimeStringArray(value: unknown, path = "value"): string[] {
  return parseRuntimeArray(value, (item, itemPath) => parseRuntimeString(item, itemPath), path);
}

export function parseRuntimeStringRecord(value: unknown, path = "value"): Record<string, string> {
  const record = parseRuntimeRecord(value, path);
  const parsed: Record<string, string> = {};
  for (const [index, [key, item]] of Object.entries(record).entries()) {
    parsed[key] = parseRuntimeString(item, `${path}[${index}]`, { allowEmpty: true });
  }
  return parsed;
}

export function parseRuntimeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path = "value",
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new RuntimeValidationError(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function rejectRuntimeUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path = "value",
): void {
  const supported = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !supported.has(key));
  if (unexpected !== undefined) {
    throw new RuntimeValidationError(`${path}.*`, "contains an unsupported field");
  }
}

export function parseRuntimeModelSelection(value: unknown, path = "modelSelection"): ModelSelection {
  const record = parseRuntimeRecord(value, path);
  const provider = parseRuntimeString(record.provider, `${path}.provider`);
  const model = parseRuntimeString(record.model, `${path}.model`);
  return { provider, model };
}

export function parseRuntimeSessionRef(value: unknown, path = "response"): RuntimeSessionRef {
  const record = parseRuntimeRecord(value, path);
  return { sessionId: parseRuntimeIdentifier(record.sessionId, `${path}.sessionId`) as RuntimeSessionRef["sessionId"] };
}

export function parseRuntimeModelDescriptor(value: unknown, path = "model"): RuntimeModelDescriptor {
  const record = parseRuntimeRecord(value, path);
  const descriptor: RuntimeModelDescriptor = {
    ...parseRuntimeModelSelection(record, path),
  };
  assignOptionalString(descriptor, "displayName", record.displayName, path);
  assignOptionalString(descriptor, "providerDisplayName", record.providerDisplayName, path);
  assignOptionalString(descriptor, "connectionLabel", record.connectionLabel, path);
  if (record.authSource !== undefined) {
    descriptor.authSource = parseRuntimeEnum(record.authSource, RUNTIME_MODEL_AUTH_SOURCES, `${path}.authSource`);
  }
  if (record.endpoint !== undefined) descriptor.endpoint = parseRuntimeEndpoint(record.endpoint, `${path}.endpoint`);
  assignOptionalBoolean(descriptor, "available", record.available, path);
  assignOptionalBoolean(descriptor, "default", record.default, path);
  if (record.capabilities !== undefined) {
    const capabilities = parseRuntimeRecord(record.capabilities, `${path}.capabilities`);
    descriptor.capabilities = {};
    for (const key of ["streaming", "reasoning", "toolCalls", "toolCallDeltas", "usage", "responseId"] as const) {
      if (capabilities[key] !== undefined) {
        descriptor.capabilities[key] = parseRuntimeBoolean(capabilities[key], `${path}.capabilities.${key}`);
      }
    }
  }
  if (record.inputCapabilities !== undefined) {
    descriptor.inputCapabilities = parseRuntimeStringArray(record.inputCapabilities, `${path}.inputCapabilities`);
  }
  assignOptionalPositiveInteger(descriptor, "contextWindowTokens", record.contextWindowTokens, path);
  assignOptionalPositiveInteger(descriptor, "maxOutputTokens", record.maxOutputTokens, path);
  if (record.reasoningLevels !== undefined) {
    descriptor.reasoningLevels = parseRuntimeArray(
      record.reasoningLevels,
      (item, itemPath) => parseRuntimeEnum(item, REASONING_LEVELS, itemPath),
      `${path}.reasoningLevels`,
    );
  }
  if (record.serviceTiers !== undefined) {
    descriptor.serviceTiers = parseRuntimeArray(
      record.serviceTiers,
      (item, itemPath) => parseRuntimeEnum(item, SERVICE_TIERS, itemPath),
      `${path}.serviceTiers`,
    );
  }
  return descriptor;
}

export function parseRuntimeModelDescriptorArray(value: unknown, path = "response"): RuntimeModelDescriptor[] {
  return parseRuntimeArray(value, parseRuntimeModelDescriptor, path);
}

export function parseRuntimeModelConfig(value: unknown, path = "response"): RuntimeModelConfig {
  const record = parseRuntimeRecord(value, path);
  const config: RuntimeModelConfig = {
    sessionId: parseRuntimeIdentifier(record.sessionId, `${path}.sessionId`) as RuntimeModelConfig["sessionId"],
    availableReasoningLevels: parseRuntimeArray(
      record.availableReasoningLevels,
      (item, itemPath) => parseRuntimeEnum(item, REASONING_LEVELS, itemPath),
      `${path}.availableReasoningLevels`,
    ),
    models: parseRuntimeArray(record.models, parseRuntimeModelDescriptor, `${path}.models`),
  };
  if (record.modelSelection !== undefined) {
    config.modelSelection = parseRuntimeModelSelection(record.modelSelection, `${path}.modelSelection`);
  }
  if (record.reasoningLevel !== undefined) {
    config.reasoningLevel = parseRuntimeEnum(record.reasoningLevel, REASONING_LEVELS, `${path}.reasoningLevel`);
  }
  if (record.serviceTier !== undefined) {
    config.serviceTier = parseRuntimeEnum(record.serviceTier, SERVICE_TIERS, `${path}.serviceTier`);
  }
  return config;
}

export function parseRuntimeDelegationConfig(value: unknown, path = "response"): RuntimeDelegationConfig {
  const record = parseRuntimeRecord(value, path);
  return {
    sessionId: parseRuntimeIdentifier(record.sessionId, `${path}.sessionId`) as RuntimeDelegationConfig["sessionId"],
    policy: parseRuntimeEnum(record.policy, DELEGATION_POLICIES, `${path}.policy`),
    source: parseRuntimeEnum(record.source, DELEGATION_POLICY_SOURCES, `${path}.source`),
  };
}

export function parseRuntimePermissionConfig(value: unknown, path = "response"): RuntimePermissionConfig {
  const record = parseRuntimeRecord(value, path);
  return {
    profile: parseRuntimeEnum(record.profile, RUNTIME_PERMISSION_PROFILE_IDS, `${path}.profile`),
    reviewInstructions: parseRuntimeReviewInstructions(record.reviewInstructions, `${path}.reviewInstructions`),
    defaultReviewInstructions: parseRuntimeReviewInstructions(record.defaultReviewInstructions, `${path}.defaultReviewInstructions`),
    ...(record.reviewerModel !== undefined ? { reviewerModel: parseRuntimeReviewerModelSelection(record.reviewerModel, `${path}.reviewerModel`) } : {}),
    profiles: parseRuntimeArray(record.profiles, (item, itemPath) => {
      const profile = parseRuntimeRecord(item, itemPath);
      const parsed: RuntimePermissionConfig["profiles"][number] = {
        id: parseRuntimeEnum(profile.id, RUNTIME_PERMISSION_PROFILE_IDS, `${itemPath}.id`),
        label: parseRuntimeString(profile.label, `${itemPath}.label`),
        description: parseRuntimeString(profile.description, `${itemPath}.description`, { allowEmpty: true }),
        current: parseRuntimeBoolean(profile.current, `${itemPath}.current`),
      };
      if (profile.disabledReason !== undefined) {
        parsed.disabledReason = parseRuntimeString(profile.disabledReason, `${itemPath}.disabledReason`);
      }
      return parsed;
    }, `${path}.profiles`),
  };
}

function parseRuntimeReviewerModelSelection(value: unknown, path: string): ModelSelection {
  const record = parseRuntimeRecord(value, path);
  rejectRuntimeUnknownFields(record, ["provider", "model"], path);
  const selection = parseRuntimeModelSelection(record, path);
  selection.provider = selection.provider.trim();
  selection.model = selection.model.trim();
  if (!selection.provider) throw new RuntimeValidationError(`${path}.provider`, "must not be blank");
  if (!selection.model) throw new RuntimeValidationError(`${path}.model`, "must not be blank");
  return selection;
}

export function parseRuntimeReviewInstructions(value: unknown, path = "reviewInstructions"): string {
  const instructions = parseRuntimeString(value, path, { maxChars: 32_000 });
  if (instructions.trim().length === 0) throw new RuntimeValidationError(path, "must not be blank");
  return instructions;
}

/** Parse only the customizable review settings; profile selection is validated separately. */
export function parseRuntimePermissionUpdateOptions(value: unknown, path = "options"): RuntimePermissionUpdateOptions {
  const record = parseRuntimeRecord(value, path);
  rejectRuntimeUnknownFields(record, ["reviewInstructions", "reviewerModel"], path);
  const options: RuntimePermissionUpdateOptions = {};
  if (record.reviewInstructions !== undefined) {
    options.reviewInstructions = parseRuntimeReviewInstructions(record.reviewInstructions, `${path}.reviewInstructions`);
  }
  if (record.reviewerModel === null) {
    options.reviewerModel = null;
  } else if (record.reviewerModel !== undefined) {
    options.reviewerModel = parseRuntimeReviewerModelSelection(record.reviewerModel, `${path}.reviewerModel`);
  }
  return options;
}

export function parseRuntimePromptAccepted(value: unknown, path = "response"): RuntimePromptAccepted {
  const record = parseRuntimeRecord(value, path);
  if (record.status !== "accepted") throw new RuntimeValidationError(`${path}.status`, "must be accepted");
  return {
    status: "accepted",
    sessionId: parseRuntimeIdentifier(record.sessionId, `${path}.sessionId`) as RuntimePromptAccepted["sessionId"],
    ...(record.input !== undefined ? { input: parseRuntimeSessionInput(record.input, `${path}.input`) } : {}),
    ...(record.queue !== undefined ? { queue: parseRuntimeInputQueue(record.queue, `${path}.queue`) } : {}),
  };
}

export function parseRuntimeSessionInput(value: unknown, path = "input"): RuntimeSessionInput {
  const row = parseRuntimeRecord(value, path);
  const input: RuntimeSessionInput = {
    inputId: parseRuntimeIdentifier(row.inputId, `${path}.inputId`),
    submissionId: parseRuntimeIdentifier(row.submissionId, `${path}.submissionId`),
    sessionId: parseRuntimeIdentifier(row.sessionId, `${path}.sessionId`) as RuntimeSessionInput["sessionId"],
    mode: parseRuntimeEnum(row.mode, ["start", "queue", "steer"] as const, `${path}.mode`),
    state: parseRuntimeEnum(row.state, ["pending", "claimed", "settled"] as const, `${path}.state`),
    revision: parseRuntimeNonNegativeInteger(row.revision, `${path}.revision`),
    sequence: parseRuntimeNonNegativeInteger(row.sequence, `${path}.sequence`),
    text: parseRuntimeString(row.text, `${path}.text`, { allowEmpty: true }),
    acceptedAt: parseRuntimeNonNegativeInteger(row.acceptedAt, `${path}.acceptedAt`),
    updatedAt: parseRuntimeNonNegativeInteger(row.updatedAt, `${path}.updatedAt`),
  };
  assignOptionalString(input, "executionRef", row.executionRef, path);
  assignOptionalString(input, "messageId", row.messageId, path);
  if (row.resultMessageId !== undefined) {
    input.resultMessageId = parseRuntimeIdentifier(row.resultMessageId, `${path}.resultMessageId`) as MessageId;
  }
  assignOptionalString(input, "turnId", row.turnId, path);
  assignOptionalString(input, "error", row.error, path);
  if (row.outcome !== undefined) input.outcome = parseRuntimeEnum(row.outcome, ["completed", "failed", "cancelled", "interrupted"] as const, `${path}.outcome`);
  return input;
}

export function parseRuntimeInputQueue(value: unknown, path = "queue"): RuntimeInputQueue {
  const row = parseRuntimeRecord(value, path);
  const queue: RuntimeInputQueue = {
    sessionId: parseRuntimeIdentifier(row.sessionId, `${path}.sessionId`) as RuntimeInputQueue["sessionId"],
    paused: parseRuntimeBoolean(row.paused, `${path}.paused`),
    revision: parseRuntimeNonNegativeInteger(row.revision, `${path}.revision`),
    pendingCount: parseRuntimeNonNegativeInteger(row.pendingCount, `${path}.pendingCount`),
    interruptedCount: parseRuntimeNonNegativeInteger(row.interruptedCount, `${path}.interruptedCount`),
    items: parseRuntimeArray(row.items, parseRuntimeSessionInput, `${path}.items`),
  };
  if (queue.items.some((item) => item.sessionId !== queue.sessionId)) throw new RuntimeValidationError(path, "must contain inputs from the same session");
  assignOptionalString(queue, "executionRef", row.executionRef, path);
  return queue;
}

export function parseRuntimePromptResult(value: unknown, path = "response"): RuntimePromptResult {
  const record = parseRuntimeRecord(value, path);
  const status = parseRuntimeEnum(record.status, [
    "completed",
    "failed",
    "cancelled",
    "max_turns",
  ] as const, `${path}.status`);
  const turns = parseRuntimeArray(record.turns, (item, itemPath) => {
    const turn = parseRuntimeRecord(item, itemPath);
    const turnStatus = parseRuntimeEnum(turn.status, ["completed", "failed", "cancelled"] as const, `${itemPath}.status`);
    if (turnStatus === "completed") {
      const parsed: Extract<RuntimePromptResult["turns"][number], { status: "completed" }> = {
        status: turnStatus,
        turnId: parseRuntimeIdentifier(turn.turnId, `${itemPath}.turnId`) as RuntimePromptResult["turns"][number]["turnId"],
        assistantMessageId: parseRuntimeIdentifier(turn.assistantMessageId, `${itemPath}.assistantMessageId`) as Extract<RuntimePromptResult["turns"][number], { status: "completed" }>["assistantMessageId"],
      };
      if (turn.finishReason !== undefined) {
        parsed.finishReason = parseRuntimeString(turn.finishReason, `${itemPath}.finishReason`, { allowEmpty: true });
      }
      return parsed;
    }
    const parsed: Extract<RuntimePromptResult["turns"][number], { status: "failed" | "cancelled" }> = {
      status: turnStatus,
      turnId: parseRuntimeIdentifier(turn.turnId, `${itemPath}.turnId`) as RuntimePromptResult["turns"][number]["turnId"],
      error: parseRuntimeError(turn.error, `${itemPath}.error`),
    };
    if (turn.assistantMessageId !== undefined) {
      parsed.assistantMessageId = parseRuntimeIdentifier(
        turn.assistantMessageId,
        `${itemPath}.assistantMessageId`,
      ) as NonNullable<Extract<RuntimePromptResult["turns"][number], { status: "failed" | "cancelled" }>["assistantMessageId"]>;
    }
    return parsed;
  }, `${path}.turns`);
  if (status === "completed") {
    const result: Extract<RuntimePromptResult, { status: "completed" }> = { status, turns };
    if (record.finishReason !== undefined) {
      result.finishReason = parseRuntimeString(record.finishReason, `${path}.finishReason`, { allowEmpty: true });
    }
    return result;
  }
  const result: Exclude<RuntimePromptResult, { status: "completed" }> = { status, turns };
  if (record.error !== undefined) result.error = parseRuntimeError(record.error, `${path}.error`);
  if (record.finishReason !== undefined) {
    result.finishReason = parseRuntimeString(record.finishReason, `${path}.finishReason`, { allowEmpty: true });
  }
  return result;
}

export function parseRuntimeMessage(value: unknown, path = "message"): Message {
  const record = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(record.id, `${path}.id`);
  parseRuntimeIdentifier(record.sessionId, `${path}.sessionId`);
  parseRuntimeEnum(record.role, ["system", "user", "assistant", "tool"] as const, `${path}.role`);
  parseRuntimeArray(record.parts, (item, itemPath) => {
    validateMessagePart(item, itemPath);
    return item;
  }, `${path}.parts`);
  optionalEventIdentifier(record.parentId, `${path}.parentId`);
  optionalEventIdentifier(record.turnId, `${path}.turnId`);
  parseRuntimeNonNegativeInteger(record.createdAt, `${path}.createdAt`);
  return record as unknown as Message;
}

export function parseRuntimeMessageArray(value: unknown, path = "response"): Message[] {
  return parseRuntimeArray(value, parseRuntimeMessage, path);
}

export function parsePendingUserInputRequest(value: unknown, path = "request"): PendingUserInputRequest {
  const record = parseRuntimeRecord(value, path);
  const parsed: PendingUserInputRequest = {
    id: parseRuntimeIdentifier(record.id, `${path}.id`) as PendingUserInputRequest["id"],
    sessionId: parseRuntimeIdentifier(record.sessionId, `${path}.sessionId`) as PendingUserInputRequest["sessionId"],
    callId: parseRuntimeIdentifier(record.callId, `${path}.callId`) as PendingUserInputRequest["callId"],
    questions: safelyParseUserInputQuestions(record.questions, `${path}.questions`),
    createdAt: parseRuntimeNonNegativeInteger(record.createdAt, `${path}.createdAt`),
  };
  return parsed;
}

export function parsePendingUserInputRequestArray(value: unknown, path = "response"): PendingUserInputRequest[] {
  return parseRuntimeArray(value, parsePendingUserInputRequest, path);
}

export function parseRuntimeInterruptResult(value: unknown, path = "response"): RuntimeInterruptResult {
  const record = parseRuntimeRecord(value, path);
  return { interrupted: parseRuntimeBoolean(record.interrupted, `${path}.interrupted`) };
}

const RUNTIME_MCP_SERVER_STATUSES = [
  "unknown",
  "disabled",
  "stopped",
  "starting",
  "running",
  "error",
  "auth_required",
] as const;
const RUNTIME_MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;

export function parseRuntimeMcpServerDescriptor(value: unknown, path = "server"): RuntimeMcpServerDescriptor {
  const record = parseRuntimeRecord(value, path);
  const descriptor: RuntimeMcpServerDescriptor = {
    name: parseRuntimeString(record.name, `${path}.name`),
    status: parseRuntimeEnum(record.status, RUNTIME_MCP_SERVER_STATUSES, `${path}.status`),
    enabled: parseRuntimeBoolean(record.enabled, `${path}.enabled`),
  };
  if (record.transport !== undefined) {
    descriptor.transport = parseRuntimeEnum(record.transport, RUNTIME_MCP_TRANSPORTS, `${path}.transport`);
  }
  for (const key of ["command", "url", "description", "error"] as const) {
    assignOptionalString(descriptor, key, record[key], path);
  }
  if (record.args !== undefined) descriptor.args = parseRuntimeStringArray(record.args, `${path}.args`);
  assignOptionalNonNegativeInteger(descriptor, "toolCount", record.toolCount, path);
  assignOptionalNonNegativeInteger(descriptor, "updatedAt", record.updatedAt, path);
  if (record.auth !== undefined) {
    const auth = parseRuntimeRecord(record.auth, `${path}.auth`);
    descriptor.auth = {
      required: parseRuntimeBoolean(auth.required, `${path}.auth.required`),
    };
    assignOptionalBoolean(descriptor.auth, "authenticated", auth.authenticated, `${path}.auth`);
    assignOptionalString(descriptor.auth, "provider", auth.provider, `${path}.auth`);
    assignOptionalString(descriptor.auth, "error", auth.error, `${path}.auth`);
    if (auth.scopes !== undefined) descriptor.auth.scopes = parseRuntimeStringArray(auth.scopes, `${path}.auth.scopes`);
  }
  return descriptor;
}

export function parseRuntimeMcpListResponse(value: unknown, path = "response"): RuntimeMcpListResponse {
  const record = parseRuntimeRecord(value, path);
  return { servers: parseRuntimeArray(record.servers, parseRuntimeMcpServerDescriptor, `${path}.servers`) };
}

export function parseRuntimeMcpStatusResponse(value: unknown, path = "response"): RuntimeMcpStatusResponse {
  const record = parseRuntimeRecord(value, path);
  const summary = parseRuntimeRecord(record.summary, `${path}.summary`);
  return {
    servers: parseRuntimeArray(record.servers, parseRuntimeMcpServerDescriptor, `${path}.servers`),
    summary: {
      total: parseRuntimeNonNegativeInteger(summary.total, `${path}.summary.total`),
      running: parseRuntimeNonNegativeInteger(summary.running, `${path}.summary.running`),
      disabled: parseRuntimeNonNegativeInteger(summary.disabled, `${path}.summary.disabled`),
      authRequired: parseRuntimeNonNegativeInteger(summary.authRequired, `${path}.summary.authRequired`),
      errored: parseRuntimeNonNegativeInteger(summary.errored, `${path}.summary.errored`),
    },
  };
}

export function parseRuntimeMcpReloadResponse(value: unknown, path = "response"): RuntimeMcpReloadResponse {
  const record = parseRuntimeRecord(value, path);
  return {
    reloaded: parseRuntimeBoolean(record.reloaded, `${path}.reloaded`),
    servers: parseRuntimeArray(record.servers, parseRuntimeMcpServerDescriptor, `${path}.servers`),
    errors: parseRuntimeArray(record.errors, (item, itemPath) => {
      const error = parseRuntimeRecord(item, itemPath);
      const parsed: RuntimeMcpReloadResponse["errors"][number] = {
        message: parseRuntimeString(error.message, `${itemPath}.message`),
      };
      if (error.server !== undefined) parsed.server = parseRuntimeString(error.server, `${itemPath}.server`);
      return parsed;
    }, `${path}.errors`),
  };
}

export function parseRuntimeMcpRemoveServerResponse(value: unknown, path = "response"): RuntimeMcpRemoveServerResponse {
  const record = parseRuntimeRecord(value, path);
  return {
    server: parseRuntimeString(record.server, `${path}.server`),
    removed: parseRuntimeBoolean(record.removed, `${path}.removed`),
  };
}

export function parseRuntimeMcpToolsResponse(value: unknown, path = "response"): RuntimeMcpToolsResponse {
  const record = parseRuntimeRecord(value, path);
  return {
    server: parseRuntimeString(record.server, `${path}.server`),
    tools: parseRuntimeArray(record.tools, (item, itemPath) => {
      const tool = parseRuntimeRecord(item, itemPath);
      const parsed: RuntimeMcpToolsResponse["tools"][number] = {
        name: parseRuntimeString(tool.name, `${itemPath}.name`),
      };
      if (tool.description !== undefined) parsed.description = parseRuntimeString(tool.description, `${itemPath}.description`, { allowEmpty: true });
      if (tool.inputSchema !== undefined) parsed.inputSchema = tool.inputSchema;
      if (tool.annotations !== undefined) parsed.annotations = parseRuntimeRecord(tool.annotations, `${itemPath}.annotations`);
      return parsed;
    }, `${path}.tools`),
  };
}

export function parseRuntimeMcpAuthResponse(value: unknown, path = "response"): RuntimeMcpAuthResponse {
  const record = parseRuntimeRecord(value, path);
  const response: RuntimeMcpAuthResponse = {
    server: parseRuntimeString(record.server, `${path}.server`),
    status: parseRuntimeEnum(record.status, ["authenticated", "pending", "unsupported"] as const, `${path}.status`),
  };
  assignOptionalString(response, "url", record.url, path);
  assignOptionalString(response, "message", record.message, path);
  return response;
}

export function parseRuntimeMcpLogoutResponse(value: unknown, path = "response"): RuntimeMcpLogoutResponse {
  const record = parseRuntimeRecord(value, path);
  return {
    server: parseRuntimeString(record.server, `${path}.server`),
    loggedOut: parseRuntimeBoolean(record.loggedOut, `${path}.loggedOut`),
  };
}

const RUNTIME_EVENT_TYPES = [
  "session.tools_loaded",
  "session.input_queue_changed",
  "session.created",
  "session.identity_bound",
  "session.renamed",
  "session.status_changed",
  "session.model_changed",
  "session.reasoning_changed",
  "session.service_tier_changed",
  "session.delegation_changed",
  "session.archived",
  "turn.started",
  "model.request_prepared",
  "model.request_identity",
  "turn.model_metadata",
  "turn.completed",
  "turn.compaction_requested",
  "turn.compaction_started",
  "turn.compaction_completed",
  "turn.compaction_failed",
  "turn.retry_scheduled",
  "turn.guard_triggered",
  "message.created",
  "message.part_added",
  "message.part_delta",
  "tool.call_started",
  "tool.call_updated",
  "tool.output_delta",
  "tool.call_finished",
  "approval.requested",
  "approval.resolved",
  "user_input.requested",
  "user_input.resolved",
  "user_input.cancelled",
  "snapshot.created",
  "snapshot.reverted",
  "mcp.server_status_changed",
  "mcp.tools_changed",
  "mcp.prompts_changed",
  "mcp.resources_changed",
  "mcp.diagnostic",
  "mcp.progress",
] as const satisfies readonly RuntimeEvent["type"][];

const SESSION_SCOPED_EVENT_TYPES = new Set<ChiliEvent["type"]>([
  "session.tools_loaded",
  "session.created",
  "session.identity_bound",
  "session.renamed",
  "session.status_changed",
  "session.model_changed",
  "session.reasoning_changed",
  "session.service_tier_changed",
  "session.delegation_changed",
  "session.archived",
  "user_input.requested",
  "user_input.resolved",
  "user_input.cancelled",
]);

/**
 * Validates the stable event transport envelope and preserves unknown payload
 * fields for forward compatibility. Known event types cannot arrive with a
 * scalar/array payload, and session-scoped events must carry a session id.
 */
export function parseChiliEvent(value: unknown, path = "event"): ChiliEvent {
  const record = parseRuntimeRecord(value, path);
  const id = parseRuntimeIdentifier(record.id, `${path}.id`);
  const type = parseRuntimeEnum(record.type, RUNTIME_EVENT_TYPES, `${path}.type`);
  parseRuntimeNonNegativeInteger(record.time, `${path}.time`);
  const sessionId = record.sessionId === undefined
    ? undefined
    : parseRuntimeIdentifier(record.sessionId, `${path}.sessionId`);
  if (SESSION_SCOPED_EVENT_TYPES.has(type) && record.sessionId === undefined) {
    throw new RuntimeValidationError(`${path}.sessionId`, "is required for this event type");
  }
  const payload = parseRuntimeRecord(record.payload, `${path}.payload`);
  validateRuntimeEventPayload(type, payload, `${path}.payload`, sessionId, id);
  if (type === "model.request_prepared" && payload.contentVersion === undefined) {
    const request = parseRuntimeRecord(payload.request, `${path}.payload.request`);
    return { ...record, payload: { ...payload, contentVersion: request.contentVersion } } as unknown as ChiliEvent;
  }
  return record as unknown as ChiliEvent;
}

export function parseRuntimeEvent(value: unknown, path = "event"): RuntimeEvent {
  return parseChiliEvent(value, path);
}

export function parseRuntimeExecutionIdentity(value: unknown, path = "identity"): ExecutionIdentity {
  const identity = parseRuntimeRecord(value, path);
  rejectRuntimeUnknownFields(identity, ["profileId", "profilePath", "authPath", "projectId", "projectRoot", "workspaceId", "workspaceRoot"], path);
  return {
    profileId: parseRuntimeIdentifier(identity.profileId, `${path}.profileId`),
    profilePath: parseRuntimeString(identity.profilePath, `${path}.profilePath`),
    ...(identity.authPath !== undefined ? { authPath: parseRuntimeString(identity.authPath, `${path}.authPath`) } : {}),
    projectId: parseRuntimeIdentifier(identity.projectId, `${path}.projectId`),
    projectRoot: parseRuntimeString(identity.projectRoot, `${path}.projectRoot`),
    workspaceId: parseRuntimeIdentifier(identity.workspaceId, `${path}.workspaceId`),
    workspaceRoot: parseRuntimeString(identity.workspaceRoot, `${path}.workspaceRoot`),
  };
}

/** Invalid stored constraints must fail closed instead of being dropped. */
export function parsePersistedToolPolicy(value: unknown, path = "policy"): PersistedToolPolicy {
  const policy = parseSessionAgentRecord(value, path);
  const fields = ["allowedTools", "deniedTools", "writeScope", "executeScope"] as const;
  rejectRuntimeUnknownFields(policy, fields, path);
  const parsed: PersistedToolPolicy = {};
  for (const field of fields) {
    const items = policy[field];
    if (items === undefined) continue;
    if (!Array.isArray(items)) throw new RuntimeValidationError(`${path}.${field}`, "must be an array");
    // Array.from also validates sparse entries, which JSON would turn into null.
    parsed[field] = Array.from(items, (item, index) => parseRuntimeString(item, `${path}.${field}[${index}]`));
  }
  return parsed;
}

export function parseSessionAgentMetadata(value: unknown, path = "agent"): SessionAgentMetadata {
  const agent = parseSessionAgentRecord(value, path);
  rejectRuntimeUnknownFields(agent, ["parentSessionId", "name", "path", "policy"], path);
  const parentSessionId = parseRuntimeIdentifier(agent.parentSessionId, `${path}.parentSessionId`) as SessionAgentMetadata["parentSessionId"];
  const name = parseRuntimeIdentifier(agent.name, `${path}.name`);
  try {
    assertAgentSegment(name);
  } catch {
    throw new RuntimeValidationError(`${path}.name`, "must be an agent path segment");
  }
  const agentPath = parseRuntimeIdentifier(agent.path, `${path}.path`);
  let normalized: SessionAgentMetadata["path"];
  try {
    normalized = normalizeAgentPath(agentPath);
  } catch {
    throw new RuntimeValidationError(`${path}.path`, "must be a canonical absolute agent path");
  }
  if (agentPath !== normalized || !normalized.endsWith(`/${name}`) || normalized.split("/").length < 3) {
    throw new RuntimeValidationError(`${path}.path`, "must be a canonical child agent path ending in its name");
  }
  return { parentSessionId, name, path: normalized, policy: parsePersistedToolPolicy(agent.policy, `${path}.policy`) };
}

function parseSessionAgentRecord(value: unknown, path: string): Record<string, unknown> {
  const record = parseRuntimeRecord(value, path);
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RuntimeValidationError(path, "must be a plain JSON object");
  }
  return record;
}

export function parseRuntimePreparedModelIdentity(value: unknown, path = "identity"): PreparedModelIdentity {
  const identity = parseRuntimeRecord(value, path);
  rejectRuntimeUnknownFields(identity, ["provider", "model", "accountId", "credentialVersion", "profileId"], path);
  const parsed: PreparedModelIdentity = {
    provider: parseRuntimeIdentifier(identity.provider, `${path}.provider`),
    model: parseRuntimeIdentifier(identity.model, `${path}.model`),
  };
  if (identity.accountId !== undefined) parsed.accountId = parseRuntimeIdentifier(identity.accountId, `${path}.accountId`);
  if (identity.profileId !== undefined) parsed.profileId = parseRuntimeIdentifier(identity.profileId, `${path}.profileId`);
  if (identity.credentialVersion !== undefined) {
    parsed.credentialVersion = typeof identity.credentialVersion === "number"
      ? parseRuntimeNonNegativeInteger(identity.credentialVersion, `${path}.credentialVersion`)
      : parseRuntimeIdentifier(identity.credentialVersion, `${path}.credentialVersion`);
  }
  return parsed;
}

export function parseChiliEventArray(value: unknown, path = "response"): ChiliEvent[] {
  return parseRuntimeArray(value, parseChiliEvent, path);
}

function validateRuntimeEventPayload(
  type: RuntimeEvent["type"],
  payload: Record<string, unknown>,
  path: string,
  envelopeSessionId: string | undefined,
  _eventId: string,
): void {
  switch (type) {
    case "session.tools_loaded":
      matchingEventSessionId(payload.sessionId, envelopeSessionId, `${path}.sessionId`);
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      parseRuntimeIdentifier(payload.callId, `${path}.callId`);
      parseRuntimeStringArray(payload.names, `${path}.names`);
      return;
    case "session.input_queue_changed":
      matchingEventSessionId(payload.sessionId, envelopeSessionId, `${path}.sessionId`);
      parseRuntimeInputQueue(payload, path);
      return;
    case "session.created":
      matchingEventSessionId(payload.sessionId, envelopeSessionId, `${path}.sessionId`);
      parseRuntimeString(payload.cwd, `${path}.cwd`);
      if (payload.identity !== undefined) parseRuntimeExecutionIdentity(payload.identity, `${path}.identity`);
      if (payload.agent !== undefined) {
        const agent = parseSessionAgentMetadata(payload.agent, `${path}.agent`);
        if (agent.parentSessionId === envelopeSessionId) {
          throw new RuntimeValidationError(`${path}.agent.parentSessionId`, "must identify a different session");
        }
      }
      return;
    case "session.identity_bound":
      matchingEventSessionId(payload.sessionId, envelopeSessionId, `${path}.sessionId`);
      parseRuntimeExecutionIdentity(payload.identity, `${path}.identity`);
      return;
    case "session.renamed":
      matchingEventSessionId(payload.sessionId, envelopeSessionId, `${path}.sessionId`);
      parseRuntimeString(payload.title, `${path}.title`);
      return;
    case "session.status_changed":
      matchingEventSessionId(payload.sessionId, envelopeSessionId, `${path}.sessionId`);
      parseRuntimeEnum(payload.status, [
        "idle",
        "running",
        "waiting_for_approval",
        "cancelling",
        "cancelled",
        "failed",
      ] as const, `${path}.status`);
      optionalEventIdentifier(payload.turnId, `${path}.turnId`);
      optionalEventString(payload.reason, `${path}.reason`);
      return;
    case "session.model_changed":
      matchingEventSessionId(payload.sessionId, envelopeSessionId, `${path}.sessionId`);
      parseRuntimeModelSelection(payload.modelSelection, `${path}.modelSelection`);
      return;
    case "session.reasoning_changed":
      matchingEventSessionId(payload.sessionId, envelopeSessionId, `${path}.sessionId`);
      parseRuntimeEnum(payload.reasoningLevel, REASONING_LEVELS, `${path}.reasoningLevel`);
      return;
    case "session.service_tier_changed":
      matchingEventSessionId(payload.sessionId, envelopeSessionId, `${path}.sessionId`);
      parseRuntimeEnum(payload.serviceTier, SERVICE_TIERS, `${path}.serviceTier`);
      return;
    case "session.delegation_changed":
      matchingEventSessionId(payload.sessionId, envelopeSessionId, `${path}.sessionId`);
      parseRuntimeEnum(payload.policy, DELEGATION_POLICIES, `${path}.policy`);
      return;
    case "session.archived":
      matchingEventSessionId(payload.sessionId, envelopeSessionId, `${path}.sessionId`);
      return;
    case "turn.started":
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      return;
    case "model.request_prepared": {
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      parseRuntimeIdentifier(payload.requestId, `${path}.requestId`);
      parseRuntimePositiveInteger(payload.attempt, `${path}.attempt`);
      if (payload.request === undefined) {
        parseRuntimeIdentifier(payload.contentVersion, `${path}.contentVersion`);
        return;
      }
      const request = parseRuntimeRecord(payload.request, `${path}.request`);
      if (request.version !== 1) throw new RuntimeValidationError(`${path}.request.version`, "must be 1");
      parseRuntimeEnum(request.purpose, ["turn", "compaction"] as const, `${path}.request.purpose`);
      parseRuntimeIdentifier(request.contentVersion, `${path}.request.contentVersion`);
      if (payload.contentVersion !== undefined && payload.contentVersion !== request.contentVersion) {
        throw new RuntimeValidationError(`${path}.contentVersion`, "must match the prepared request content version");
      }
      parseRuntimeNonNegativeInteger(request.sessionRevision, `${path}.request.sessionRevision`);
      if (request.executionIdentity !== undefined) parseRuntimeExecutionIdentity(request.executionIdentity, `${path}.request.executionIdentity`);
      if (request.modelIdentity !== undefined) parseRuntimePreparedModelIdentity(request.modelIdentity, `${path}.request.modelIdentity`);
      for (const key of ["system", "developer", "contextualUser"] as const) {
        if (!Array.isArray(request[key]) || request[key].some((entry) => typeof entry !== "string")) {
          throw new RuntimeValidationError(`${path}.request.${key}`, "must be a string array");
        }
      }
      for (const key of ["messages", "tools", "sources"] as const) {
        if (!Array.isArray(request[key])) throw new RuntimeValidationError(`${path}.request.${key}`, "must be an array");
      }
      parseRuntimeRecord(request.budget, `${path}.request.budget`);
      return;
    }
    case "model.request_identity":
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      parseRuntimeIdentifier(payload.requestId, `${path}.requestId`);
      parseRuntimePositiveInteger(payload.attempt, `${path}.attempt`);
      parseRuntimePreparedModelIdentity(payload.identity, `${path}.identity`);
      return;
    case "turn.model_metadata":
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      optionalEventString(payload.provider, `${path}.provider`);
      optionalEventString(payload.model, `${path}.model`);
      optionalEventString(payload.responseId, `${path}.responseId`);
      optionalEventPositiveInteger(payload.contextWindowTokens, `${path}.contextWindowTokens`);
      optionalEventPositiveInteger(payload.maxOutputTokens, `${path}.maxOutputTokens`);
      if (payload.usage !== undefined) validateModelUsage(payload.usage, `${path}.usage`);
      return;
    case "turn.completed":
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      parseRuntimeEnum(payload.status, ["completed", "failed", "cancelled"] as const, `${path}.status`);
      return;
    case "turn.compaction_requested":
    case "turn.compaction_started":
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      parseRuntimeEnum(payload.reason, ["manual", "token_budget", "recovery"] as const, `${path}.reason`);
      optionalEventIdentifier(payload.boundaryMessageId, `${path}.boundaryMessageId`);
      optionalEventNonNegativeInteger(payload.sourceMessageCount, `${path}.sourceMessageCount`);
      optionalEventNonNegativeInteger(payload.estimatedChars, `${path}.estimatedChars`);
      optionalEventNonNegativeInteger(payload.budgetChars, `${path}.budgetChars`);
      return;
    case "turn.compaction_completed":
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      parseRuntimeIdentifier(payload.messageId, `${path}.messageId`);
      parseRuntimeIdentifier(payload.boundaryMessageId, `${path}.boundaryMessageId`);
      parseRuntimeNonNegativeInteger(payload.summaryChars, `${path}.summaryChars`);
      parseRuntimeNonNegativeInteger(payload.sourceMessageCount, `${path}.sourceMessageCount`);
      parseRuntimeNonNegativeInteger(payload.estimatedCharsBefore, `${path}.estimatedCharsBefore`);
      parseRuntimeNonNegativeInteger(payload.estimatedCharsAfter, `${path}.estimatedCharsAfter`);
      return;
    case "turn.compaction_failed":
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      parseRuntimeEnum(payload.reason, ["manual", "token_budget", "recovery"] as const, `${path}.reason`);
      optionalEventIdentifier(payload.boundaryMessageId, `${path}.boundaryMessageId`);
      parseRuntimeString(payload.error, `${path}.error`);
      return;
    case "turn.retry_scheduled":
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      parseRuntimePositiveInteger(payload.attempt, `${path}.attempt`);
      parseRuntimeNonNegativeInteger(payload.delayMs, `${path}.delayMs`);
      parseRuntimeString(payload.reason, `${path}.reason`);
      return;
    case "turn.guard_triggered":
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      parseRuntimeEnum(payload.reason, ["repeated_tool_call", "tool_call_limit"] as const, `${path}.reason`);
      optionalEventString(payload.toolName, `${path}.toolName`);
      parseRuntimePositiveInteger(payload.count, `${path}.count`);
      return;
    case "message.created":
      parseRuntimeIdentifier(payload.messageId, `${path}.messageId`);
      parseRuntimeEnum(payload.role, ["system", "user", "assistant", "tool"] as const, `${path}.role`);
      optionalEventIdentifier(payload.turnId, `${path}.turnId`);
      return;
    case "message.part_added":
      parseRuntimeIdentifier(payload.messageId, `${path}.messageId`);
      validateMessagePart(payload.part, `${path}.part`);
      return;
    case "message.part_delta":
      parseRuntimeIdentifier(payload.messageId, `${path}.messageId`);
      parseRuntimeIdentifier(payload.partId, `${path}.partId`);
      parseRuntimeString(payload.field, `${path}.field`);
      parseRuntimeString(payload.delta, `${path}.delta`, { allowEmpty: true });
      return;
    case "tool.call_started":
      parseRuntimeIdentifier(payload.turnId, `${path}.turnId`);
      parseRuntimeIdentifier(payload.callId, `${path}.callId`);
      optionalEventString(payload.providerCallId, `${path}.providerCallId`);
      parseRuntimeString(payload.toolName, `${path}.toolName`);
      if (!("input" in payload)) throw new RuntimeValidationError(`${path}.input`, "is required");
      return;
    case "tool.call_updated":
      parseRuntimeIdentifier(payload.callId, `${path}.callId`);
      optionalEventString(payload.providerCallId, `${path}.providerCallId`);
      parseRuntimeEnum(payload.status, [
        "pending",
        "validating",
        "waiting_for_approval",
        "running",
        "completed",
        "failed",
        "cancelled",
      ] as const, `${path}.status`);
      optionalEventString(payload.toolName, `${path}.toolName`);
      if (payload.metadata !== undefined) parseRuntimeRecord(payload.metadata, `${path}.metadata`);
      return;
    case "tool.output_delta":
      parseRuntimeIdentifier(payload.callId, `${path}.callId`);
      parseRuntimeEnum(payload.stream, ["stdout", "stderr"] as const, `${path}.stream`);
      parseRuntimeString(payload.delta, `${path}.delta`, { allowEmpty: true });
      optionalEventNonNegativeInteger(payload.bytes, `${path}.bytes`);
      optionalEventBoolean(payload.truncated, `${path}.truncated`);
      optionalEventNonNegativeInteger(payload.sequence, `${path}.sequence`);
      return;
    case "tool.call_finished":
      parseRuntimeIdentifier(payload.callId, `${path}.callId`);
      parseRuntimeEnum(payload.status, ["completed", "failed", "cancelled"] as const, `${path}.status`);
      optionalEventString(payload.output, `${path}.output`);
      optionalEventString(payload.error, `${path}.error`);
      if (payload.errorDetails !== undefined) parseRuntimeRecord(payload.errorDetails, `${path}.errorDetails`);
      optionalEventBoolean(payload.synthetic, `${path}.synthetic`);
      return;
    case "approval.requested":
      parseRuntimeIdentifier(payload.approvalId, `${path}.approvalId`);
      optionalEventIdentifier(payload.callId, `${path}.callId`);
      parseRuntimeString(payload.permission, `${path}.permission`);
      parseRuntimeStringArray(payload.patterns, `${path}.patterns`);
      if (payload.maxApprovalScope !== undefined) {
        parseRuntimeEnum(payload.maxApprovalScope, ["once", "session", "persistent"] as const, `${path}.maxApprovalScope`);
      }
      if (payload.metadata !== undefined) parseRuntimeRecord(payload.metadata, `${path}.metadata`);
      return;
    case "approval.resolved":
      parseRuntimeIdentifier(payload.approvalId, `${path}.approvalId`);
      parseRuntimeEnum(payload.decision, ["allow_once", "allow_session", "allow_always", "deny"] as const, `${path}.decision`);
      optionalEventString(payload.feedback, `${path}.feedback`);
      return;
    case "user_input.requested":
      parseRuntimeIdentifier(payload.inputId, `${path}.inputId`);
      parseRuntimeIdentifier(payload.callId, `${path}.callId`);
      safelyParseUserInputQuestions(payload.questions, `${path}.questions`);
      return;
    case "user_input.resolved":
      parseRuntimeIdentifier(payload.inputId, `${path}.inputId`);
      safelyParseUserInputAnswers(payload.answers, `${path}.answers`);
      return;
    case "user_input.cancelled":
      parseRuntimeIdentifier(payload.inputId, `${path}.inputId`);
      optionalEventString(payload.reason, `${path}.reason`);
      return;
    case "snapshot.created":
      parseRuntimeIdentifier(payload.snapshotId, `${path}.snapshotId`);
      optionalEventIdentifier(payload.callId, `${path}.callId`);
      optionalEventString(payload.toolName, `${path}.toolName`);
      parseRuntimeStringArray(payload.paths, `${path}.paths`);
      parseRuntimeString(payload.reason, `${path}.reason`);
      return;
    case "snapshot.reverted":
      parseRuntimeIdentifier(payload.snapshotId, `${path}.snapshotId`);
      parseRuntimeEnum(payload.status, ["completed", "failed"] as const, `${path}.status`);
      parseRuntimeStringArray(payload.paths, `${path}.paths`);
      optionalEventString(payload.error, `${path}.error`);
      return;
    case "mcp.server_status_changed":
      parseRuntimeString(payload.serverName, `${path}.serverName`);
      validateMcpServerStatus(payload.status, `${path}.status`);
      parseRuntimeNonNegativeInteger(payload.toolCount, `${path}.toolCount`);
      parseRuntimeNonNegativeInteger(payload.promptCount, `${path}.promptCount`);
      parseRuntimeNonNegativeInteger(payload.resourceCount, `${path}.resourceCount`);
      if (payload.previousStatus !== undefined) validateMcpServerStatus(payload.previousStatus, `${path}.previousStatus`);
      if (payload.config !== undefined) validateMcpConfig(payload.config, `${path}.config`);
      if (payload.auth !== undefined) validateMcpAuthState(payload.auth, `${path}.auth`);
      if (payload.capabilities !== undefined) validateMcpCapabilities(payload.capabilities, `${path}.capabilities`);
      if (payload.error !== undefined) validateMcpError(payload.error, `${path}.error`);
      return;
    case "mcp.tools_changed":
      parseRuntimeString(payload.serverName, `${path}.serverName`);
      parseRuntimeArray(payload.tools, validateMcpTool, `${path}.tools`);
      parseRuntimeNonNegativeInteger(payload.toolCount, `${path}.toolCount`);
      optionalMcpChangeFields(payload, path);
      return;
    case "mcp.prompts_changed":
      parseRuntimeString(payload.serverName, `${path}.serverName`);
      parseRuntimeArray(payload.prompts, validateMcpPrompt, `${path}.prompts`);
      parseRuntimeNonNegativeInteger(payload.promptCount, `${path}.promptCount`);
      optionalMcpChangeFields(payload, path);
      return;
    case "mcp.resources_changed":
      parseRuntimeString(payload.serverName, `${path}.serverName`);
      parseRuntimeArray(payload.resources, validateMcpResource, `${path}.resources`);
      parseRuntimeNonNegativeInteger(payload.resourceCount, `${path}.resourceCount`);
      optionalMcpChangeFields(payload, path);
      return;
    case "mcp.diagnostic":
      parseRuntimeString(payload.serverName, `${path}.serverName`);
      parseRuntimeEnum(payload.level, ["debug", "info", "warning", "error"] as const, `${path}.level`);
      parseRuntimeString(payload.message, `${path}.message`);
      optionalEventString(payload.code, `${path}.code`);
      optionalEventString(payload.source, `${path}.source`);
      if (payload.status !== undefined) validateMcpServerStatus(payload.status, `${path}.status`);
      if (payload.error !== undefined) validateMcpError(payload.error, `${path}.error`);
      if (payload.metadata !== undefined) parseRuntimeRecord(payload.metadata, `${path}.metadata`);
      return;
    case "mcp.progress":
      parseRuntimeString(payload.serverName, `${path}.serverName`);
      parseRuntimeEnum(payload.operation, [
        "initialize",
        "connect",
        "authenticate",
        "list_tools",
        "list_prompts",
        "list_resources",
        "call_tool",
        "read_resource",
        "get_prompt",
        "shutdown",
      ] as const, `${path}.operation`);
      parseRuntimeEnum(payload.status, ["started", "running", "completed", "failed", "cancelled"] as const, `${path}.status`);
      optionalEventString(payload.message, `${path}.message`);
      optionalEventIdentifier(payload.operationId, `${path}.operationId`);
      optionalEventString(payload.toolName, `${path}.toolName`);
      optionalEventString(payload.resourceUri, `${path}.resourceUri`);
      optionalEventString(payload.promptName, `${path}.promptName`);
      optionalEventNonNegativeInteger(payload.completed, `${path}.completed`);
      optionalEventNonNegativeInteger(payload.total, `${path}.total`);
      if (payload.error !== undefined) validateMcpError(payload.error, `${path}.error`);
      if (payload.metadata !== undefined) parseRuntimeRecord(payload.metadata, `${path}.metadata`);
      return;
    default:
      return assertNeverEventType(type);
  }
}

function validateMessagePart(value: unknown, path: string): void {
  const part = parseRuntimeRecord(value, path);
  parseRuntimeIdentifier(part.id, `${path}.id`);
  parseRuntimeIdentifier(part.messageId, `${path}.messageId`);
  parseRuntimeIdentifier(part.sessionId, `${path}.sessionId`);
  const type = parseRuntimeEnum(part.type, [
    "text",
    "image",
    "reasoning",
    "tool_call",
    "tool_result",
    "patch",
    "artifact",
    "compaction",
    "agent_handoff",
  ] as const, `${path}.type`);
  switch (type) {
    case "text":
      parseRuntimeString(part.text, `${path}.text`, { allowEmpty: true });
      if (part.phase !== undefined) parseRuntimeEnum(part.phase, ["commentary", "final_answer"] as const, `${path}.phase`);
      optionalEventString(part.displayText, `${path}.displayText`);
      optionalEventBoolean(part.synthetic, `${path}.synthetic`);
      return;
    case "image":
      parseRuntimeString(part.data, `${path}.data`, { maxChars: MAX_IMAGE_DATA_CHARS });
      parseRuntimeString(part.mimeType, `${path}.mimeType`);
      optionalEventString(part.filename, `${path}.filename`);
      optionalEventString(part.sourcePath, `${path}.sourcePath`);
      optionalEventString(part.displayText, `${path}.displayText`);
      return;
    case "reasoning":
      parseRuntimeString(part.text, `${path}.text`, { allowEmpty: true });
      optionalEventBoolean(part.redacted, `${path}.redacted`);
      if (part.modelOutput !== undefined) validatePersistedModelOutput(part.modelOutput, `${path}.modelOutput`);
      return;
    case "tool_call":
      parseRuntimeIdentifier(part.callId, `${path}.callId`);
      parseRuntimeString(part.toolName, `${path}.toolName`);
      if (!("input" in part)) throw new RuntimeValidationError(`${path}.input`, "is required");
      parseRuntimeEnum(part.status, ["pending", "running", "completed", "failed", "cancelled"] as const, `${path}.status`);
      return;
    case "tool_result":
      parseRuntimeIdentifier(part.callId, `${path}.callId`);
      parseRuntimeString(part.output, `${path}.output`, { allowEmpty: true });
      optionalEventString(part.error, `${path}.error`);
      if (part.content !== undefined) validateToolResultContent(part.content, `${path}.content`);
      if (part.executionContext !== undefined) {
        validateToolResultExecutionContext(part.executionContext, `${path}.executionContext`);
      }
      optionalEventBoolean(part.synthetic, `${path}.synthetic`);
      if (part.artifactIds !== undefined) {
        parseRuntimeArray(
          part.artifactIds,
          (item, itemPath) => parseRuntimeIdentifier(item, itemPath),
          `${path}.artifactIds`,
        );
      }
      return;
    case "patch":
      parseRuntimeStringArray(part.files, `${path}.files`);
      optionalEventIdentifier(part.artifactId, `${path}.artifactId`);
      return;
    case "artifact":
      parseRuntimeIdentifier(part.artifactId, `${path}.artifactId`);
      return;
    case "compaction":
      parseRuntimeIdentifier(part.boundaryMessageId, `${path}.boundaryMessageId`);
      parseRuntimeEnum(part.reason, ["manual", "token_budget", "recovery"] as const, `${path}.reason`);
      optionalEventString(part.summary, `${path}.summary`);
      if (part.sourceMessageIds !== undefined) {
        parseRuntimeArray(part.sourceMessageIds, (item, itemPath) => parseRuntimeIdentifier(item, itemPath), `${path}.sourceMessageIds`);
      }
      optionalEventNonNegativeInteger(part.estimatedCharsBefore, `${path}.estimatedCharsBefore`);
      optionalEventNonNegativeInteger(part.estimatedCharsAfter, `${path}.estimatedCharsAfter`);
      return;
    case "agent_handoff":
      parseRuntimeIdentifier(part.agentPath, `${path}.agentPath`);
      parseRuntimeString(part.summary, `${path}.summary`);
  }
}

function validatePersistedModelOutput(value: unknown, path: string): void {
  const output = parseRuntimeRecord(value, path);
  parseRuntimeString(output.apiFamily, `${path}.apiFamily`);
  if (output.outputIndex !== undefined) {
    parseRuntimeNonNegativeInteger(output.outputIndex, `${path}.outputIndex`);
  }
  parseRuntimeRecord(output.item, `${path}.item`);
}

function validateToolResultContent(value: unknown, path: string): void {
  parseRuntimeArray(value, (item, itemPath) => {
    const content = parseRuntimeRecord(item, itemPath);
    const type = parseRuntimeEnum(content.type, ["text", "image"] as const, `${itemPath}.type`);
    if (type === "text") {
      parseRuntimeString(content.text, `${itemPath}.text`, { allowEmpty: true });
    } else {
      parseRuntimeString(content.data, `${itemPath}.data`, {
        allowEmpty: true,
        maxChars: MAX_IMAGE_DATA_CHARS,
      });
      parseRuntimeString(content.mimeType, `${itemPath}.mimeType`);
    }
    return content;
  }, path);
}

function validateToolResultExecutionContext(value: unknown, path: string): void {
  const context = parseRuntimeRecord(value, path);
  if (context.sandbox !== undefined) {
    parseRuntimeEnum(context.sandbox, ["macos-seatbelt", "none"] as const, `${path}.sandbox`);
  }
  if (context.executionMode !== undefined) {
    parseRuntimeEnum(context.executionMode, ["sandboxed", "unsandboxed"] as const, `${path}.executionMode`);
  }
  if (context.exitCode !== undefined && context.exitCode !== null) {
    parseRuntimeNonNegativeInteger(context.exitCode, `${path}.exitCode`);
  }
  optionalEventBoolean(context.timedOut, `${path}.timedOut`);
  optionalEventBoolean(context.aborted, `${path}.aborted`);
  if (context.signal !== undefined && context.signal !== null) {
    parseRuntimeString(context.signal, `${path}.signal`, { allowEmpty: true });
  }
}

const MCP_SERVER_STATUSES = [
  "disabled",
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "auth_required",
] as const;

function validateMcpServerStatus(value: unknown, path: string): void {
  parseRuntimeEnum(value, MCP_SERVER_STATUSES, path);
}

function validateMcpConfig(value: unknown, path: string): void {
  const config = parseRuntimeRecord(value, path);
  parseRuntimeString(config.name, `${path}.name`);
  parseRuntimeBoolean(config.enabled, `${path}.enabled`);
  parseRuntimeEnum(config.transport, ["stdio", "http", "sse"] as const, `${path}.transport`);
  optionalEventString(config.command, `${path}.command`);
  if (config.args !== undefined) parseRuntimeStringArray(config.args, `${path}.args`);
  optionalEventString(config.url, `${path}.url`);
  if (config.envKeys !== undefined) parseRuntimeStringArray(config.envKeys, `${path}.envKeys`);
  optionalEventPositiveInteger(config.timeoutMs, `${path}.timeoutMs`);
  if (config.capabilities !== undefined) validateMcpCapabilities(config.capabilities, `${path}.capabilities`, true);
  if (config.metadata !== undefined) parseRuntimeRecord(config.metadata, `${path}.metadata`);
}

function validateMcpAuthState(value: unknown, path: string): void {
  const auth = parseRuntimeRecord(value, path);
  parseRuntimeEnum(auth.status, [
    "unknown",
    "not_required",
    "required",
    "pending",
    "authenticated",
    "expired",
    "failed",
  ] as const, `${path}.status`);
  parseRuntimeBoolean(auth.required, `${path}.required`);
  optionalEventString(auth.provider, `${path}.provider`);
  if (auth.scopes !== undefined) parseRuntimeStringArray(auth.scopes, `${path}.scopes`);
  optionalEventNonNegativeInteger(auth.expiresAt, `${path}.expiresAt`);
  if (auth.error !== undefined) validateMcpError(auth.error, `${path}.error`);
}

function validateMcpCapabilities(value: unknown, path: string, partial = false): void {
  const capabilities = parseRuntimeRecord(value, path);
  for (const key of ["tools", "prompts", "resources"] as const) {
    if (capabilities[key] === undefined && partial) continue;
    parseRuntimeBoolean(capabilities[key], `${path}.${key}`);
  }
  for (const key of ["logging", "progress", "sampling", "roots"] as const) {
    optionalEventBoolean(capabilities[key], `${path}.${key}`);
  }
}

function validateMcpError(value: unknown, path: string): void {
  const error = parseRuntimeRecord(value, path);
  parseRuntimeString(error.message, `${path}.message`);
  optionalEventString(error.code, `${path}.code`);
  optionalEventBoolean(error.recoverable, `${path}.recoverable`);
}

function validateMcpTool(value: unknown, path: string): void {
  const tool = parseRuntimeRecord(value, path);
  parseRuntimeString(tool.serverName, `${path}.serverName`);
  parseRuntimeString(tool.name, `${path}.name`);
  optionalEventString(tool.title, `${path}.title`);
  optionalEventString(tool.description, `${path}.description`);
  if (tool.inputSchema !== undefined) parseRuntimeRecord(tool.inputSchema, `${path}.inputSchema`);
  if (tool.annotations !== undefined) parseRuntimeRecord(tool.annotations, `${path}.annotations`);
  optionalEventBoolean(tool.enabled, `${path}.enabled`);
}

function validateMcpPrompt(value: unknown, path: string): void {
  const prompt = parseRuntimeRecord(value, path);
  parseRuntimeString(prompt.serverName, `${path}.serverName`);
  parseRuntimeString(prompt.name, `${path}.name`);
  optionalEventString(prompt.title, `${path}.title`);
  optionalEventString(prompt.description, `${path}.description`);
  if (prompt.arguments !== undefined) {
    parseRuntimeArray(prompt.arguments, (item, itemPath) => {
      const argument = parseRuntimeRecord(item, itemPath);
      parseRuntimeString(argument.name, `${itemPath}.name`);
      parseRuntimeBoolean(argument.required, `${itemPath}.required`);
      optionalEventString(argument.title, `${itemPath}.title`);
      optionalEventString(argument.description, `${itemPath}.description`);
      return argument;
    }, `${path}.arguments`);
  }
}

function validateMcpResource(value: unknown, path: string): void {
  const resource = parseRuntimeRecord(value, path);
  parseRuntimeString(resource.serverName, `${path}.serverName`);
  parseRuntimeString(resource.uri, `${path}.uri`);
  optionalEventString(resource.name, `${path}.name`);
  optionalEventString(resource.title, `${path}.title`);
  optionalEventString(resource.description, `${path}.description`);
  optionalEventString(resource.mimeType, `${path}.mimeType`);
  optionalEventString(resource.uriTemplate, `${path}.uriTemplate`);
}

function optionalMcpChangeFields(payload: Record<string, unknown>, path: string): void {
  if (payload.status !== undefined) validateMcpServerStatus(payload.status, `${path}.status`);
  optionalEventIdentifier(payload.revision, `${path}.revision`);
  if (payload.error !== undefined) validateMcpError(payload.error, `${path}.error`);
}

function assertNeverEventType(type: never): never {
  void type;
  throw new RuntimeValidationError("event.type", "is not supported");
}

function validateModelUsage(value: unknown, path: string): void {
  const usage = parseRuntimeRecord(value, path);
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "totalTokens",
  ] as const) {
    optionalEventNonNegativeInteger(usage[key], `${path}.${key}`);
  }
}

function parseRuntimeError(value: unknown, path: string): { name: string; message: string } {
  const error = parseRuntimeRecord(value, path);
  return {
    name: parseRuntimeString(error.name, `${path}.name`),
    message: parseRuntimeString(error.message, `${path}.message`, { allowEmpty: true }),
  };
}

function matchingEventSessionId(value: unknown, expected: string | undefined, path: string): void {
  const sessionId = parseRuntimeIdentifier(value, path);
  if (expected !== undefined && sessionId !== expected) {
    throw new RuntimeValidationError(path, "must match event.sessionId");
  }
}

function optionalEventString(value: unknown, path: string): void {
  if (value !== undefined) parseRuntimeString(value, path, { allowEmpty: true });
}

function optionalEventIdentifier(value: unknown, path: string): void {
  if (value !== undefined) parseRuntimeIdentifier(value, path);
}

function optionalEventBoolean(value: unknown, path: string): void {
  if (value !== undefined) parseRuntimeBoolean(value, path);
}

function optionalEventPositiveInteger(value: unknown, path: string): void {
  if (value !== undefined) parseRuntimePositiveInteger(value, path);
}

function optionalEventNonNegativeInteger(value: unknown, path: string): void {
  if (value !== undefined) parseRuntimeNonNegativeInteger(value, path);
}

function parseRuntimeEndpoint(value: unknown, path: string): string {
  const endpoint = parseRuntimeString(value, path, { maxChars: 8_192 });
  if (CONTROL_CHARACTERS.test(endpoint)) {
    throw new RuntimeValidationError(path, "must be a credential-free absolute HTTP(S) URL without control characters");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new RuntimeValidationError(path, "must be a credential-free absolute HTTP(S) URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new RuntimeValidationError(path, "must be a credential-free absolute HTTP(S) URL");
  }
  return url.href;
}

function assignOptionalString<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
  path: string,
): void {
  if (value !== undefined) target[key] = parseRuntimeString(value, `${path}.${String(key)}`, { allowEmpty: true }) as T[K];
}

function assignOptionalBoolean<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
  path: string,
): void {
  if (value !== undefined) target[key] = parseRuntimeBoolean(value, `${path}.${String(key)}`) as T[K];
}

function assignOptionalPositiveInteger<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
  path: string,
): void {
  if (value !== undefined) target[key] = parseRuntimePositiveInteger(value, `${path}.${String(key)}`) as T[K];
}

function assignOptionalNonNegativeInteger<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
  path: string,
): void {
  if (value !== undefined) target[key] = parseRuntimeNonNegativeInteger(value, `${path}.${String(key)}`) as T[K];
}

function safelyParseUserInputQuestions(value: unknown, path: string) {
  try {
    return parseUserInputQuestions(value);
  } catch {
    throw new RuntimeValidationError(path, "must satisfy the user-input question contract");
  }
}

function safelyParseUserInputAnswers(value: unknown, path: string) {
  try {
    return parseUserInputAnswers(value);
  } catch {
    throw new RuntimeValidationError(path, "must satisfy the user-input answer contract");
  }
}
