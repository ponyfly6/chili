export type PermissionAction = "allow" | "deny" | "ask";

export type PermissionDecisionSource = "default" | "policy_rule" | "session_grant" | string;

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
  source?: string;
}

export interface PermissionSuggestion {
  permission: string;
  pattern: string;
  action: PermissionAction;
  scope?: "session" | "project" | "user";
  source?: string;
}

export interface PermissionDecision {
  action: PermissionAction;
  reason?: string;
  feedback?: string;
  source: PermissionDecisionSource;
  matchedRule?: PermissionRule;
  suggestions?: PermissionSuggestion[];
  metadata?: Record<string, unknown>;
}

export type PolicyDecision = PermissionDecision;

export function evaluatePolicy(
  permission: string,
  pattern: string,
  rulesets: readonly (readonly PermissionRule[])[],
): PolicyDecision {
  const rules = rulesets.flat();
  let fallback: PolicyDecision | undefined;

  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (!rule) continue;
    if (!matchesRule(rule, permission, pattern)) continue;
    const decision = decisionForRule(rule, permission, pattern);
    if (rule.action === "deny") return decision;
    fallback ??= decision;
  }

  return fallback ?? {
    action: "ask",
    source: "default",
    reason: `No permission rule matched ${permission}:${pattern}.`,
    metadata: { permission, pattern },
  };
}

export function disabledTools(tools: readonly string[], rules: readonly PermissionRule[]): Set<string> {
  const disabled = new Set<string>();

  for (const tool of tools) {
    const decision = evaluatePolicy(tool, "*", [rules]);
    if (decision.action === "deny") disabled.add(tool);
  }

  return disabled;
}

export function matches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;

  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function parsePermissionSpec(spec: string): { permission: string; content?: string } {
  const trimmed = spec.trim();
  const open = trimmed.indexOf("(");
  if (open < 0 || !trimmed.endsWith(")")) return { permission: trimmed };
  const permission = trimmed.slice(0, open).trim();
  const content = trimmed.slice(open + 1, -1);
  if (!permission) return { permission: trimmed };
  return { permission, content: unescapePermissionContent(content) };
}

function matchesRule(rule: PermissionRule, permission: string, pattern: string): boolean {
  const parsed = parsePermissionSpec(rule.permission);
  if (!matchesPermission(parsed.permission, permission)) return false;
  if (parsed.content !== undefined && !matches(parsed.content, pattern)) return false;
  return matches(rule.pattern, pattern);
}

function matchesPermission(pattern: string, value: string): boolean {
  return matches(pattern.toLowerCase(), value.toLowerCase());
}

function decisionForRule(rule: PermissionRule, permission: string, pattern: string): PolicyDecision {
  const source = rule.source?.startsWith("session:") ? "session_grant" : "policy_rule";
  const decision: PolicyDecision = {
    action: rule.action,
    source,
    reason: `Matched ${rule.action} rule for ${permission}:${pattern}.`,
    matchedRule: rule,
    metadata: { permission, pattern },
  };
  if (rule.source) {
    decision.metadata = { ...decision.metadata, ruleSource: rule.source };
  }
  return decision;
}

function unescapePermissionContent(content: string): string {
  return content.replaceAll("\\(", "(").replaceAll("\\)", ")");
}
