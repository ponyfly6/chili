import type { ApprovalDecision, ApprovalScope, SessionId } from "@chili/protocol";
import { evaluatePolicy, type PermissionDecision, type PermissionRule, type PermissionSuggestion } from "@chili/policy";
import { classifyDangerousShellCommand } from "./shell-safety.js";
import type { ApprovalBroker, ApprovalBrokerRequest, ApprovalPreflightDecision, ApprovalPreflightRequest } from "./types.js";

export interface PolicyApprovalBrokerOptions {
  rulesets?: readonly (readonly PermissionRule[])[];
  ask?: (request: ApprovalBrokerRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;
  onSessionGrant?: (grant: SessionApprovalGrant) => Promise<void> | void;
  dangerousShellCommands?: "ask" | "allow";
  allowOneShotPolicyBypass?: boolean | ((request: ApprovalPreflightRequest) => boolean);
  state?: PolicyApprovalState;
}

export interface SessionApprovalGrant {
  sessionId: SessionId;
  permission: string;
  patterns: string[];
  source: string;
  metadata?: Record<string, unknown>;
}

export interface PersistentApprovalGrant {
  permission: string;
  patterns: string[];
  source?: string;
}

/** Shared mutable approval state for every broker in one runtime harness. */
export class PolicyApprovalState {
  private readonly parentSessions = new Map<SessionId, SessionId>();
  private readonly sessionGrants = new Map<SessionId, PermissionRule[]>();
  private readonly persistentGrants: PermissionRule[] = [];

  linkSession(parentSessionId: SessionId, childSessionId: SessionId): void {
    const parentRoot = this.rootSession(parentSessionId);
    const childRoot = this.rootSession(childSessionId);
    if (parentRoot === childRoot) return;

    this.parentSessions.set(childRoot, parentRoot);
    const childGrants = this.sessionGrants.get(childRoot);
    if (!childGrants?.length) return;
    const parentGrants = this.sessionGrants.get(parentRoot) ?? [];
    parentGrants.push(...childGrants);
    this.sessionGrants.set(parentRoot, parentGrants);
    this.sessionGrants.delete(childRoot);
  }

  addSessionGrant(grant: SessionApprovalGrant): void {
    const rootSessionId = this.rootSession(grant.sessionId);
    const rules = this.sessionGrants.get(rootSessionId) ?? [];
    for (const pattern of grant.patterns) {
      pushUniqueRule(rules, {
        permission: grant.permission,
        pattern,
        action: "allow",
        source: sessionGrantSource(grant.source),
      });
    }
    this.sessionGrants.set(rootSessionId, rules);
  }

  addPersistentGrant(grant: PersistentApprovalGrant): void {
    for (const pattern of grant.patterns) {
      pushUniqueRule(this.persistentGrants, {
        permission: grant.permission,
        pattern,
        action: "allow",
        source: grant.source ?? "user config.toml permissions.allow",
      });
    }
  }

  rulesetsFor(sessionId: SessionId): readonly (readonly PermissionRule[])[] {
    const rulesets: PermissionRule[][] = [];
    if (this.persistentGrants.length > 0) rulesets.push(this.persistentGrants);
    const sessionRules = this.sessionGrants.get(this.rootSession(sessionId));
    if (sessionRules?.length) rulesets.push(sessionRules);
    return rulesets;
  }

  private rootSession(sessionId: SessionId): SessionId {
    let current = sessionId;
    const visited = new Set<SessionId>();
    while (!visited.has(current)) {
      visited.add(current);
      const parent = this.parentSessions.get(current);
      if (!parent) return current;
      current = parent;
    }
    return sessionId;
  }
}

export class PolicyApprovalBroker implements ApprovalBroker {
  private readonly state: PolicyApprovalState;

  constructor(private readonly options: PolicyApprovalBrokerOptions = {}) {
    this.state = options.state ?? new PolicyApprovalState();
  }

  setRulesets(rulesets: readonly (readonly PermissionRule[])[]): void {
    this.options.rulesets = rulesets;
  }

  setDangerousShellCommands(mode: "ask" | "allow"): void {
    this.options.dangerousShellCommands = mode;
  }

  async preflight(request: ApprovalPreflightRequest): Promise<ApprovalPreflightDecision> {
    return this.evaluate(request).decision;
  }

  async decide(request: ApprovalBrokerRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    const evaluated = this.evaluate(request);
    if (evaluated.decision.action === "deny") {
      return denyDecision(evaluated.decision);
    }
    if (evaluated.decision.action === "allow") {
      return { action: "allow_once" };
    }

    if (this.options.ask) {
      const decision = normalizeApprovalDecision(await this.options.ask(requestWithPreflight(request, evaluated.risks, evaluated.decision), signal));
      const rechecked = this.evaluate(request).decision;
      if (rechecked.action === "deny") return denyDecision(rechecked);
      if (!approvalDecisionWithinScope(decision.action, request.maxApprovalScope)) {
        return {
          action: "deny",
          feedback: `Approval decision ${decision.action} exceeds the maximum approval scope ${request.maxApprovalScope ?? "persistent"}.`,
        };
      }
      if (decision.action === "allow_session" || decision.action === "allow_always") {
        const grant = this.rememberSessionGrant(request, decision.action, decision.feedback);
        await this.options.onSessionGrant?.(grant);
        return decision;
      }
      if (decision.action !== "deny" && rechecked.action === "allow") {
        return { action: "allow_once" };
      }
      return decision;
    }

    if (evaluated.risks.length > 0) {
      return {
        action: "deny",
        feedback: `Command requires explicit approval: ${evaluated.risks.map((risk) => risk.reason).join("; ")}`,
      };
    }

    return { action: "deny", feedback: evaluated.decision.reason ?? "No approval handler is configured." };
  }

  private evaluate(request: ApprovalPreflightRequest): { decision: ApprovalPreflightDecision; risks: ApprovalRisk[] } {
    if (!Array.isArray(request.patterns) || request.patterns.length === 0) {
      return {
        decision: {
          action: "deny",
          source: "approval_request",
          reason: "Approval request must include at least one pattern.",
          feedback: "Approval request must include at least one pattern.",
          metadata: { permission: request.permission, patterns: request.patterns },
        },
        risks: [],
      };
    }
    const invalidPatternIndex = request.patterns.findIndex((pattern) => typeof pattern !== "string" || pattern.trim().length === 0);
    if (invalidPatternIndex >= 0) {
      return {
        decision: {
          action: "deny",
          source: "approval_request",
          reason: `Approval request pattern at index ${invalidPatternIndex} must be a non-empty string.`,
          feedback: `Approval request pattern at index ${invalidPatternIndex} must be a non-empty string.`,
          metadata: { permission: request.permission, patterns: request.patterns },
        },
        risks: [],
      };
    }

    let askDecision: ApprovalPreflightDecision | undefined;
    let allowDecision: ApprovalPreflightDecision | undefined;
    const risks: ApprovalRisk[] = [];
    const patternDecisions: ApprovalPreflightDecision[] = [];

    for (const pattern of request.patterns) {
      const risk = this.options.dangerousShellCommands === "allow" ? undefined : approvalRisk(request.permission, pattern);
      if (risk?.action === "deny") {
        return {
          decision: dangerDecision(request, risk),
          risks,
        };
      }
      if (risk) risks.push(risk);

      const policyDecision = evaluatePolicy(request.permission, pattern, this.rulesetsFor(request));
      if (policyDecision.action === "deny") {
        return { decision: policyDenyDecision(policyDecision, request, pattern), risks };
      }

      if (risk && policyDecision.action === "allow" && isExplicitApprovalRule(policyDecision.matchedRule)) {
        const decision = allowFromPolicy(policyDecision, request, pattern);
        allowDecision = decision;
        patternDecisions.push(decision);
        continue;
      }

      if (risk) {
        const decision = dangerDecision(request, risk);
        askDecision ??= { ...decision, suggestions: approvalSuggestions(request) };
        patternDecisions.push(askDecision);
        continue;
      }

      if (policyDecision.action === "ask") {
        const decision = askFromPolicy(policyDecision, request, pattern);
        askDecision ??= decision;
        patternDecisions.push(decision);
        continue;
      }

      const decision = allowFromPolicy(policyDecision, request, pattern);
      allowDecision = decision;
      patternDecisions.push(decision);
    }

    if (askDecision) {
      return {
        decision: {
          ...askDecision,
          metadata: {
            ...askDecision.metadata,
            patternDecisions,
            risks,
          },
        },
        risks,
      };
    }

    if (request.maxApprovalScope === "once" && !this.allowsOneShotPolicyBypass(request)) {
      return {
        decision: {
          action: "ask",
          source: "approval_request",
          reason: "This operation requires a fresh one-time approval.",
          suggestions: [],
          metadata: {
            permission: request.permission,
            patterns: request.patterns,
            patternDecisions,
            risks,
          },
        },
        risks,
      };
    }

    const decision: ApprovalPreflightDecision = {
      action: "allow",
      source: allowDecision?.source ?? "policy_rule",
      reason: allowDecision?.reason ?? "All approval patterns are allowed by policy.",
      metadata: {
        permission: request.permission,
        patterns: request.patterns,
        patternDecisions,
        risks,
      },
    };
    if (allowDecision?.matchedRule) decision.matchedRule = allowDecision.matchedRule;
    return { decision, risks };
  }

  private rememberSessionGrant(
    request: ApprovalBrokerRequest,
    action: "allow_session" | "allow_always",
    feedback: string | undefined,
  ): SessionApprovalGrant {
    const source = `${action}:${request.approvalId}`;
    const grant: SessionApprovalGrant = {
      sessionId: request.sessionId,
      permission: request.permission,
      patterns: [...request.patterns],
      source,
      metadata: {
        approvalId: request.approvalId,
        callId: request.callId,
        toolName: request.toolName,
        ...(feedback ? { feedback } : {}),
      },
    };
    this.state.addSessionGrant(grant);
    return grant;
  }

  private allowsOneShotPolicyBypass(request: ApprovalPreflightRequest): boolean {
    const bypass = this.options.allowOneShotPolicyBypass;
    return typeof bypass === "function" ? bypass(request) : bypass === true;
  }

  private rulesetsFor(request: ApprovalPreflightRequest): readonly (readonly PermissionRule[])[] {
    return [...(this.options.rulesets ?? []), ...this.state.rulesetsFor(request.sessionId)];
  }
}

interface ApprovalRisk {
  pattern: string;
  action: "ask" | "deny";
  reason: string;
  source: string;
}

function approvalRisk(permission: string, pattern: string): ApprovalRisk | undefined {
  const normalizedPermission = permission.toLowerCase();
  if (normalizedPermission !== "bash" && normalizedPermission !== "bash.unsandboxed") return undefined;
  const risk = classifyDangerousShellCommand(pattern);
  if (!risk) return undefined;
  return { pattern, action: risk.action, reason: risk.reason, source: "bash_danger_classifier" };
}

function requestWithPreflight(
  request: ApprovalBrokerRequest,
  risks: ApprovalRisk[],
  decision: ApprovalPreflightDecision,
): ApprovalBrokerRequest {
  return {
    ...request,
    metadata: {
      ...request.metadata,
      preflightDecision: decision,
      ...(risks.length > 0 ? { approvalRisks: risks } : {}),
    },
  };
}

function allowFromPolicy(
  decision: PermissionDecision,
  request: ApprovalPreflightRequest,
  pattern: string,
): ApprovalPreflightDecision {
  return {
    ...decision,
    action: "allow",
    metadata: {
      ...decision.metadata,
      permission: request.permission,
      pattern,
    },
  };
}

function askFromPolicy(
  decision: PermissionDecision,
  request: ApprovalPreflightRequest,
  pattern: string,
): ApprovalPreflightDecision {
  const result: ApprovalPreflightDecision = {
    ...decision,
    action: "ask",
    suggestions: decision.suggestions ?? approvalSuggestions(request),
    metadata: {
      ...decision.metadata,
      permission: request.permission,
      pattern,
    },
  };
  const feedback = decision.feedback ?? decision.reason;
  if (feedback) result.feedback = feedback;
  return result;
}

function policyDenyDecision(
  decision: PermissionDecision,
  request: ApprovalPreflightRequest,
  pattern: string,
): ApprovalPreflightDecision {
  const source = decision.matchedRule?.source ? ` (${decision.matchedRule.source})` : "";
  const feedback = `Denied by policy${source} for ${request.permission}:${pattern}`;
  return {
    ...decision,
    action: "deny",
    feedback,
    reason: decision.reason ?? feedback,
    metadata: {
      ...decision.metadata,
      permission: request.permission,
      pattern,
    },
  };
}

function dangerDecision(request: ApprovalPreflightRequest, risk: ApprovalRisk): ApprovalPreflightDecision {
  const feedback = risk.action === "deny"
    ? `Denied dangerous ${request.permission} command: ${risk.reason}`
    : `Command requires explicit approval: ${risk.reason}`;
  return {
    action: risk.action,
    feedback,
    reason: risk.reason,
    source: risk.source,
    metadata: {
      permission: request.permission,
      pattern: risk.pattern,
      risks: [risk],
    },
    ...(risk.action === "ask" ? { suggestions: approvalSuggestions(request) } : {}),
  };
}

function approvalSuggestions(request: ApprovalPreflightRequest): PermissionSuggestion[] {
  if (request.maxApprovalScope === "once") return [];
  return request.patterns.map((pattern) => ({
    permission: request.permission,
    pattern,
    action: "allow",
    scope: "session",
    source: "approval",
  }));
}

function denyDecision(decision: ApprovalPreflightDecision): ApprovalDecision {
  const feedback = decision.feedback ?? decision.reason;
  return feedback ? { action: "deny", feedback } : { action: "deny" };
}

function sessionGrantSource(source: string): string {
  return `session:${source}`;
}

function pushUniqueRule(rules: PermissionRule[], rule: PermissionRule): void {
  if (rules.some((existing) =>
    existing.permission === rule.permission
    && existing.pattern === rule.pattern
    && existing.action === rule.action
    && existing.source === rule.source)) return;
  rules.push(rule);
}

function isExplicitApprovalRule(rule: PermissionRule | undefined): boolean {
  return rule?.source?.startsWith("session:") || rule?.source === "user config.toml permissions.allow";
}

function isApprovalDecisionAction(action: unknown): action is ApprovalDecision["action"] {
  return action === "allow_once" || action === "allow_session" || action === "allow_always" || action === "deny";
}

function normalizeApprovalDecision(decision: ApprovalDecision): ApprovalDecision {
  const action = (decision as { action?: unknown } | null | undefined)?.action;
  if (isApprovalDecisionAction(action)) return decision;
  return { action: "deny", feedback: `Invalid approval decision action: ${String(action)}` };
}

export function approvalDecisionWithinScope(
  action: ApprovalDecision["action"],
  maxApprovalScope: ApprovalScope | undefined,
): boolean {
  if (action === "deny" || action === "allow_once") return true;
  if (action === "allow_session") return maxApprovalScope !== "once";
  return maxApprovalScope === undefined || maxApprovalScope === "persistent";
}
