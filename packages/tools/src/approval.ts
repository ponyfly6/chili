import type { ApprovalDecision, SessionId } from "@chili/protocol";
import { evaluatePolicy, type PermissionDecision, type PermissionRule, type PermissionSuggestion } from "@chili/policy";
import { classifyDangerousShellCommand } from "./shell-safety.js";
import type { ApprovalBroker, ApprovalBrokerRequest, ApprovalPreflightDecision, ApprovalPreflightRequest } from "./types.js";

export interface PolicyApprovalBrokerOptions {
  rulesets?: readonly (readonly PermissionRule[])[];
  ask?: (request: ApprovalBrokerRequest) => Promise<ApprovalDecision>;
  onSessionGrant?: (grant: SessionApprovalGrant) => Promise<void> | void;
}

export interface SessionApprovalGrant {
  sessionId: SessionId;
  permission: string;
  patterns: string[];
  source: string;
  metadata?: Record<string, unknown>;
}

export class PolicyApprovalBroker implements ApprovalBroker {
  private readonly sessionGrants = new Map<SessionId, PermissionRule[]>();

  constructor(private readonly options: PolicyApprovalBrokerOptions = {}) {}

  async preflight(request: ApprovalPreflightRequest): Promise<ApprovalPreflightDecision> {
    return this.evaluate(request).decision;
  }

  async decide(request: ApprovalBrokerRequest): Promise<ApprovalDecision> {
    const evaluated = this.evaluate(request);
    if (evaluated.decision.action === "deny") {
      return denyDecision(evaluated.decision);
    }
    if (evaluated.decision.action === "allow") {
      return { action: "allow_once" };
    }

    if (this.options.ask) {
      const decision = normalizeApprovalDecision(await this.options.ask(requestWithPreflight(request, evaluated.risks, evaluated.decision)));
      const rechecked = this.evaluate(request).decision;
      if (rechecked.action === "deny") return denyDecision(rechecked);
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
      const risk = approvalRisk(request.permission, pattern);
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
    const rules = this.sessionGrants.get(request.sessionId) ?? [];
    for (const pattern of grant.patterns) {
      rules.push({
        permission: grant.permission,
        pattern,
        action: "allow",
        source: sessionGrantSource(source),
      });
    }
    this.sessionGrants.set(request.sessionId, rules);
    return grant;
  }

  private rulesetsFor(request: ApprovalPreflightRequest): readonly (readonly PermissionRule[])[] {
    const grants = this.sessionGrants.get(request.sessionId);
    if (!grants || grants.length === 0) return this.options.rulesets ?? [];
    return [...(this.options.rulesets ?? []), grants];
  }
}

interface ApprovalRisk {
  pattern: string;
  action: "ask" | "deny";
  reason: string;
  source: string;
}

function approvalRisk(permission: string, pattern: string): ApprovalRisk | undefined {
  if (permission.toLowerCase() !== "bash") return undefined;
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
