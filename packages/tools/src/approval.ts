import type { ApprovalDecision } from "@chili/protocol";
import { evaluatePolicy, type PermissionRule } from "@chili/policy";
import type { ApprovalBroker, ApprovalBrokerRequest } from "./types.js";

export interface PolicyApprovalBrokerOptions {
  rulesets?: readonly (readonly PermissionRule[])[];
  ask?: (request: ApprovalBrokerRequest) => Promise<ApprovalDecision>;
}

export class PolicyApprovalBroker implements ApprovalBroker {
  constructor(private readonly options: PolicyApprovalBrokerOptions = {}) {}

  async decide(request: ApprovalBrokerRequest): Promise<ApprovalDecision> {
    let needsAsk = false;

    for (const pattern of request.patterns) {
      const decision = evaluatePolicy(request.permission, pattern, this.options.rulesets ?? []);
      if (decision.action === "deny") {
        return { action: "deny", feedback: `Denied by policy for ${request.permission}:${pattern}` };
      }
      if (decision.action === "ask") {
        needsAsk = true;
      }
    }

    if (!needsAsk) {
      return { action: "allow_once" };
    }

    if (this.options.ask) {
      return this.options.ask(request);
    }

    return { action: "deny", feedback: "No approval handler is configured." };
  }
}
