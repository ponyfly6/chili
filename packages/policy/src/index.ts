export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

export interface PolicyDecision {
  action: PermissionAction;
  matchedRule?: PermissionRule;
}

export function evaluatePolicy(
  permission: string,
  pattern: string,
  rulesets: readonly (readonly PermissionRule[])[],
): PolicyDecision {
  const rules = rulesets.flat();

  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (!rule) continue;
    if (!matches(rule.permission, permission)) continue;
    if (!matches(rule.pattern, pattern)) continue;
    return { action: rule.action, matchedRule: rule };
  }

  return { action: "ask" };
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
