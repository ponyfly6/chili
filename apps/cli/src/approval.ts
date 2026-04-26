import { createInterface, type Interface } from "node:readline/promises";
import type { ApprovalDecision } from "@chili/protocol";
import { PolicyApprovalBroker, type ApprovalBrokerRequest } from "@chili/tools";
import type { PermissionRule } from "@chili/policy";

export interface CliApprovalOptions {
  yes?: boolean;
  readline?: Interface;
}

export function createCliApprovalBroker(options: CliApprovalOptions = {}): PolicyApprovalBroker {
  return new PolicyApprovalBroker({
    rulesets: [createCliPermissionRules(options.yes ?? false)],
    ask: async (request) => askApproval(request, options),
  });
}

export function createCliPermissionRules(yes: boolean): PermissionRule[] {
  return yes
    ? [{ permission: "*", pattern: "*", action: "allow" }]
    : [
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "glob", pattern: "*", action: "allow" },
        { permission: "grep", pattern: "*", action: "allow" },
        { permission: "git_diff", pattern: "*", action: "allow" },
      ];
}

async function askApproval(request: ApprovalBrokerRequest, options: CliApprovalOptions): Promise<ApprovalDecision> {
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
      const answer = (await rl.question("Allow? [y]es / [a]lways / [n]o > ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes" || answer === "") return { action: "allow_once" };
      if (answer === "a" || answer === "always") return { action: "allow_always" };
      if (answer === "n" || answer === "no") return { action: "deny", feedback: "Denied from CLI" };
    }
  } finally {
    ownReadline?.close();
  }
}
