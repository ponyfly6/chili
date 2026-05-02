import { createInterface, type Interface } from "node:readline/promises";
import type { ApprovalDecision } from "@chili/protocol";
import { PolicyApprovalBroker, type ApprovalBrokerRequest } from "@chili/tools";
import type { PermissionRule } from "@chili/policy";
import {
  addPersistentPermissionGrants,
  type AddPersistentPermissionGrantOptions,
  type CliConfig,
} from "./config.js";

export interface CliApprovalOptions {
  yes?: boolean;
  readline?: Interface;
  config?: CliConfig;
  chiliHome?: string;
}

export function createCliApprovalBroker(options: CliApprovalOptions = {}): PolicyApprovalBroker {
  return new PolicyApprovalBroker({
    rulesets: createCliApprovalRulesets(options.yes ?? false, options.config),
    ask: async (request) => askApproval(request, options),
  });
}

export function createCliApprovalRulesets(yes: boolean, config?: CliConfig): readonly (readonly PermissionRule[])[] {
  const rulesets: PermissionRule[][] = [createCliPermissionRules(yes)];
  const userPermissions = configuredRulesForMode(yes, config?.userPermissions ?? []);
  const projectPermissions = configuredRulesForMode(yes, config?.projectPermissions ?? []);
  if (userPermissions.length) rulesets.push(userPermissions);
  if (projectPermissions.length) rulesets.push(projectPermissions);
  return rulesets;
}

export function createCliPermissionRules(yes: boolean): PermissionRule[] {
  return yes
    ? [{ permission: "*", pattern: "*", action: "allow" }]
    : [
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "glob", pattern: "*", action: "allow" },
        { permission: "grep", pattern: "*", action: "allow" },
        { permission: "git_status", pattern: "*", action: "allow" },
        { permission: "git_diff", pattern: "*", action: "allow" },
      ];
}

function configuredRulesForMode(yes: boolean, rules: readonly PermissionRule[]): PermissionRule[] {
  return yes ? rules.filter((rule) => rule.action !== "ask") : [...rules];
}

export async function persistApprovalGrantForRequest(
  request: ApprovalBrokerRequest,
  options: AddPersistentPermissionGrantOptions = {},
): Promise<void> {
  await addPersistentPermissionGrants(
    request.patterns.map((pattern) => ({ permission: request.permission, pattern })),
    options,
  );
}

export async function persistAllowAlwaysDecision(
  request: ApprovalBrokerRequest,
  decision: ApprovalDecision,
  options: AddPersistentPermissionGrantOptions = {},
): Promise<ApprovalDecision> {
  if (decision.action !== "allow_always") return decision;
  try {
    await persistApprovalGrantForRequest(request, options);
    return decision;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      action: "allow_once",
      feedback: `Allowed once, but failed to persist approval grant: ${message}`,
    };
  }
}

async function askApproval(request: ApprovalBrokerRequest, options: CliApprovalOptions): Promise<ApprovalDecision> {
  const ownReadline = options.readline ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  const rl = options.readline ?? ownReadline;
  if (!rl) return { action: "deny", feedback: "No approval interface available" };

  try {
    console.log("");
    console.log(`[approval] ${request.toolName}`);
    console.log(`permission: ${request.permission}`);
    console.log(`patterns: ${request.patterns.join(", ")}`);
    if (request.metadata && Object.keys(request.metadata).length > 0) {
      console.log(`metadata: ${JSON.stringify(request.metadata)}`);
    }

    while (true) {
      const answer = (await rl.question("Allow? [y]es / [s]ession / [a]lways / [n]o > ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes" || answer === "") return { action: "allow_once" };
      if (answer === "s" || answer === "session") return { action: "allow_session" };
      if (answer === "a" || answer === "always") {
        return persistAllowAlwaysDecision(request, { action: "allow_always" }, options.chiliHome ? { chiliHome: options.chiliHome } : {});
      }
      if (answer === "n" || answer === "no") return { action: "deny", feedback: "Denied from CLI" };
    }
  } finally {
    ownReadline?.close();
  }
}
