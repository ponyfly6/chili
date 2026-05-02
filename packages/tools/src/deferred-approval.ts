import type { ApprovalDecision, ApprovalId } from "@chili/protocol";
import type { ApprovalBrokerRequest, ApprovalPreflightDecision } from "./types.js";

export interface DeferredApprovalQueueOptions {
  timeoutMs?: number;
}

export interface ResolveDeferredApprovalInput {
  approvalId: ApprovalId;
  decision: ApprovalDecision["action"];
  feedback?: string;
}

export type DeferredApprovalRecheck = (
  request: ApprovalBrokerRequest,
) => ApprovalPreflightDecision | Promise<ApprovalPreflightDecision>;

interface PendingApproval {
  request: ApprovalBrokerRequest;
  resolve(decision: ApprovalDecision): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class DeferredApprovalQueue {
  private readonly pending = new Map<ApprovalId, PendingApproval>();

  constructor(private readonly options: DeferredApprovalQueueOptions = {}) {}

  ask(request: ApprovalBrokerRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const pending: PendingApproval = { request, resolve };
      if (this.options.timeoutMs) {
        pending.timer = setTimeout(() => {
          this.pending.delete(request.approvalId);
          resolve({ action: "deny", feedback: "Approval timed out." });
        }, this.options.timeoutMs);
      }
      this.pending.set(request.approvalId, pending);
    });
  }

  resolve(input: ResolveDeferredApprovalInput): boolean {
    const pending = this.pending.get(input.approvalId);
    if (!pending) return false;
    this.pending.delete(input.approvalId);
    if (pending.timer) clearTimeout(pending.timer);
    const decision: ApprovalDecision = { action: input.decision };
    if (input.feedback) decision.feedback = input.feedback;
    pending.resolve(decision);
    return true;
  }

  async recheckPending(recheck: DeferredApprovalRecheck): Promise<number> {
    let resolved = 0;
    for (const approvalId of [...this.pending.keys()]) {
      const pending = this.pending.get(approvalId);
      if (!pending) continue;
      const decision = await recheck(pending.request);
      if (decision.action === "ask") continue;
      this.pending.delete(approvalId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(toApprovalDecision(decision));
      resolved += 1;
    }
    return resolved;
  }

  list(): ApprovalBrokerRequest[] {
    return [...this.pending.values()].map((pending) => pending.request);
  }

  denyAll(feedback = "Approval queue closed."): void {
    for (const approvalId of [...this.pending.keys()]) {
      this.resolve({ approvalId, decision: "deny", feedback });
    }
  }
}

function toApprovalDecision(decision: ApprovalPreflightDecision): ApprovalDecision {
  if (decision.action === "allow") return { action: "allow_once" };
  const feedback = decision.feedback ?? decision.reason;
  return feedback ? { action: "deny", feedback } : { action: "deny" };
}
