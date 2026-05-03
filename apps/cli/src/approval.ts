import { createInterface, type Interface } from "node:readline/promises";
import type { ApprovalDecision, RuntimePermissionConfig, RuntimePermissionProfileId } from "@chili/protocol";
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
  const profile = options.yes ? "full-access" : "default";
  return new PolicyApprovalBroker({
    rulesets: createCliApprovalRulesets(profile, options.config),
    dangerousShellCommands: dangerousShellCommandsForProfile(profile),
    ask: async (request) => askApproval(request, options),
  });
}

export function createCliApprovalRulesets(profile: RuntimePermissionProfileId | boolean, config?: CliConfig): readonly (readonly PermissionRule[])[] {
  const resolvedProfile = typeof profile === "boolean" ? (profile ? "full-access" : "default") : profile;
  const rulesets: PermissionRule[][] = [createCliPermissionRules(resolvedProfile)];
  const userPermissions = configuredRulesForMode(resolvedProfile, config?.userPermissions ?? []);
  const projectPermissions = configuredRulesForMode(resolvedProfile, config?.projectPermissions ?? []);
  if (userPermissions.length) rulesets.push(userPermissions);
  if (projectPermissions.length) rulesets.push(projectPermissions);
  return rulesets;
}

export function createCliPermissionRules(profile: RuntimePermissionProfileId | boolean): PermissionRule[] {
  const resolvedProfile = typeof profile === "boolean" ? (profile ? "full-access" : "default") : profile;
  if (resolvedProfile === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow", source: "permission_profile:full-access" }];
  }

  const source = `permission_profile:${resolvedProfile}`;
  return [
    { permission: "read", pattern: "*", action: "allow", source },
    { permission: "glob", pattern: "*", action: "allow", source },
    { permission: "grep", pattern: "*", action: "allow", source },
    { permission: "edit", pattern: "*", action: "allow", source },
    { permission: "write", pattern: "*", action: "allow", source },
    { permission: "bash", pattern: "*", action: "allow", source },
    { permission: "git_status", pattern: "*", action: "allow", source },
    { permission: "git_diff", pattern: "*", action: "allow", source },
  ];
}

export function dangerousShellCommandsForProfile(profile: RuntimePermissionProfileId): "ask" | "allow" {
  return profile === "full-access" ? "allow" : "ask";
}

function configuredRulesForMode(profile: RuntimePermissionProfileId, rules: readonly PermissionRule[]): PermissionRule[] {
  return profile === "full-access" ? rules.filter((rule) => rule.action !== "ask") : [...rules];
}

export function runtimePermissionConfig(profile: RuntimePermissionProfileId): RuntimePermissionConfig {
  return {
    profile,
    profiles: [
      {
        id: "default",
        label: "Default",
        description: "Chili can read and edit files in the current workspace, and run commands. Project/user deny rules still apply.",
        current: profile === "default",
      },
      {
        id: "auto-review",
        label: "Auto-review",
        description: "Same workspace-write permissions as Default, but eligible approvals are routed through an auto-reviewer subagent.",
        current: profile === "auto-review",
        disabledReason: "Auto-reviewer approval routing is not implemented in Chili yet.",
      },
      {
        id: "full-access",
        label: "Full Access",
        description: "Chili can use all tools without asking for approval. Exercise caution when using.",
        current: profile === "full-access",
      },
    ],
  };
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
