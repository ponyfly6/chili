import { expect, test } from "bun:test";
import type { ApprovalDecision, ApprovalId, SessionId, ToolCallId, TurnId } from "@chili/protocol";
import { PolicyApprovalBroker } from "./approval.js";
import type { ApprovalBrokerRequest } from "./types.js";

test("approval denies catastrophic bash commands even when a broad allow rule exists", async () => {
  const broker = new PolicyApprovalBroker({
    rulesets: [[{ permission: "*", pattern: "*", action: "allow" }]],
  });

  const decision = await broker.decide(approvalRequest("rm -rf /"));
  expect(decision.action).toBe("deny");
  expect(decision.feedback).toContain("Refusing recursive delete");

  const backgroundDecision = await broker.decide(approvalRequest("pwd & rm -rf /"));
  expect(backgroundDecision.action).toBe("deny");
  expect(backgroundDecision.feedback).toContain("Refusing recursive delete");
});

test("approval forces explicit review for dangerous wildcard deletes", async () => {
  let asked: ApprovalBrokerRequest | undefined;
  const broker = new PolicyApprovalBroker({
    rulesets: [[{ permission: "*", pattern: "*", action: "allow" }]],
    ask: async (request): Promise<ApprovalDecision> => {
      asked = request;
      return { action: "allow_once" };
    },
  });

  const decision = await broker.decide(approvalRequest("rm -rf *"));
  expect(decision.action).toBe("allow_once");
  expect(asked?.metadata?.approvalRisks).toEqual([
    {
      pattern: "rm -rf *",
      action: "ask",
      reason: "Recursive forced delete with a workspace wildcard requires explicit approval.",
    },
  ]);
});

function approvalRequest(command: string): ApprovalBrokerRequest {
  return {
    approvalId: "approval_test" as ApprovalId,
    sessionId: "session_test" as SessionId,
    callId: "toolcall_test" as ToolCallId,
    toolName: "bash",
    risk: "execute",
    permission: "bash",
    patterns: [command],
    metadata: {
      turnId: "turn_test" as TurnId,
    },
  };
}
