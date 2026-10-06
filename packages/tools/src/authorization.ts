import { ToolDeniedError } from "./errors.js";
import type { ApprovalBroker, ApprovalPolicySnapshot, ApprovalPreflightDecision, ApprovalPreflightRequest } from "./types.js";

/** Capture once per boundary. Older/custom brokers retain their existing hooks. */
export async function captureApprovalPolicy(
  broker: ApprovalBroker, request: ApprovalPreflightRequest,
): Promise<ApprovalPolicySnapshot> {
  if (broker.capturePolicy) return broker.capturePolicy(request);
  return {
    preflight: () => broker.preflight?.(request) ?? Promise.resolve({
      action: "ask", source: "approval_broker", reason: "Approval broker does not support preflight.",
      metadata: { permission: request.permission, patterns: request.patterns },
    }),
    resourceDenials: () => broker.resourceDenials?.(request) ?? Promise.resolve(undefined),
    assertFileResourceAccess: (paths, access) => broker.assertFileResourceAccess?.(request, paths, access) ?? Promise.resolve(),
  };
}

export function assertApprovalAuthority(
  toolName: string, latest: ApprovalPreflightDecision, authority?: ApprovalPreflightDecision,
): void {
  if (latest.action === "deny") throw new ToolDeniedError(toolName, latest.feedback ?? latest.reason);
  if (authority && ((authority.action === "allow" && latest.action !== "allow")
    || (authority.revision !== undefined && authority.revision !== latest.revision))) {
    throw new ToolDeniedError(toolName, "Permission authority changed before execution; request a fresh approval.");
  }
}
