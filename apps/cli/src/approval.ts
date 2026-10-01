import { createInterface, type Interface } from "node:readline/promises";
import type { ApprovalDecision } from "@chili/protocol";
import {
  createHostApprovalBroker,
  type ApprovalRulesetResolver,
  type HostConfig,
} from "@chili/host";
import {
  approvalDecisionWithinScope,
  type ApprovalBrokerRequest,
  type PolicyApprovalBroker,
  type PolicyApprovalBrokerOptions,
  type PolicyApprovalState,
} from "@chili/tools";

export {
  createApprovalRulesets as createCliApprovalRulesets,
  createPermissionRules as createCliPermissionRules,
  createRequestScopedPolicyApprovalBroker,
  dangerousShellCommandsForProfile,
  persistApprovalGrantForRequest,
  persistAllowAlwaysDecision,
  runtimePermissionConfig,
  type ApprovalRulesetResolver as CliApprovalRulesetResolver,
  type ApprovalRulesetOptions as CliApprovalRulesetOptions,
  type PersistAllowAlwaysDecisionOptions,
  type RequestScopedPolicyApprovalBrokerOptions,
} from "@chili/host";

export interface CliApprovalOptions {
  yes?: boolean;
  readline?: Interface;
  config?: HostConfig;
  chiliHome?: string;
  sandboxedShell?: boolean;
  approvalState?: PolicyApprovalState;
  rulesetsForRequest?: ApprovalRulesetResolver;
}

export function createCliApprovalBroker(options: CliApprovalOptions = {}): PolicyApprovalBroker {
  const { yes, readline: _readline, ...shared } = options;
  return createHostApprovalBroker({
    ...shared,
    permissionProfile: yes ? "full-access" : "default",
    askApproval: createCliApprovalAsk(options),
  });
}

/** The UI returns a decision; the Host validates its scope and persists grants. */
export function createCliApprovalAsk(options: CliApprovalOptions = {}): NonNullable<PolicyApprovalBrokerOptions["ask"]> {
  return (request, signal) => askApproval(request, options, signal);
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
        return { action: "allow_always" };
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
