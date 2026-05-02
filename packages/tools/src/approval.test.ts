import { expect, test } from "bun:test";
import type { ApprovalDecision, ApprovalId, SessionId, ToolCallId, TurnId } from "@chili/protocol";
import type { PermissionRule } from "@chili/policy";
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

test("approval denies catastrophic bash commands even when user config allows them", async () => {
  const broker = new PolicyApprovalBroker({
    rulesets: [[{ permission: "bash", pattern: "rm -rf /", action: "allow", source: "user config.toml permissions.allow" }]],
  });

  const decision = await broker.decide(approvalRequest("rm -rf /"));

  expect(decision.action).toBe("deny");
  expect(decision.feedback).toContain("Refusing recursive delete");
});

test("approval fails closed when request patterns are empty", async () => {
  let asked = 0;
  const broker = new PolicyApprovalBroker({
    rulesets: [[{ permission: "*", pattern: "*", action: "allow" }]],
    ask: async (): Promise<ApprovalDecision> => {
      asked += 1;
      return { action: "allow_once" };
    },
  });
  const request = { ...approvalRequest("npm test"), patterns: [] };

  const preflight = await broker.preflight(preflightRequest(request));
  const decision = await broker.decide(request);

  expect(preflight.action).toBe("deny");
  expect(preflight.feedback).toContain("at least one pattern");
  expect(decision.action).toBe("deny");
  expect(decision.feedback).toContain("at least one pattern");
  expect(asked).toBe(0);
});

test("approval fails closed when request patterns contain blanks", async () => {
  let asked = 0;
  const broker = new PolicyApprovalBroker({
    rulesets: [[{ permission: "*", pattern: "*", action: "allow" }]],
    ask: async (): Promise<ApprovalDecision> => {
      asked += 1;
      return { action: "allow_once" };
    },
  });
  const request = { ...approvalRequest("npm test"), patterns: [""] };

  const decision = await broker.decide(request);

  expect(decision.action).toBe("deny");
  expect(decision.feedback).toContain("non-empty string");
  expect(asked).toBe(0);
});

test("approval fails closed when ask returns an unknown decision action", async () => {
  const broker = new PolicyApprovalBroker({
    ask: async () => ({ action: "surprise" } as unknown as ApprovalDecision),
  });

  const decision = await broker.decide(approvalRequest("npm test"));

  expect(decision.action).toBe("deny");
  expect(decision.feedback).toContain("Invalid approval decision action");
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
      source: "bash_danger_classifier",
    },
  ]);
  expect(asked?.metadata?.preflightDecision).toMatchObject({
    action: "ask",
    source: "bash_danger_classifier",
    suggestions: [{ permission: "bash", pattern: "rm -rf *", scope: "session" }],
  });
});

test("user config allow bypasses ask-level dangerous bash prompts", async () => {
  let asked = 0;
  const broker = new PolicyApprovalBroker({
    rulesets: [[{ permission: "bash", pattern: "rm -rf *", action: "allow", source: "user config.toml permissions.allow" }]],
    ask: async (): Promise<ApprovalDecision> => {
      asked += 1;
      return { action: "allow_once" };
    },
  });

  const preflight = await broker.preflight(preflightRequest(approvalRequest("rm -rf *")));
  const decision = await broker.decide(approvalRequest("rm -rf *"));

  expect(preflight.action).toBe("allow");
  expect(preflight.matchedRule?.source).toBe("user config.toml permissions.allow");
  expect(decision.action).toBe("allow_once");
  expect(asked).toBe(0);
});

test("allow_session grants only the current session", async () => {
  const broker = new PolicyApprovalBroker({
    ask: async (): Promise<ApprovalDecision> => ({ action: "allow_session" }),
  });
  const request = approvalRequest("npm test", "session_granted" as SessionId);

  const decision = await broker.decide(request);
  expect(decision.action).toBe("allow_session");

  const sameSession = await broker.preflight(preflightRequest(request));
  expect(sameSession.action).toBe("allow");
  expect(sameSession.source).toBe("session_grant");

  const otherSession = await broker.preflight(preflightRequest({
    ...request,
    sessionId: "session_other" as SessionId,
  }));
  expect(otherSession.action).toBe("ask");
});

test("allow_always also seeds an immediate session grant", async () => {
  const broker = new PolicyApprovalBroker({
    ask: async (): Promise<ApprovalDecision> => ({ action: "allow_always" }),
  });
  const request = approvalRequest("npm test");

  const decision = await broker.decide(request);
  expect(decision.action).toBe("allow_always");

  const later = await broker.preflight(preflightRequest(request));
  expect(later.action).toBe("allow");
  expect(later.source).toBe("session_grant");
});

test("allow_once does not create a session grant", async () => {
  const broker = new PolicyApprovalBroker({
    ask: async (): Promise<ApprovalDecision> => ({ action: "allow_once" }),
  });
  const request = approvalRequest("npm test");

  const decision = await broker.decide(request);
  expect(decision.action).toBe("allow_once");

  const later = await broker.preflight(preflightRequest(request));
  expect(later.action).toBe("ask");
});

test("policy deny overrides a session allow_always grant", async () => {
  const rules: PermissionRule[] = [];
  const broker = new PolicyApprovalBroker({
    rulesets: [rules],
    ask: async (): Promise<ApprovalDecision> => ({ action: "allow_always" }),
  });
  const request = approvalRequest("npm test");

  const grantDecision = await broker.decide(request);
  expect(grantDecision.action).toBe("allow_always");
  const granted = await broker.preflight(preflightRequest(request));
  expect(granted.action).toBe("allow");

  rules.push({ permission: "bash(npm test)", pattern: "*", action: "deny", source: "project" });
  const stillDenied = await broker.preflight(preflightRequest(request));
  expect(stillDenied.action).toBe("deny");
  expect(stillDenied.feedback).toContain("Denied by policy");
  expect(stillDenied.matchedRule?.source).toBe("project");
});

test("approval decisions recheck policy before resolving", async () => {
  const rules: PermissionRule[] = [];
  let resolveAsk: ((decision: ApprovalDecision) => void) | undefined;
  const broker = new PolicyApprovalBroker({
    rulesets: [rules],
    ask: () => new Promise<ApprovalDecision>((resolve) => {
      resolveAsk = resolve;
    }),
  });
  const request = approvalRequest("npm test");
  const pending = broker.decide(request);
  await Promise.resolve();
  rules.push({ permission: "bash(npm test)", pattern: "*", action: "deny" });
  if (!resolveAsk) throw new Error("approval was not requested");
  resolveAsk({ action: "allow_once" });

  const decision = await pending;

  expect(decision.action).toBe("deny");
  expect(decision.feedback).toContain("Denied by policy");
});

function approvalRequest(command: string, sessionId: SessionId = "session_test" as SessionId): ApprovalBrokerRequest {
  return {
    approvalId: "approval_test" as ApprovalId,
    sessionId,
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

function preflightRequest(request: ApprovalBrokerRequest) {
  const { approvalId: _approvalId, ...preflight } = request;
  return preflight;
}
