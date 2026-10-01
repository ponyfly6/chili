import { createInterface, type Interface } from "node:readline/promises";
import type { ApprovalDecision, RuntimePermissionConfig, RuntimePermissionProfileId } from "@chili/protocol";
import {
  PolicyApprovalBroker,
  PolicyApprovalState,
  approvalDecisionWithinScope,
  type ApprovalBrokerRequest,
  type ApprovalPreflightDecision,
  type ApprovalPreflightRequest,
  type PolicyApprovalBrokerOptions,
} from "@chili/tools";
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
  sandboxedShell?: boolean;
  approvalState?: PolicyApprovalState;
  rulesetsForRequest?: CliApprovalRulesetResolver;
}

export interface CliApprovalRulesetOptions {
  sandboxedShell?: boolean;
}

export interface PersistAllowAlwaysDecisionOptions extends AddPersistentPermissionGrantOptions {
  onPersisted?: (request: ApprovalBrokerRequest) => Promise<void> | void;
}

export type CliApprovalRulesetResolver = (
  request: ApprovalPreflightRequest,
) => Promise<readonly (readonly PermissionRule[])[]> | readonly (readonly PermissionRule[])[];

export interface RequestScopedPolicyApprovalBrokerOptions extends PolicyApprovalBrokerOptions {
  rulesetsForRequest: CliApprovalRulesetResolver;
}

export function createCliApprovalBroker(options: CliApprovalOptions = {}): PolicyApprovalBroker {
  const profile = options.yes ? "full-access" : "default";
  const brokerOptions: PolicyApprovalBrokerOptions = {
    rulesets: createCliApprovalRulesets(profile, options.config, {
      sandboxedShell: options.sandboxedShell ?? false,
    }),
    dangerousShellCommands: dangerousShellCommandsForProfile(profile),
    allowOneShotPolicyBypass: profile === "full-access",
    state: options.approvalState ?? new PolicyApprovalState(),
    ask: async (request, signal) => askApproval(request, options, signal),
  };
  return options.rulesetsForRequest
    ? createRequestScopedPolicyApprovalBroker({
        ...brokerOptions,
        rulesetsForRequest: options.rulesetsForRequest,
      })
    : new PolicyApprovalBroker(brokerOptions);
}

export function createRequestScopedPolicyApprovalBroker(
  options: RequestScopedPolicyApprovalBrokerOptions,
): PolicyApprovalBroker {
  return new RequestScopedPolicyApprovalBroker(options);
}

class RequestScopedPolicyApprovalBroker extends PolicyApprovalBroker {
  private readonly rulesetsForRequest: CliApprovalRulesetResolver;
  private readonly delegateOptions: PolicyApprovalBrokerOptions;

  constructor(options: RequestScopedPolicyApprovalBrokerOptions) {
    const { rulesetsForRequest, ...brokerOptions } = options;
    const delegateOptions: PolicyApprovalBrokerOptions = {
      ...brokerOptions,
      state: brokerOptions.state ?? new PolicyApprovalState(),
    };
    super(delegateOptions);
    this.rulesetsForRequest = rulesetsForRequest;
    this.delegateOptions = delegateOptions;
  }

  override setRulesets(rulesets: readonly (readonly PermissionRule[])[]): void {
    this.delegateOptions.rulesets = rulesets;
    super.setRulesets(rulesets);
  }

  override setDangerousShellCommands(mode: "ask" | "allow"): void {
    this.delegateOptions.dangerousShellCommands = mode;
    super.setDangerousShellCommands(mode);
  }

  override async preflight(request: ApprovalPreflightRequest): Promise<ApprovalPreflightDecision> {
    let delegate: PolicyApprovalBroker;
    try {
      delegate = await this.delegateFor(request);
    } catch {
      return approvalPolicyResolutionFailure(request);
    }
    return delegate.preflight(request);
  }

  override async decide(request: ApprovalBrokerRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    let delegate: PolicyApprovalBroker;
    try {
      delegate = await this.delegateFor(request);
    } catch {
      const failure = approvalPolicyResolutionFailure(request);
      return {
        action: "deny",
        feedback: failure.feedback ?? failure.reason ?? "Unable to resolve session permission policy.",
      };
    }
    return delegate.decide(request, signal);
  }

  private async delegateFor(request: ApprovalPreflightRequest): Promise<PolicyApprovalBroker> {
    const rulesets = await this.rulesetsForRequest(request);
    return new PolicyApprovalBroker({
      ...this.delegateOptions,
      rulesets,
    });
  }
}

function approvalPolicyResolutionFailure(request: ApprovalPreflightRequest): ApprovalPreflightDecision {
  const message = `Unable to resolve permission policy for session ${request.sessionId}.`;
  return {
    action: "deny",
    source: "session_workspace_policy",
    reason: message,
    feedback: message,
    metadata: {
      sessionId: request.sessionId,
      permission: request.permission,
      patterns: request.patterns,
    },
  };
}

export function createCliApprovalRulesets(
  profile: RuntimePermissionProfileId | boolean,
  config?: CliConfig,
  options: CliApprovalRulesetOptions = {},
): readonly (readonly PermissionRule[])[] {
  const resolvedProfile = typeof profile === "boolean" ? (profile ? "full-access" : "default") : profile;
  const rulesets: PermissionRule[][] = [createCliPermissionRules(resolvedProfile, options)];
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

export function createCliPermissionRules(
  profile: RuntimePermissionProfileId | boolean,
  options: CliApprovalRulesetOptions = {},
): PermissionRule[] {
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
    { permission: "bash", pattern: "*", action: options.sandboxedShell ? "allow" : "ask", source },
    { permission: "bash.unsandboxed", pattern: "*", action: "ask", source },
    { permission: "task", pattern: "*", action: "allow", source },
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
    request.patterns.map((pattern) => ({ permission: request.permission, pattern })),
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

async function askApproval(request: ApprovalBrokerRequest, options: CliApprovalOptions, signal?: AbortSignal): Promise<ApprovalDecision> {
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
      const prompt = approvalPrompt(request);
      const answer = (signal ? await rl.question(prompt, { signal }) : await rl.question(prompt)).trim().toLowerCase();
      if (answer === "y" || answer === "yes" || answer === "") return { action: "allow_once" };
      if ((answer === "s" || answer === "session") && approvalDecisionWithinScope("allow_session", request.maxApprovalScope)) {
        return { action: "allow_session" };
      }
      if ((answer === "a" || answer === "always") && approvalDecisionWithinScope("allow_always", request.maxApprovalScope)) {
        return persistAllowAlwaysDecision(request, { action: "allow_always" }, {
          ...(options.chiliHome ? { chiliHome: options.chiliHome } : {}),
          ...(options.approvalState
            ? {
                onPersisted: (persistedRequest: ApprovalBrokerRequest) => options.approvalState?.addPersistentGrant({
                  permission: persistedRequest.permission,
                  patterns: persistedRequest.patterns,
                }),
              }
            : {}),
        });
      }
      if (answer === "n" || answer === "no") return { action: "deny", feedback: "Denied from CLI" };
    }
  } finally {
    ownReadline?.close();
  }
}

function approvalPrompt(request: ApprovalBrokerRequest): string {
  if (request.maxApprovalScope === "once") return "Allow once? [y]es / [n]o > ";
  if (request.maxApprovalScope === "session") return "Allow? [y]es once / [s]ession / [n]o > ";
  return "Allow? [y]es / [s]ession / [a]lways / [n]o > ";
}
