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
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class DeferredApprovalQueue {
  private readonly pending = new Map<ApprovalId, PendingApproval>();

  constructor(private readonly options: DeferredApprovalQueueOptions = {}) {}

  ask(request: ApprovalBrokerRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const pending: PendingApproval = { request, resolve, reject };
      if (this.options.timeoutMs) {
        pending.timer = setTimeout(() => {
          this.pending.delete(request.approvalId);
          this.cleanup(pending);
          resolve({ action: "deny", feedback: "Approval timed out." });
        }, this.options.timeoutMs);
      }
      if (signal) {
        pending.signal = signal;
        pending.onAbort = () => {
          if (!this.pending.delete(request.approvalId)) return;
          this.cleanup(pending);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(request.approvalId, pending);
    });
  }

  resolve(input: ResolveDeferredApprovalInput): boolean {
    const pending = this.pending.get(input.approvalId);
    if (!pending) return false;
    this.pending.delete(input.approvalId);
    this.cleanup(pending);
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
      this.cleanup(pending);
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

  private cleanup(pending: PendingApproval): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Approval aborted");
  error.name = "AbortError";
  return error;
}

function toApprovalDecision(decision: ApprovalPreflightDecision): ApprovalDecision {
  if (decision.action === "allow") return { action: "allow_once" };
  const feedback = decision.feedback ?? decision.reason;
  return feedback ? { action: "deny", feedback } : { action: "deny" };
}
