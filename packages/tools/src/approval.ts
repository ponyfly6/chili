import type { ApprovalDecision } from "@chili/protocol";
import { evaluatePolicy, type PermissionRule } from "@chili/policy";
import { classifyDangerousShellCommand } from "./shell-safety.js";
import type { ApprovalBroker, ApprovalBrokerRequest } from "./types.js";

export interface PolicyApprovalBrokerOptions {
  rulesets?: readonly (readonly PermissionRule[])[];
  ask?: (request: ApprovalBrokerRequest) => Promise<ApprovalDecision>;
}

export class PolicyApprovalBroker implements ApprovalBroker {
  constructor(private readonly options: PolicyApprovalBrokerOptions = {}) {}

  async decide(request: ApprovalBrokerRequest): Promise<ApprovalDecision> {
    let needsAsk = false;
    const risks: ApprovalRisk[] = [];

    for (const pattern of request.patterns) {
      const risk = approvalRisk(request.permission, pattern);
      if (risk?.action === "deny") {
        return { action: "deny", feedback: `Denied dangerous ${request.permission} command: ${risk.reason}` };
      }
      if (risk) {
        needsAsk = true;
        risks.push({ pattern, action: risk.action, reason: risk.reason });
      }

      const decision = evaluatePolicy(request.permission, pattern, this.options.rulesets ?? []);
      if (decision.action === "deny") {
        const source = decision.matchedRule?.source ? ` (${decision.matchedRule.source})` : "";
        return { action: "deny", feedback: `Denied by policy${source} for ${request.permission}:${pattern}` };
      }
      if (decision.action === "ask") {
        needsAsk = true;
      }
    }

    if (!needsAsk) {
      return { action: "allow_once" };
    }

    if (this.options.ask) {
      return this.options.ask(risks.length > 0 ? requestWithRisks(request, risks) : request);
    }

    if (risks.length > 0) {
      return { action: "deny", feedback: `Command requires explicit approval: ${risks.map((risk) => risk.reason).join("; ")}` };
    }

    return { action: "deny", feedback: "No approval handler is configured." };
  }
}

interface ApprovalRisk {
  pattern: string;
  action: "ask" | "deny";
  reason: string;
}

function approvalRisk(permission: string, pattern: string): ApprovalRisk | undefined {
  if (permission.toLowerCase() !== "bash") return undefined;
  const risk = classifyDangerousShellCommand(pattern);
  if (!risk) return undefined;
  return { pattern, action: risk.action, reason: risk.reason };
}

function requestWithRisks(request: ApprovalBrokerRequest, risks: ApprovalRisk[]): ApprovalBrokerRequest {
  return {
    ...request,
    metadata: {
      ...request.metadata,
      approvalRisks: risks,
    },
  };
}
