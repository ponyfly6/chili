import { relative, resolve } from "node:path";
import { TEAM_TASK_RUNTIME_METADATA_KEYS } from "@chili/protocol";
import { ToolDeniedError } from "./errors.js";
import { canonicalResourcePattern } from "./resource-policy.js";
import type {
  ChiliToolDefinition,
  ExecuteToolInput,
  ToolAccessPolicy,
  ToolApprovalSpecWithDefaults,
  ToolPolicyContext,
} from "./types.js";

const FILE_WRITE_TOOL_NAMES = new Set(["edit", "replace", "write", "write_file", "apply_patch"]);
const FILE_WRITE_PERMISSIONS = new Set(["edit", "write"]);
const SCOPED_TEAM_TOOL_NAMES = new Set([
  "team_snapshot",
  "team_task_list",
  "team_task_update",
  "team_message_send",
  "team_message_list",
]);
const SCOPED_AGENT_MESSAGE_TOOL_NAMES = new Set(["agent_message_send", "agent_message_list", "agent_send", "agent_list"]);
const INTERNAL_AGENT_LIFECYCLE_TOOL_NAMES = new Set(["agent_spawn", "agent_resume", "agent_stop"]);
const TEAM_TASK_RUNTIME_METADATA_KEY_SET = new Set<string>(TEAM_TASK_RUNTIME_METADATA_KEYS);

export function filterToolsByPolicy(
  tools: readonly ChiliToolDefinition[],
  policy: ToolAccessPolicy | undefined,
): ChiliToolDefinition[] {
  if (!policy) return [...tools];
  return tools.filter((tool) => isToolVisible(tool, policy));
}

export function isToolVisible(tool: ChiliToolDefinition, policy: ToolAccessPolicy | undefined): boolean {
  if (!policy) return true;
  if (policy.deniedTools && toolNameDenied(tool, policy.deniedTools)) return false;
  if (policy.allowedTools && !toolNameAllowed(tool, policy.allowedTools)) return false;
  // A deny-only policy is an overlay, not a scoped-worker capability policy.
  // This lets callers disable a narrow set of tools without accidentally
  // removing root filesystem, execution, or team-inspection capabilities.
  if (!hasScopedWorkerConstraints(policy)) return true;
  if (hasResourceScopeConstraints(policy) && tool.resourcePolicy === undefined) return false;
  if (isScopedTeamTool(tool) && !policy.teamId) return false;
  if (isFilesystemWriteTool(tool) && normalizedList(policy.writeScope).length === 0) return false;
  return true;
}

export async function authorizeToolByPolicy<Input>(input: {
  tool: ChiliToolDefinition<Input>;
  executeInput: ExecuteToolInput;
  validatedInput: Input;
  approvalSpec: ToolApprovalSpecWithDefaults;
  policy: ToolAccessPolicy | undefined;
  isReadOnly: (tool: ChiliToolDefinition<Input>, input: Input) => Promise<boolean | undefined>;
}): Promise<void> {
  const policy = input.policy;
  if (!policy) return;

  if (!isToolVisible(input.tool, policy)) {
    throw new ToolDeniedError(input.tool.name, "Tool is not allowed by the current worker policy.");
  }

  if (!hasScopedWorkerConstraints(policy)) return;

  if (hasResourceScopeConstraints(policy) && input.tool.resourcePolicy === undefined) {
    throw new ToolDeniedError(input.tool.name, "This tool does not declare a trusted implementation of the current resource scopes.");
  }

  authorizeTeamToolByPolicy(input.tool, input.validatedInput, policy);
  authorizeAgentMessageToolByPolicy(input.tool, input.validatedInput, policy);

  if (normalizeToolName(input.approvalSpec.permission) === "bash.unsandboxed") {
    throw new ToolDeniedError(
      input.tool.name,
      "Scoped workers cannot request execution outside the host sandbox.",
    );
  }

  if (isFilesystemWriteRequest(input.tool, input.approvalSpec)) {
    const writeScope = await Promise.all(normalizedList(policy.writeScope)
      .map((scope) => canonicalResourcePattern(input.executeInput.cwd, scope)));
    if (writeScope.length === 0) {
      throw new ToolDeniedError(input.tool.name, "This worker does not have write scope.");
    }
    const denied = input.approvalSpec.patterns.find(
      (pattern) => !pathPatternWithinScopes(input.executeInput.cwd, pattern, writeScope),
    );
    if (denied) {
      throw new ToolDeniedError(
        input.tool.name,
        `Path is outside this worker's write scope: ${denied}`,
      );
    }
  }

  // These trusted controllers operate on agents, not OS commands. Their task
  // permission, worker grants, and host ownership checks still apply; an empty
  // shell execution scope must not prevent an explicitly granted delegation.
  const internalAgentLifecycle = input.tool.resourcePolicy === "internal" &&
    INTERNAL_AGENT_LIFECYCLE_TOOL_NAMES.has(input.tool.name);
  if (input.tool.risk === "execute" && !internalAgentLifecycle) {
    const isReadOnly = await input.isReadOnly(input.tool, input.validatedInput);
    // Read-only is a scheduling hint, not proof of OS resource isolation. An
    // explicit execute scope always applies, including to read-only commands.
    if (isReadOnly && (normalizeToolName(input.tool.name) !== "bash" || policy.executeScope === undefined)) return;

    const executeScope = normalizedList(policy.executeScope);
    if (executeScope.length === 0) {
      throw new ToolDeniedError(input.tool.name, "This worker does not have execute scope.");
    }
    const denied = input.approvalSpec.patterns.find((pattern) => !commandWithinScopes(pattern, executeScope));
    if (denied) {
      throw new ToolDeniedError(
        input.tool.name,
        `Command is outside this worker's execute scope: ${denied}`,
      );
    }
  }
}

export function toolPolicyContext(input: ExecuteToolInput): ToolPolicyContext {
  const context: ToolPolicyContext = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    cwd: input.cwd,
  };
  return context;
}

function toolNameAllowed(tool: ChiliToolDefinition, allowedTools: readonly string[]): boolean {
  const names = new Set(allowedTools.map((name) => normalizeToolName(name)));
  // Existing worker sessions retain their messaging grants after the tool rename.
  if (names.has("agent_message_send")) names.add("agent_send");
  if (names.has("agent_message_list")) names.add("agent_list");
  return names.has("*") || toolNameMatches(tool, names);
}

function toolNameDenied(tool: ChiliToolDefinition, deniedTools: readonly string[]): boolean {
  const names = new Set(deniedTools.map((name) => normalizeToolName(name)));
  // A renamed or merged tool must not bypass an existing explicit deny.
  const legacyNames: Record<string, readonly string[]> = {
    agent_spawn: ["task", "task_batch", "agent", "agent_batch", "spawn_tasks", "spawn_agents"],
    agent_list: ["task_list", "list_tasks", "agent_message_list", "list_agent_messages", "mailbox_list", "list_mailbox", "agent_mailbox"],
    agent_send: ["agent_message_send", "send_agent_message", "send_message"],
    agent_wait: ["task_wait", "task_wait_batch", "wait_task", "wait_tasks", "agent_wait_batch"],
    agent_stop: ["task_close", "close_task", "agent_close"],
    agent_resume: ["task_followup", "followup_task", "agent_followup"],
  };
  if ((legacyNames[normalizeToolName(tool.name)] ?? []).some((name) => names.has(name))) return true;
  return names.has("*") || toolNameMatches(tool, names);
}

function hasScopedWorkerConstraints(policy: ToolAccessPolicy): boolean {
  return policy.allowedTools !== undefined ||
    policy.writeScope !== undefined ||
    policy.executeScope !== undefined ||
    policy.teamId !== undefined ||
    policy.taskId !== undefined ||
    policy.memberPath !== undefined;
}

function isFilesystemWriteTool(tool: ChiliToolDefinition): boolean {
  return toolNameMatches(tool, FILE_WRITE_TOOL_NAMES);
}

function isFilesystemWriteRequest(tool: ChiliToolDefinition, approvalSpec: ToolApprovalSpecWithDefaults): boolean {
  if (isFilesystemWriteTool(tool)) return true;
  return FILE_WRITE_PERMISSIONS.has(normalizeToolName(approvalSpec.permission)) && !isScopedTeamTool(tool);
}

function isScopedTeamTool(tool: ChiliToolDefinition): boolean {
  return toolNameMatches(tool, SCOPED_TEAM_TOOL_NAMES);
}

function toolNameMatches(tool: ChiliToolDefinition, names: ReadonlySet<string>): boolean {
  return names.has(normalizeToolName(tool.name)) || (tool.aliases ?? []).some((alias) => names.has(normalizeToolName(alias)));
}

function authorizeTeamToolByPolicy<Input>(
  tool: ChiliToolDefinition<Input>,
  validatedInput: Input,
  policy: ToolAccessPolicy,
): void {
  if (!isScopedTeamTool(tool)) return;

  const expectedTeamId = policy.teamId;
  if (!expectedTeamId) {
    throw new ToolDeniedError(tool.name, "Team tools require a scoped team policy.");
  }

  const input = recordInput(validatedInput);
  const teamId = stringField(input, "teamId");
  if (teamId !== expectedTeamId) {
    throw new ToolDeniedError(tool.name, "Team tool is outside this worker's team scope.");
  }

  const toolName = normalizeToolName(tool.name);
  if (toolName === "team_task_update") {
    authorizeTeamTaskTool(tool, input, policy);
  } else if (toolName === "team_message_send") {
    authorizeTeamMessageSendTool(tool, input, policy);
  } else if (toolName === "team_message_list") {
    authorizeOptionalTeamTask(tool, input, policy);
  }
}

function authorizeTeamTaskTool(
  tool: ChiliToolDefinition,
  input: Record<string, unknown>,
  policy: ToolAccessPolicy,
): void {
  if (!policy.taskId) {
    throw new ToolDeniedError(tool.name, "Team task tools require a scoped team task policy.");
  }

  const taskId = stringField(input, "taskId");
  if (policy.taskId && taskId !== policy.taskId) {
    throw new ToolDeniedError(tool.name, "Team task tool is outside this worker's team task scope.");
  }

  authorizeTeamTaskProgressUpdate(tool, input);

  const ownerPath = stringField(input, "ownerPath");
  if (ownerPath && policy.memberPath && ownerPath !== policy.memberPath) {
    throw new ToolDeniedError(tool.name, "Team task ownerPath must match this worker's member path.");
  }
}

function authorizeTeamTaskProgressUpdate(
  tool: ChiliToolDefinition,
  input: Record<string, unknown>,
): void {
  const status = stringField(input, "status");
  if (status && status !== "in_progress") {
    throw new ToolDeniedError(
      tool.name,
      "Scoped workers may only report in-progress task updates; complete the local task with complete_task.",
    );
  }

  const structuralFields = ["ownerPath", "title", "description", "dependsOn", "error"] as const;
  const structuralField = structuralFields.find((field) => input[field] !== undefined);
  if (structuralField) {
    throw new ToolDeniedError(
      tool.name,
      `Scoped workers cannot change team task field: ${structuralField}.`,
    );
  }

  const metadata = recordField(input, "metadata");
  if (!metadata) return;
  const protectedKey = Object.keys(metadata).find((key) => TEAM_TASK_RUNTIME_METADATA_KEY_SET.has(key));
  if (protectedKey) {
    throw new ToolDeniedError(
      tool.name,
      `Scoped workers cannot change runtime-owned team task metadata: ${protectedKey}.`,
    );
  }
}

function authorizeTeamMessageSendTool(
  tool: ChiliToolDefinition,
  input: Record<string, unknown>,
  policy: ToolAccessPolicy,
): void {
  if (!policy.memberPath) {
    throw new ToolDeniedError(tool.name, "Team message tools require a scoped member path.");
  }

  const from = stringField(input, "from");
  if (policy.memberPath && from !== policy.memberPath) {
    throw new ToolDeniedError(tool.name, "Team message sender must match this worker's member path.");
  }
  authorizeOptionalTeamTask(tool, input, policy);
}

function authorizeOptionalTeamTask(
  tool: ChiliToolDefinition,
  input: Record<string, unknown>,
  policy: ToolAccessPolicy,
): void {
  const taskId = stringField(input, "taskId");
  if (taskId && policy.taskId && taskId !== policy.taskId) {
    throw new ToolDeniedError(tool.name, "Team tool is outside this worker's team task scope.");
  }
}

function authorizeAgentMessageToolByPolicy<Input>(
  tool: ChiliToolDefinition<Input>,
  validatedInput: Input,
  policy: ToolAccessPolicy,
): void {
  if (!toolNameMatches(tool, SCOPED_AGENT_MESSAGE_TOOL_NAMES)) return;
  const input = recordInput(validatedInput);
  const from = stringField(input, "from");
  if (from && policy.memberPath && from !== policy.memberPath) {
    throw new ToolDeniedError(tool.name, "Agent message sender must match this worker's agent path.");
  }
  if (!["agent_message_send", "agent_send"].includes(normalizeToolName(tool.name)) || !policy.memberPath) return;

  const to = stringField(input, "to");
  if (!to || to === "parent" || !to.startsWith("/")) return;
  const segments = policy.memberPath.split("/").filter(Boolean);
  const parentPath = segments.length > 1 ? `/${segments.slice(0, -1).join("/")}` : undefined;
  const isSelfOrDescendant = to === policy.memberPath || to.startsWith(`${policy.memberPath}/`);
  if (to !== parentPath && !isSelfOrDescendant) {
    throw new ToolDeniedError(
      tool.name,
      "Scoped agents may message only their parent or descendants directly; use team_message_send for teammates.",
    );
  }
}

function recordInput(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function recordField(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = input[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathPatternWithinScopes(cwd: string, pattern: string, scopes: readonly string[]): boolean {
  if (scopes.includes("*")) return true;
  if (pattern === "*") return false;

  const target = workspaceRelativePath(cwd, pattern);
  if (!target) return false;
  return scopes.some((scope) => pathScopeContains(scope, target));
}

function workspaceRelativePath(cwd: string, path: string): string | undefined {
  const workspace = resolve(cwd);
  const absolutePath = resolve(workspace, path);
  const relativePath = normalizePath(relative(workspace, absolutePath));
  if (!isSafeRelativePath(relativePath)) return undefined;
  return relativePath;
}

function pathScopeContains(scope: string, item: string): boolean {
  const normalizedScope = normalizePath(scope);
  const normalizedItem = normalizePath(item);
  if (normalizedScope === "*" || normalizedScope === "." || normalizedScope === "/") return true;
  return normalizedItem === normalizedScope || normalizedItem.startsWith(`${normalizedScope}/`);
}

function commandWithinScopes(command: string, scopes: readonly string[]): boolean {
  const normalizedCommand = command.trim();
  return scopes.some((scope) => {
    const normalizedScope = scope.trim();
    return normalizedScope === "*" || normalizedCommand === normalizedScope;
  });
}

/** Intersect every restriction before passing it to an enforcing process backend. */
export async function executionPolicyFor(cwd: string, policies: readonly ToolAccessPolicy[]): Promise<ToolAccessPolicy | undefined> {
  const scoped = policies.filter(hasResourceScopeConstraints);
  if (scoped.length === 0) return undefined;
  let writeScope = ["*"];
  let executeScope = ["*"];
  for (const policy of scoped) {
    const writes = await Promise.all(normalizedList(policy.writeScope).map((path) => canonicalResourcePattern(cwd, path)));
    writeScope = intersectScopes(writeScope, writes, true);
    executeScope = intersectScopes(executeScope, normalizedList(policy.executeScope), false);
  }
  return { writeScope, executeScope };
}

function hasResourceScopeConstraints(policy: ToolAccessPolicy): boolean {
  return policy.writeScope !== undefined || policy.executeScope !== undefined || policy.teamId !== undefined || policy.taskId !== undefined || policy.memberPath !== undefined;
}

function intersectScopes(left: readonly string[], right: readonly string[], paths: boolean): string[] {
  const result = new Set<string>();
  for (const first of left) for (const second of right) {
    if (first === "*") result.add(second);
    else if (second === "*" || first === second) result.add(first);
    else if (paths && pathScopeContains(first, second)) result.add(second);
    else if (paths && pathScopeContains(second, first)) result.add(first);
  }
  return [...result];
}

function normalizedList(items: readonly string[] | undefined): string[] {
  return (items ?? []).map((item) => item.trim()).filter(Boolean);
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizePath(path: string): string {
  let normalized = path.trim().replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized || ".";
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split(/[\\/]/).includes("..");
}
