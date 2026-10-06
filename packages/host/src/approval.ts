import type { ApprovalDecision, RuntimePermissionConfig, RuntimePermissionProfileId } from "@chili/protocol";
import {
  PolicyApprovalBroker,
  PolicyApprovalState,
  approvalDecisionWithinScope,
  approvalGrantPermission,
  approvalGrantPatterns,
  type ApprovalBrokerRequest,
  type ApprovalPreflightDecision,
  type ApprovalPreflightRequest,
  type PolicyApprovalBrokerOptions,
} from "@chili/tools";
import type { PermissionRule } from "@chili/policy";
import {
  addPersistentPermissionGrants,
  type AddPersistentPermissionGrantOptions,
  type HostConfig,
} from "./config.js";

export interface HostApprovalOptions {
  permissionProfile?: RuntimePermissionProfileId;
  askApproval?: PolicyApprovalBrokerOptions["ask"];
  config?: HostConfig;
  chiliHome?: string;
  sandboxedShell?: boolean;
  approvalState?: PolicyApprovalState;
  rulesetsForRequest?: ApprovalRulesetResolver;
}

export interface ApprovalRulesetOptions {
  sandboxedShell?: boolean;
}

export interface PersistAllowAlwaysDecisionOptions extends AddPersistentPermissionGrantOptions {
  onPersisted?: (request: ApprovalBrokerRequest) => Promise<void> | void;
}

export type ApprovalRulesetResolver = (
  request: ApprovalPreflightRequest,
) => Promise<readonly (readonly PermissionRule[])[]> | readonly (readonly PermissionRule[])[];

export interface RequestScopedPolicyApprovalBrokerOptions extends PolicyApprovalBrokerOptions {
  rulesetsForRequest: ApprovalRulesetResolver;
}

export function assertSupportedPermissionProfile(profile: RuntimePermissionProfileId): void {
  if (profile === "auto-review") {
    throw new Error("Auto-reviewer approval routing is not implemented in Chili yet.");
  }
  if (profile !== "default" && profile !== "full-access") {
    throw new Error(`Unsupported permission profile: ${String(profile)}`);
  }
}

export function createHostApprovalBroker(options: HostApprovalOptions = {}): PolicyApprovalBroker {
  const profile = options.permissionProfile ?? "default";
  assertSupportedPermissionProfile(profile);
  const state = options.approvalState ?? new PolicyApprovalState();
  const brokerOptions: PolicyApprovalBrokerOptions = {
    rulesets: createApprovalRulesets(profile, options.config, {
      sandboxedShell: options.sandboxedShell ?? false,
    }),
    dangerousShellCommands: dangerousShellCommandsForProfile(profile),
    allowOneShotPolicyBypass: profile === "full-access",
    state,
    ask: async (request, signal) => options.askApproval
      ? options.askApproval(request, signal)
      : { action: "deny", feedback: "No approval interface available." },
    onApproved: (request, decision) => persistAllowAlwaysDecision(request, decision, {
      ...(options.chiliHome ? { chiliHome: options.chiliHome } : {}),
      // Dynamic Host policy rereads persistent config. A cached grant would survive revocation.
      ...(!options.rulesetsForRequest ? {
        onPersisted: (persistedRequest: ApprovalBrokerRequest) => state.addPersistentGrant({
          permission: approvalGrantPermission(persistedRequest),
          patterns: approvalGrantPatterns(persistedRequest),
        }),
      } : {}),
    }),
  };
  return options.rulesetsForRequest
    ? createRequestScopedPolicyApprovalBroker({ ...brokerOptions, rulesetsForRequest: options.rulesetsForRequest })
    : new PolicyApprovalBroker(brokerOptions);
}

export function createRequestScopedPolicyApprovalBroker(
  options: RequestScopedPolicyApprovalBrokerOptions,
): PolicyApprovalBroker {
  return new PolicyApprovalBroker(options);
}

export function createApprovalRulesets(
  profile: RuntimePermissionProfileId | boolean,
  config?: HostConfig,
  options: ApprovalRulesetOptions = {},
): readonly (readonly PermissionRule[])[] {
  const resolvedProfile = typeof profile === "boolean" ? (profile ? "full-access" : "default") : profile;
  const rulesets: PermissionRule[][] = [createPermissionRules(resolvedProfile, options)];
  const userPermissions = configuredRulesForMode(resolvedProfile, config?.userPermissions ?? []);
  const projectPermissions = configuredRulesForMode(resolvedProfile, config?.projectPermissions ?? []);
  if (userPermissions.length) rulesets.push(userPermissions);
  if (projectPermissions.length) rulesets.push(projectPermissions);
  if (resolvedProfile !== "full-access") {
    rulesets.push([{
      permission: "bash.unsandboxed",
      pattern: "*",
      action: "ask",
      source: `permission_profile:${resolvedProfile}:one_off_unsandboxed`,
    }]);
  }
  return rulesets;
}

export function createPermissionRules(
  profile: RuntimePermissionProfileId | boolean,
  options: ApprovalRulesetOptions = {},
): PermissionRule[] {
  const resolvedProfile = typeof profile === "boolean" ? (profile ? "full-access" : "default") : profile;
  if (resolvedProfile === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow", source: "permission_profile:full-access" }];
  }

  const source = `permission_profile:${resolvedProfile}`;
  return [
    { permission: "read", pattern: "*", action: "allow", source },
    { permission: "memory.read", pattern: "*", action: "allow", source },
    { permission: "memory.write", pattern: "*", action: "ask", source },
    { permission: "glob", pattern: "*", action: "allow", source },
    { permission: "grep", pattern: "*", action: "allow", source },
    { permission: "edit", pattern: "*", action: "allow", source },
    { permission: "write", pattern: "*", action: "allow", source },
    { permission: "bash", pattern: "*", action: options.sandboxedShell ? "allow" : "ask", source },
    { permission: "bash.unsandboxed", pattern: "*", action: "ask", source },
    { permission: "agent_spawn", pattern: "*", action: "allow", source },
    { permission: "agent_send", pattern: "*", action: "allow", source },
    { permission: "agent_stop", pattern: "*", action: "allow", source },
    { permission: "agent_resume", pattern: "*", action: "allow", source },
    { permission: "git_status", pattern: "*", action: "allow", source },
    { permission: "git_diff", pattern: "*", action: "allow", source },
  ];
}

export function dangerousShellCommandsForProfile(profile: RuntimePermissionProfileId): "ask" | "allow" {
  return profile === "full-access" ? "allow" : "ask";
}

function configuredRulesForMode(profile: RuntimePermissionProfileId, rules: readonly PermissionRule[]): PermissionRule[] {
  if (profile === "full-access") return rules.filter((rule) => rule.action !== "ask");
  return [...rules];
}

export function runtimePermissionConfig(profile: RuntimePermissionProfileId): RuntimePermissionConfig {
  return {
    profile,
    profiles: [
      {
        id: "default",
        label: "Default",
        description: "Chili can read, edit, and run ordinary shell commands inside the macOS sandbox for the workspace. Dangerous or unsandboxed shell commands still require approval.",
        current: profile === "default",
      },
      {
        id: "auto-review",
        label: "Auto-review",
        description: "Same workspace and macOS sandbox permissions as Default, but eligible approvals are routed through an auto-reviewer subagent.",
        current: profile === "auto-review",
        disabledReason: "Auto-reviewer approval routing is not implemented in Chili yet.",
      },
      {
        id: "full-access",
        label: "Full Access",
        description: "Chili can use all tools without asking for approval and without the OS sandbox. Exercise caution when using.",
        current: profile === "full-access",
      },
    ],
  };
}

export async function persistApprovalGrantForRequest(
  request: ApprovalBrokerRequest,
  options: AddPersistentPermissionGrantOptions = {},
): Promise<void> {
  if (!approvalDecisionWithinScope("allow_always", request.maxApprovalScope)) {
    throw new Error("This approval is restricted to a narrower scope and cannot be persisted.");
  }
  await addPersistentPermissionGrants(
    approvalGrantPatterns(request).map((pattern) => ({ permission: approvalGrantPermission(request), pattern })),
    options,
  );
}

export async function persistAllowAlwaysDecision(
  request: ApprovalBrokerRequest,
  decision: ApprovalDecision,
  options: PersistAllowAlwaysDecisionOptions = {},
): Promise<ApprovalDecision> {
  if (!approvalDecisionWithinScope(decision.action, request.maxApprovalScope)) {
    return {
      action: "deny",
      feedback: `Approval decision ${decision.action} exceeds the maximum ${request.maxApprovalScope ?? "persistent"} scope.`,
    };
  }
  if (decision.action !== "allow_always") return decision;
  try {
    await persistApprovalGrantForRequest(request, options.chiliHome ? { chiliHome: options.chiliHome } : {});
    await options.onPersisted?.(request);
    return decision;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      action: "allow_once",
      feedback: `Allowed once, but failed to persist approval grant: ${message}`,
    };
  }
}
