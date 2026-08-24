import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ApprovalId, SessionId, ToolCallId } from "@chili/protocol";
import { evaluatePolicy } from "@chili/policy";
import { PolicyApprovalBroker, PolicyApprovalState, type ApprovalBrokerRequest } from "@chili/tools";
import {
  createCliApprovalBroker,
  createCliApprovalRulesets,
  createRequestScopedPolicyApprovalBroker,
  persistAllowAlwaysDecision,
  runtimePermissionConfig,
} from "./approval.js";

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

test("default profile allows sandboxed shell and local task lifecycle operations", async () => {
  const sandboxed = createCliApprovalRulesets("default", undefined, { sandboxedShell: true });
  const unsandboxed = createCliApprovalRulesets("default", undefined, { sandboxedShell: false });

  expect(evaluatePolicy("bash", "rg -n approval packages", sandboxed).action).toBe("allow");
  expect(evaluatePolicy("bash.unsandboxed", "rg -n approval packages", sandboxed).action).toBe("ask");
  expect(evaluatePolicy("bash", "rg -n approval packages", unsandboxed).action).toBe("ask");
  expect(evaluatePolicy("task", "spawn", sandboxed).action).toBe("allow");
  expect(evaluatePolicy("task", "task_existing", sandboxed).action).toBe("allow");

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

test("default profile does not let configured grants bypass one-off unsandboxed approval", () => {
  const rulesets = createCliApprovalRulesets("default", {
    userPermissions: [{ permission: "bash.unsandboxed", pattern: "*", action: "allow" }],
    projectPermissions: [{ permission: "*", pattern: "*", action: "allow" }],
  }, { sandboxedShell: true });

  expect(evaluatePolicy("bash.unsandboxed", "remindctl status", rulesets).action).toBe("ask");
  expect(evaluatePolicy("read", "README.md", rulesets).action).toBe("allow");
});

test("request-scoped approval rules isolate project denies and grants across workspace trees", async () => {
  const state = new PolicyApprovalState();
  const parentA = "session_policy_parent_a" as SessionId;
  const parentB = "session_policy_parent_b" as SessionId;
  const childA = "session_policy_child_a" as SessionId;
  const childB = "session_policy_child_b" as SessionId;
  const workspaceBySession = new Map<SessionId, "a" | "b">([
    [parentA, "a"],
    [childA, "a"],
    [parentB, "b"],
    [childB, "b"],
  ]);
  const projectPermissions = {
    a: [
      { permission: "workspace.guard", pattern: "a-only", action: "deny", source: "project-a" },
      { permission: "workspace.guard", pattern: "denied-a", action: "deny", source: "project-a" },
    ],
    b: [
      { permission: "workspace.guard", pattern: "b-only", action: "deny", source: "project-b" },
      { permission: "workspace.guard", pattern: "denied-b", action: "deny", source: "project-b" },
    ],
  } as const;
  const broker = createRequestScopedPolicyApprovalBroker({
    state,
    rulesetsForRequest: (request) => {
      const workspace = workspaceBySession.get(request.sessionId);
      if (!workspace) throw new Error("unknown session");
      return createCliApprovalRulesets("default", {
        userPermissions: [],
        projectPermissions: [...projectPermissions[workspace]],
      });
    },
  });
  const preflight = (sessionId: SessionId, pattern: string) => broker.preflight({
    ...approvalRequest(pattern),
    sessionId,
    permission: "workspace.guard",
  });

  expect(await preflight(parentA, "a-only")).toMatchObject({
    action: "deny",
    matchedRule: { source: "project-a" },
  });
  expect(await preflight(parentB, "a-only")).toMatchObject({ action: "ask" });
  expect(await preflight(parentB, "b-only")).toMatchObject({
    action: "deny",
    matchedRule: { source: "project-b" },
  });
  expect(await preflight(parentA, "b-only")).toMatchObject({ action: "ask" });

  state.linkSession(parentA, childA);
  state.linkSession(parentB, childB);
  state.addSessionGrant({
    sessionId: parentA,
    permission: "workspace.guard",
    patterns: ["denied-a", "grant-a"],
    source: "parent-a",
  });
  expect(await preflight(childA, "grant-a")).toMatchObject({ action: "allow", source: "session_grant" });
  expect(await preflight(childB, "grant-a")).toMatchObject({ action: "ask" });
  expect(await preflight(childA, "denied-a")).toMatchObject({
    action: "deny",
    matchedRule: { source: "project-a" },
  });

  state.addSessionGrant({
    sessionId: parentB,
    permission: "workspace.guard",
    patterns: ["denied-b", "grant-b"],
    source: "parent-b",
  });
  expect(await preflight(childB, "grant-b")).toMatchObject({ action: "allow", source: "session_grant" });
  expect(await preflight(childA, "grant-b")).toMatchObject({ action: "ask" });
  expect(await preflight(childB, "denied-b")).toMatchObject({
    action: "deny",
    matchedRule: { source: "project-b" },
  });
});

test("request-scoped approval rules fail closed when session policy resolution fails", async () => {
  const broker = createRequestScopedPolicyApprovalBroker({
    rulesetsForRequest: async () => {
      throw new Error("missing session workspace");
    },
  });
  const request = approvalRequest("workspace-bound-operation");

  expect(await broker.preflight(request)).toMatchObject({
    action: "deny",
    source: "session_workspace_policy",
    feedback: "Unable to resolve permission policy for session session_test.",
  });
  expect(await broker.decide(request)).toEqual({
    action: "deny",
    feedback: "Unable to resolve permission policy for session session_test.",
  });
});

test("request-scoped approval broker propagates approval handler failures", async () => {
  const failure = new Error("approval queue failed");
  const broker = createRequestScopedPolicyApprovalBroker({
    rulesetsForRequest: () => [],
    ask: async () => {
      throw failure;
    },
  });
  const request: ApprovalBrokerRequest = {
    ...approvalRequest("needs-review"),
    permission: "workspace.guard",
  };

  await expect(broker.decide(request)).rejects.toBe(failure);
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

test("one-off approvals cannot be persisted or widened interactively", async () => {
  const root = await mkdtemp(join(tmpdir(), "chili-approval-once-"));
  const originalLog = console.log;
  const prompts: string[] = [];
  const answers = ["session", "yes"];
  try {
    const request = {
      ...approvalRequest("remindctl status"),
      permission: "bash.unsandboxed",
      maxApprovalScope: "once" as const,
    };
    expect(await persistAllowAlwaysDecision(request, { action: "allow_always" }, { chiliHome: root })).toMatchObject({
      action: "deny",
    });
    await expect(readFile(join(root, "config.toml"), "utf8")).rejects.toThrow();

    console.log = () => undefined;
    const broker = createCliApprovalBroker({
      chiliHome: root,
      sandboxedShell: true,
      readline: {
        question: async (prompt: string) => {
          prompts.push(prompt);
          return answers.shift() ?? "no";
        },
      } as never,
    });
    expect(await broker.decide(request)).toMatchObject({ action: "allow_once" });
    expect(prompts).toEqual([
      "Allow once? [y]es / [n]o > ",
      "Allow once? [y]es / [n]o > ",
    ]);
  } finally {
    console.log = originalLog;
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
