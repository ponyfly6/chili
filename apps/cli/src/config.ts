import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PermissionAction, PermissionRule } from "@chili/policy";
import { defaultChiliHome } from "@chili/providers";

export interface CliConfig {
  userPermissions: PermissionRule[];
  projectPermissions: PermissionRule[];
}

export interface LoadCliConfigOptions {
  chiliHome?: string;
}

export interface AddPersistentPermissionGrantOptions {
  chiliHome?: string;
}

export const PERMISSION_ACTIONS = ["allow", "ask", "deny"] as const satisfies readonly PermissionAction[];
const PROJECT_PERMISSION_ACTIONS = ["ask", "deny"] as const satisfies readonly PermissionAction[];

export async function loadCliConfig(cwd: string, options: LoadCliConfigOptions = {}): Promise<CliConfig> {
  const chiliHome = options.chiliHome ?? defaultChiliHome();
  const userPermissions = await loadPermissionRules(userConfigPath(chiliHome), {
    source: "user config.toml",
    allowedActions: PERMISSION_ACTIONS,
  });
  const projectConfig = await findProjectConfigPath(cwd);
  const projectPermissions = projectConfig
    ? await loadPermissionRules(projectConfig, {
        source: "project .chili/config.toml",
        allowedActions: PROJECT_PERMISSION_ACTIONS,
      })
    : [];

  return { userPermissions, projectPermissions };
}

export async function addPersistentPermissionGrant(
  permission: string,
  pattern: string,
  options: AddPersistentPermissionGrantOptions = {},
): Promise<void> {
  const chiliHome = options.chiliHome ?? defaultChiliHome();
  const path = userConfigPath(chiliHome);
  const config = await readConfigFile(path);
  const spec = formatPermissionSpec(permission, pattern);
  const permissions = config.permissions;
  const allow = permissions.allow ?? [];
  if (!allow.includes(spec)) {
    permissions.allow = [...allow, spec].sort(comparePermissionSpecs);
  }
  await writeConfigFile(path, config);
}

export async function addPersistentPermissionGrants(
  grants: readonly { permission: string; pattern: string }[],
  options: AddPersistentPermissionGrantOptions = {},
): Promise<void> {
  const chiliHome = options.chiliHome ?? defaultChiliHome();
  const path = userConfigPath(chiliHome);
  const config = await readConfigFile(path);
  const allow = new Set(config.permissions.allow ?? []);
  for (const grant of grants) {
    allow.add(formatPermissionSpec(grant.permission, grant.pattern));
  }
  config.permissions.allow = [...allow].sort(comparePermissionSpecs);
  await writeConfigFile(path, config);
}

export function permissionRulesFromConfig(
  config: unknown,
  options: { source?: string; allowedActions?: readonly PermissionAction[] } = {},
): PermissionRule[] {
  const source = options.source ?? "config.toml";
  const allowedActions = new Set(options.allowedActions ?? PERMISSION_ACTIONS);
  const root = record(config, source);
  if (!("permissions" in root)) return [];
  const permissions = record(root.permissions, `${source} [permissions]`);
  const rulesByAction = new Map<PermissionAction, PermissionRule[]>();

  for (const action of PERMISSION_ACTIONS) {
    const value = permissions[action];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new Error(`${source} permissions.${action} must be an array of strings`);
    }
    if (!allowedActions.has(action)) {
      throw new Error(`${source} permissions.${action} is not allowed in this config layer`);
    }

    const rules: PermissionRule[] = [];
    for (const [index, item] of value.entries()) {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new Error(`${source} permissions.${action}[${index}] must be a non-empty string`);
      }
      const spec = parsePermissionRuleSpec(item, `${source} permissions.${action}[${index}]`);
      rules.push({
        permission: spec.permission,
        pattern: spec.pattern,
        action,
        source: `${source} permissions.${action}`,
      });
    }
    rulesByAction.set(action, rules);
  }

  return sortPermissionRules([...rulesByAction.values()].flat());
}

export function parsePermissionRuleSpec(spec: string, label = "permission rule"): { permission: string; pattern: string } {
  const trimmed = spec.trim();
  const open = trimmed.indexOf("(");
  if (open <= 0 || !trimmed.endsWith(")")) {
    throw new Error(`${label} must use Tool(content) syntax`);
  }
  const permission = trimmed.slice(0, open).trim();
  const rawPattern = trimmed.slice(open + 1, -1);
  if (!isValidPermissionName(permission)) {
    throw new Error(`${label} has an invalid tool name`);
  }
  if (rawPattern.trim().length === 0) {
    throw new Error(`${label} must include non-empty content`);
  }
  return {
    permission,
    pattern: unescapePermissionContent(rawPattern),
  };
}

export function formatPermissionSpec(permission: string, pattern: string): string {
  const trimmedPermission = permission.trim();
  if (!isValidPermissionName(trimmedPermission)) {
    throw new Error(`Invalid permission name: ${permission}`);
  }
  if (pattern.length === 0) throw new Error("Permission pattern must be non-empty");
  return `${trimmedPermission}(${escapePermissionContent(pattern)})`;
}

function sortPermissionRules(rules: PermissionRule[]): PermissionRule[] {
  return rules.sort((left, right) => {
    const specificity = permissionRuleSpecificity(left) - permissionRuleSpecificity(right);
    if (specificity !== 0) return specificity;
    const action = actionRank(left.action) - actionRank(right.action);
    if (action !== 0) return action;
    return formatPermissionSpec(left.permission, left.pattern).localeCompare(formatPermissionSpec(right.permission, right.pattern));
  });
}

function permissionRuleSpecificity(rule: PermissionRule): number {
  return literalLength(rule.permission) + literalLength(rule.pattern);
}

function literalLength(value: string): number {
  return value.replaceAll("*", "").length;
}

function actionRank(action: PermissionAction): number {
  if (action === "allow") return 0;
  if (action === "ask") return 1;
  return 2;
}

function comparePermissionSpecs(left: string, right: string): number {
  const parsedLeft = parsePermissionRuleSpec(left, left);
  const parsedRight = parsePermissionRuleSpec(right, right);
  const specificity = literalLength(parsedLeft.permission) + literalLength(parsedLeft.pattern)
    - literalLength(parsedRight.permission) - literalLength(parsedRight.pattern);
  if (specificity !== 0) return specificity;
  return left.localeCompare(right);
}

interface CliConfigFile {
  permissions: Partial<Record<PermissionAction, string[]>>;
  originalText?: string;
}

async function loadPermissionRules(
  path: string,
  options: { source: string; allowedActions: readonly PermissionAction[] },
): Promise<PermissionRule[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const parsed = Bun.TOML.parse(text);
  return permissionRulesFromConfig(parsed, options);
}

async function readConfigFile(path: string): Promise<CliConfigFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return { permissions: {} };
  }
  if (text.trim().length === 0) return { permissions: {}, originalText: text };
  const root = record(Bun.TOML.parse(text), path);
  if (!("permissions" in root)) return { permissions: {}, originalText: text };
  const permissions = record(root.permissions, `${path} [permissions]`);
  const result: CliConfigFile = { permissions: {}, originalText: text };
  for (const action of PERMISSION_ACTIONS) {
    const value = permissions[action];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`${path} permissions.${action} must be an array of strings`);
    }
    result.permissions[action] = [...new Set(value.map((item) => item.trim()).filter(Boolean))].sort(comparePermissionSpecs);
  }
  return result;
}

async function writeConfigFile(path: string, config: CliConfigFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, serializeConfigFile(config), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function serializeConfigFile(config: CliConfigFile): string {
  const permissionsTable = serializePermissionsTable(config.permissions);
  if (config.originalText === undefined || config.originalText.trim().length === 0) return permissionsTable;
  return upsertPermissionsTable(config.originalText, permissionsTable);
}

function serializePermissionsTable(permissions: Partial<Record<PermissionAction, string[]>>): string {
  const lines = ["[permissions]"];
  for (const action of PERMISSION_ACTIONS) {
    const values = permissions[action] ?? [];
    if (values.length > 0) lines.push(`${action} = ${tomlStringArray(values)}`);
  }
  return `${lines.join("\n")}\n`;
}

function upsertPermissionsTable(text: string, permissionsTable: string): string {
  const tableStart = permissionsTableStart(text);
  if (tableStart === undefined) {
    const separator = text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${separator}${permissionsTable}`;
  }
  const tableEnd = nextTomlTableStart(text, tableStart.headerEnd);
  const prefix = text.slice(0, tableStart.start);
  const suffix = tableEnd === undefined ? "" : text.slice(tableEnd);
  return `${prefix}${permissionsTable}${suffix}`;
}

function permissionsTableStart(text: string): { start: number; headerEnd: number } | undefined {
  const match = /^[ \t]*\[permissions\][ \t]*(?:#.*)?(?:\r?\n|$)/m.exec(text);
  if (!match) return undefined;
  return { start: match.index, headerEnd: match.index + match[0].length };
}

function nextTomlTableStart(text: string, from: number): number | undefined {
  const match = /^[ \t]*\[{1,2}[^\]\r\n]+\]{1,2}[ \t]*(?:#.*)?$/m.exec(text.slice(from));
  return match ? from + match.index : undefined;
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function userConfigPath(chiliHome: string): string {
  return join(chiliHome, "config.toml");
}

async function findProjectConfigPath(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".chili", "config.toml");
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${label} must be a TOML table`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isValidPermissionName(value: string): boolean {
  return /^[A-Za-z0-9_*.-]+$/.test(value);
}

function escapePermissionContent(content: string): string {
  return content.replace(/[\\()]/g, (char) => `\\${char}`);
}

function unescapePermissionContent(content: string): string {
  let result = "";
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? "";
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = content[index + 1];
    if (next === "\\" || next === "(" || next === ")") {
      result += next;
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}
