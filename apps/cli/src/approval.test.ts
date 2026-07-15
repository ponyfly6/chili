import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ApprovalId, SessionId, ToolCallId } from "@chili/protocol";
import { evaluatePolicy } from "@chili/policy";
import { PolicyApprovalBroker, PolicyApprovalState, type ApprovalBrokerRequest } from "@chili/tools";
import { createCliApprovalBroker, createCliApprovalRulesets, persistAllowAlwaysDecision, runtimePermissionConfig } from "./approval.js";

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

test("permission profiles expose Codex-style default and full-access semantics", async () => {
  const defaultRulesets = createCliApprovalRulesets("default");
  expect(evaluatePolicy("edit", "src/app.ts", defaultRulesets).action).toBe("allow");
  expect(evaluatePolicy("bash", "npm test", defaultRulesets).action).toBe("ask");

  const fullAccessBroker = createCliApprovalBroker({ yes: true });
  expect(await fullAccessBroker.preflight(approvalRequest("sudo echo ok"))).toMatchObject({
    action: "allow",
  });

  const config = runtimePermissionConfig("default");
  expect(config.profiles.map((profile) => profile.label)).toEqual(["Default", "Auto-review", "Full Access"]);
  expect(config.profiles.find((profile) => profile.id === "auto-review")?.disabledReason).toContain("not implemented");
  expect(config.profiles.find((profile) => profile.id === "default")?.description).toContain("macOS sandbox");
  expect(config.profiles.find((profile) => profile.id === "full-access")?.description).toContain("without the OS sandbox");
});

test("default profile allows ordinary shell only when the shell runner is sandboxed", async () => {
  const sandboxed = createCliApprovalRulesets("default", undefined, { sandboxedShell: true });
  const unsandboxed = createCliApprovalRulesets("default", undefined, { sandboxedShell: false });

  expect(evaluatePolicy("bash", "rg -n approval packages", sandboxed).action).toBe("allow");
  expect(evaluatePolicy("bash", "rg -n approval packages", unsandboxed).action).toBe("ask");
  expect(evaluatePolicy("task", "spawn", sandboxed).action).toBe("allow");
  expect(evaluatePolicy("task", "task_existing", sandboxed).action).toBe("ask");

  let asked = 0;
  const broker = createCliApprovalBroker({
    sandboxedShell: true,
    readline: {
      question: async () => {
        asked += 1;
        return "yes";
      },
    } as never,
  });
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    expect(await broker.decide(approvalRequest("rg -n approval packages"))).toMatchObject({ action: "allow_once" });
    expect(asked).toBe(0);
    expect(await broker.decide(approvalRequest("rm -rf *"))).toMatchObject({ action: "allow_once" });
    expect(asked).toBe(1);
  } finally {
    console.log = originalLog;
  }
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
      config: {
        userPermissions: [{ permission: "bash(*)", pattern: "*", action: "ask" }],
        projectPermissions: [],
      },
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

test("CLI broker installs always approvals into shared runtime policy immediately", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-approval-hot-"));
  const originalLog = console.log;
  try {
    console.log = () => undefined;
    const state = new PolicyApprovalState();
    const broker = createCliApprovalBroker({
      chiliHome: root,
      sandboxedShell: false,
      approvalState: state,
      readline: { question: async () => "always" } as never,
    });
    const peer = new PolicyApprovalBroker({ state });

    expect((await broker.decide(approvalRequest("git status --short"))).action).toBe("allow_always");
    expect(await peer.preflight({
      ...approvalRequest("git status --short"),
      sessionId: "session_peer" as SessionId,
    })).toMatchObject({
      action: "allow",
      matchedRule: { source: "user config.toml permissions.allow" },
    });
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
