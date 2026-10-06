import { createHash } from "node:crypto";
import type { ApprovalDecision, ApprovalScope, SessionId } from "@chili/protocol";
import { evaluatePolicy, type PermissionDecision, type PermissionRule, type PermissionSuggestion } from "@chili/policy";
import { approvalGrantPatterns, approvalGrantPermission, canonicalPermissionRules, canonicalResourcePattern,
  FILE_READ_PERMISSIONS, FILE_WRITE_PERMISSIONS, resolveFileResourceDenials } from "./resource-policy.js";
import { ToolDeniedError } from "./errors.js";
import { classifyDangerousShellCommand } from "./shell-safety.js";
import type {
  ApprovalBroker,
  ApprovalBrokerRequest,
  ApprovalPolicySnapshot,
  ApprovalPreflightDecision,
  ApprovalPreflightRequest,
  ApprovalResolution,
  ToolResourceDenials,
} from "./types.js";

export interface PolicyApprovalBrokerOptions {
  rulesets?: readonly (readonly PermissionRule[])[];
  ask?: (request: ApprovalBrokerRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;
  onSessionGrant?: (grant: SessionApprovalGrant) => Promise<void> | void;
  dangerousShellCommands?: "ask" | "allow";
  allowOneShotPolicyBypass?: boolean | ((request: ApprovalPreflightRequest) => boolean);
  state?: PolicyApprovalState;
  rulesetsForRequest?: (request: ApprovalPreflightRequest) => Promise<readonly (readonly PermissionRule[])[]> | readonly (readonly PermissionRule[])[];
  onApproved?: (request: ApprovalBrokerRequest, decision: ApprovalDecision) => Promise<ApprovalDecision>;

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
  private revocationRevision = 0;
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

  getRevocationRevision(): number {
    return this.revocationRevision;
  }

  revokeSessionGrants(sessionId: SessionId): void {
    this.revocationRevision += 1;
    this.sessionGrants.delete(this.rootSession(sessionId));
  }

  removeSessionGrant(grant: SessionApprovalGrant): void {
    const root = this.rootSession(grant.sessionId);
    const rules = this.sessionGrants.get(root);
    if (rules) this.sessionGrants.set(root, rules.filter((rule) => rule.source !== sessionGrantSource(grant.source)));
  }

  clearPersistentGrants(): void {
    this.revocationRevision += 1;
    this.persistentGrants.length = 0;
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

  /** Fresh rules for one boundary; all derived checks use this same observation. */
  async capturePolicy(request: ApprovalPreflightRequest): Promise<ApprovalPolicySnapshot> {
    const snapshot = await this.loadPolicy(request);
    return {
      preflight: async () => ({ ...(await this.evaluate(request, snapshot)).decision, revision: snapshot.revision }),
      resourceDenials: async () => request.workspaceRoot
        ? resolveFileResourceDenials(request.workspaceRoot, snapshot.rulesets) : undefined,
      assertFileResourceAccess: (paths, access) => assertFileResourceAccess(request, snapshot.rulesets, paths, access),
    };
  }

  async preflight(request: ApprovalPreflightRequest): Promise<ApprovalPreflightDecision> {
    return (await this.inspect(request)).decision;
  }

  async resourceDenials(request: ApprovalPreflightRequest): Promise<ToolResourceDenials | undefined> {
    if (!request.workspaceRoot) return undefined;
    return (await this.capturePolicy(request)).resourceDenials();
  }

  async assertFileResourceAccess(request: ApprovalPreflightRequest, paths: readonly string[], access: "read" | "write"): Promise<void> {
    return (await this.capturePolicy(request)).assertFileResourceAccess(paths, access);
  }

  async decide(request: ApprovalBrokerRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    return (await this.resolve(request, signal)).decision;
  }

  async resolve(request: ApprovalBrokerRequest, signal?: AbortSignal): Promise<ApprovalResolution> {
    const evaluated = await this.inspect(request);
    const initial = evaluated.decision;
    const finish = (decision: ApprovalDecision, authority = initial): ApprovalResolution => ({ decision, authority });
    if (initial.action === "deny") return finish(denyDecision(initial));
    if (signal?.aborted) return finish({ action: "deny", feedback: "Approval was cancelled." });
    if (initial.action === "allow") return finish({ action: "allow_once" });

    if (!this.options.ask) {
      const feedback = evaluated.risks.length > 0
        ? `Command requires explicit approval: ${evaluated.risks.map((risk) => risk.reason).join("; ")}`
        : initial.reason ?? "No approval handler is configured.";
      return finish({ action: "deny", feedback });
    }

    let decision = normalizeApprovalDecision(await this.options.ask(requestWithPreflight(request, evaluated.risks, initial), signal));
    if (signal?.aborted) return finish({ action: "deny", feedback: "Approval was cancelled." });
    if (decision.action === "deny") return finish(decision);
    let current = (await this.inspect(request)).decision;
    if (current.action === "deny") return finish(denyDecision(current), current);
    if (initial.revision !== current.revision) {
      return finish({ action: "deny", feedback: "Permission policy changed while approval was pending; request a fresh approval." }, current);
    }
    if (!approvalDecisionWithinScope(decision.action, request.maxApprovalScope)) {
      return finish({ action: "deny", feedback: `Approval decision ${decision.action} exceeds the maximum approval scope ${request.maxApprovalScope ?? "persistent"}.` }, current);
    }
    if (this.options.onApproved) {
      decision = normalizeApprovalDecision(await this.options.onApproved(request, decision));
      if (decision.action === "deny") return finish(decision, current);
      if (!approvalDecisionWithinScope(decision.action, request.maxApprovalScope)) {
        return finish({ action: "deny", feedback: "Persisted approval exceeds the maximum approval scope." }, current);
      }
      current = (await this.inspect(request)).decision;
      if (current.action === "deny") return finish(denyDecision(current), current);
      // Persistent approval intentionally adds its grant to the configured rules.
      // Other decisions cannot acquire a newer version just because a hook awaited.
      if (initial.revision !== current.revision && !(decision.action === "allow_always" && current.action === "allow")) {
        return finish({ action: "deny", feedback: "Permission authority changed before approval completed." }, current);
      }
    }
    if (signal?.aborted || evaluated.revocationRevision !== this.state.getRevocationRevision()) {
      return finish({ action: "deny", feedback: "Permission authority was cancelled or revoked before approval completed." }, current);
    }
    if (decision.action === "allow_session" || (decision.action === "allow_always" && !this.options.onApproved)) {
      const grant = this.rememberSessionGrant(request, decision.action, decision.feedback);
      try {
        await this.options.onSessionGrant?.(grant);
      } catch (error) {
        this.state.removeSessionGrant(grant);
        throw error;
      }
      current = (await this.inspect(request)).decision;
      if (signal?.aborted || current.action === "deny" || initial.revision !== current.revision
        || evaluated.revocationRevision !== this.state.getRevocationRevision()) {
        this.state.removeSessionGrant(grant);
        return finish({ action: "deny", feedback: "Permission authority changed before approval completed." }, current);
      }
      return finish(decision, current);
    }
    return finish(decision, current);
  }

  private async inspect(request: ApprovalPreflightRequest): Promise<{
    decision: ApprovalPreflightDecision; risks: ApprovalRisk[]; revocationRevision?: number;
  }> {
    let snapshot: PolicySnapshot;
    try {
      snapshot = await this.loadPolicy(request);
    } catch {
      return { decision: { action: "deny", source: "session_workspace_policy", feedback: `Unable to resolve permission policy for session ${request.sessionId}.` }, risks: [] };
    }
    const evaluated = await this.evaluate(request, snapshot);
    return { ...evaluated, decision: { ...evaluated.decision, revision: snapshot.revision }, revocationRevision: snapshot.revocationRevision };
  }

  private async evaluate(request: ApprovalPreflightRequest, snapshot: PolicySnapshot): Promise<{ decision: ApprovalPreflightDecision; risks: ApprovalRisk[] }> {
    let rulesets: readonly (readonly PermissionRule[])[];
    try {
      rulesets = await canonicalPermissionRules(request, snapshot.rulesets);
    } catch {
      return { decision: { action: "deny", source: "resource_policy", feedback: "Unable to resolve current resource permission policy." }, risks: [] };
    }
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
      const risk = snapshot.dangerousShellCommands === "allow" ? undefined : approvalRisk(request.permission, pattern);
      if (risk?.action === "deny") {
        return {
          decision: dangerDecision(request, risk),
          risks,
        };
      }
      if (risk) risks.push(risk);

      const policyDecision = evaluatePolicy(request.permission, pattern, rulesets);
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

    if (request.maxApprovalScope === "once" && !snapshot.allowOneShotPolicyBypass) {
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
      permission: approvalGrantPermission(request),
      patterns: approvalGrantPatterns(request),
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

  private async loadPolicy(request: ApprovalPreflightRequest): Promise<PolicySnapshot> {
    const resolved = this.options.rulesetsForRequest
      ? await this.options.rulesetsForRequest(request) : this.options.rulesets ?? [];
    // Resolvers and grant stores may return mutable arrays. Copy before any
    // canonicalization awaits, so decisions and revision cannot describe different rules.
    const configured = copyRulesets(resolved);
    const grants = copyRulesets(this.state.rulesetsFor(request.sessionId));
    const revocationRevision = this.state.getRevocationRevision();
    const dangerousShellCommands = this.options.dangerousShellCommands;
    const bypass = this.options.allowOneShotPolicyBypass;
    const allowOneShotPolicyBypass = typeof bypass === "function" ? bypass(request) : bypass === true;
    const revision = createHash("sha256").update(JSON.stringify([
      configured, revocationRevision, dangerousShellCommands, allowOneShotPolicyBypass,
    ])).digest("hex");
    // Grant additions do not invalidate other pending approvals. Revocations do.
    return { rulesets: [...configured, ...grants], revision, revocationRevision, dangerousShellCommands, allowOneShotPolicyBypass };
  }
}

interface PolicySnapshot {
  rulesets: readonly (readonly PermissionRule[])[];
  revision: string;
  revocationRevision: number;
  dangerousShellCommands: "ask" | "allow" | undefined;
  allowOneShotPolicyBypass: boolean;
}

function copyRulesets(rulesets: readonly (readonly PermissionRule[])[]): readonly (readonly PermissionRule[])[] {
  return Object.freeze(rulesets.map((rules) => Object.freeze(rules.map((rule) => Object.freeze({ ...rule })))));
}

async function assertFileResourceAccess(
  request: ApprovalPreflightRequest, rulesets: readonly (readonly PermissionRule[])[],
  paths: readonly string[], access: "read" | "write",
): Promise<void> {
  if (!request.workspaceRoot) throw new ToolDeniedError(request.toolName, "Resource access requires a workspace identity.");
  const resources = await Promise.all(paths.map((path) => canonicalResourcePattern(request.workspaceRoot!, path, true)));
  for (const permission of access === "read" ? FILE_READ_PERMISSIONS : FILE_WRITE_PERMISSIONS) {
    const rules = await canonicalPermissionRules({ ...request, permission }, rulesets);
    for (const resource of resources) {
      const decision = evaluatePolicy(permission, resource, rules);
      if (decision.action === "deny") {
        throw new ToolDeniedError(request.toolName, `Resource ${access} denied by ${permission} policy: ${resource}`);
      }
    }
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
