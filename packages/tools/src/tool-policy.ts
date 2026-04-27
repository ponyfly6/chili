import { relative, resolve } from "node:path";
import { ToolDeniedError } from "./errors.js";
import type {
  ChiliToolDefinition,
  ExecuteToolInput,
  ToolAccessPolicy,
  ToolApprovalSpec,
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

export function filterToolsByPolicy(
  tools: readonly ChiliToolDefinition[],
  policy: ToolAccessPolicy | undefined,
): ChiliToolDefinition[] {
  if (!policy) return [...tools];
  return tools.filter((tool) => isToolVisible(tool, policy));
}

export function isToolVisible(tool: ChiliToolDefinition, policy: ToolAccessPolicy | undefined): boolean {
  if (!policy) return true;
  if (policy.allowedTools && !toolNameAllowed(tool, policy.allowedTools)) return false;
  if (isScopedTeamTool(tool) && !policy.teamId) return false;
  if (isFilesystemWriteTool(tool) && normalizedList(policy.writeScope).length === 0) return false;
  return true;
}

export async function authorizeToolByPolicy<Input>(input: {
  tool: ChiliToolDefinition<Input>;
  executeInput: ExecuteToolInput;
  validatedInput: Input;
  approvalSpec: Required<ToolApprovalSpec>;
  policy: ToolAccessPolicy | undefined;
  isReadOnly: (tool: ChiliToolDefinition<Input>, input: Input) => Promise<boolean | undefined>;
}): Promise<void> {
  const policy = input.policy;
  if (!policy) return;

  if (!isToolVisible(input.tool, policy)) {
    throw new ToolDeniedError(input.tool.name, "Tool is not allowed by the current worker policy.");
  }

  authorizeTeamToolByPolicy(input.tool, input.validatedInput, policy);

  if (isFilesystemWriteRequest(input.tool, input.approvalSpec)) {
    const writeScope = normalizedList(policy.writeScope);
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

  if (input.tool.risk === "execute") {
    const isReadOnly = await input.isReadOnly(input.tool, input.validatedInput);
    if (isReadOnly) return;

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
  if (input.threadId) context.threadId = input.threadId;
  return context;
}

function toolNameAllowed(tool: ChiliToolDefinition, allowedTools: readonly string[]): boolean {
  const names = new Set(allowedTools.map((name) => normalizeToolName(name)));
  return names.has("*") || toolNameMatches(tool, names);
}

function isFilesystemWriteTool(tool: ChiliToolDefinition): boolean {
  return toolNameMatches(tool, FILE_WRITE_TOOL_NAMES);
}

function isFilesystemWriteRequest(tool: ChiliToolDefinition, approvalSpec: Required<ToolApprovalSpec>): boolean {
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

  const ownerPath = stringField(input, "ownerPath");
  if (ownerPath && policy.memberPath && ownerPath !== policy.memberPath) {
    throw new ToolDeniedError(tool.name, "Team task ownerPath must match this worker's member path.");
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

function recordInput(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
    return normalizedScope === "*" || normalizedCommand === normalizedScope || normalizedCommand.startsWith(`${normalizedScope} `);
  });
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
