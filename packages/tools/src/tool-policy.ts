import { relative, resolve } from "node:path";
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
  // removing root filesystem or execution capabilities.
  if (!hasScopedWorkerConstraints(policy)) return true;
  if (hasResourceScopeConstraints(policy) && tool.resourcePolicy === undefined) return false;
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

  if (input.tool.risk === "execute") {
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
  return names.has("*") || toolNameMatches(tool, names);
}

function toolNameDenied(tool: ChiliToolDefinition, deniedTools: readonly string[]): boolean {
  const names = new Set(deniedTools.map((name) => normalizeToolName(name)));
  return names.has("*") || toolNameMatches(tool, names);
}

function hasScopedWorkerConstraints(policy: ToolAccessPolicy): boolean {
  return policy.writeScope !== undefined || policy.executeScope !== undefined;
}

function isFilesystemWriteTool(tool: ChiliToolDefinition): boolean {
  return toolNameMatches(tool, FILE_WRITE_TOOL_NAMES);
}

function isFilesystemWriteRequest(tool: ChiliToolDefinition, approvalSpec: ToolApprovalSpecWithDefaults): boolean {
  if (isFilesystemWriteTool(tool)) return true;
  return FILE_WRITE_PERMISSIONS.has(normalizeToolName(approvalSpec.permission));
}

function toolNameMatches(tool: ChiliToolDefinition, names: ReadonlySet<string>): boolean {
  return names.has(normalizeToolName(tool.name)) || (tool.aliases ?? []).some((alias) => names.has(normalizeToolName(alias)));
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
  return policy.writeScope !== undefined || policy.executeScope !== undefined;
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
