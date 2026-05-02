import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ApprovalId, SessionId, ToolCallId } from "@chili/protocol";
import { evaluatePolicy } from "@chili/policy";
import type { ApprovalBrokerRequest } from "@chili/tools";
import { createCliApprovalBroker, createCliApprovalRulesets, persistAllowAlwaysDecision } from "./approval.js";

test("CLI approval rules layer defaults, user config, then project config", () => {
  const rulesets = createCliApprovalRulesets(false, {
    userPermissions: [{ permission: "bash", pattern: "git status*", action: "allow" }],
    projectPermissions: [{ permission: "bash", pattern: "git status*", action: "ask" }],
  });

  expect(evaluatePolicy("read", "README.md", rulesets).action).toBe("allow");
  expect(evaluatePolicy("bash", "git status --short", rulesets).action).toBe("ask");
});

test("--yes keeps configured denies while bypassing configured asks", () => {
  const rulesets = createCliApprovalRulesets(true, {
    userPermissions: [
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "read", pattern: "~/.ssh/**", action: "deny" },
    ],
    projectPermissions: [{ permission: "write", pattern: ".chili/**", action: "deny" }],
  });

  expect(evaluatePolicy("bash", "npm test", rulesets).action).toBe("allow");
  expect(evaluatePolicy("read", "~/.ssh/id_rsa", rulesets).action).toBe("deny");
  expect(evaluatePolicy("write", ".chili/config.toml", rulesets).action).toBe("deny");
});

test("allow_always decisions persist user-level grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-approval-"));
  try {
    const decision = await persistAllowAlwaysDecision(
      {
        approvalId: "approval_test" as ApprovalId,
        sessionId: "session_test" as SessionId,
        callId: "toolcall_test" as ToolCallId,
        toolName: "bash",
        risk: "execute",
        permission: "bash",
        patterns: ["git status --short"],
      } satisfies ApprovalBrokerRequest,
      { action: "allow_always" },
      { chiliHome: root },
    );

    expect(decision).toEqual({ action: "allow_always" });
    expect(await readFile(join(root, "config.toml"), "utf8")).toBe(
      '[permissions]\nallow = ["bash(git status --short)"]\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allow_session decisions do not persist user-level grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-approval-session-"));
  try {
    const decision = await persistAllowAlwaysDecision(
      approvalRequest("git status --short"),
      { action: "allow_session" },
      { chiliHome: root },
    );

    expect(decision).toEqual({ action: "allow_session" });
    await expect(readFile(join(root, "config.toml"), "utf8")).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI broker persists interactive always approvals through CLI helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-approval-broker-"));
  const originalLog = console.log;
  try {
    console.log = () => undefined;
    const broker = createCliApprovalBroker({
      chiliHome: root,
      readline: {
        question: async () => "always",
      } as never,
    });

    const decision = await broker.decide(approvalRequest("git status --short"));

    expect(decision.action).toBe("allow_always");
    expect(await readFile(join(root, "config.toml"), "utf8")).toBe(
      '[permissions]\nallow = ["bash(git status --short)"]\n',
    );
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
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
  };
}
