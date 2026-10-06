import { expect, test } from "bun:test";
import type { SessionId } from "@chili/protocol";
import { createCodeModeTool, isToolVisible } from "@chili/tools";
import { completeWorkerToolPolicy, defaultScopedWorkerPolicy } from "./worker-policy.js";

test("scoped workers can message and inspect agents without spawning nested work", () => {
  const policy = defaultScopedWorkerPolicy();
  expect(policy.allowedTools).toContain("agent_send");
  expect(policy.allowedTools).toContain("agent_list");
  expect(policy.allowedTools).toContain("complete_task");
  expect(policy.allowedTools).toContain("code_mode");
  expect(policy.allowedTools).not.toContain("agent_spawn");
  expect(policy.allowedTools).not.toContain("agent_resume");
  expect(policy.allowedTools).not.toContain("agent_message_send");
  expect(policy.allowedTools).not.toContain("agent_message_list");
  expect(policy.writeScope).toEqual([]);
  expect(policy.executeScope).toEqual([]);
});

test("resumed worker policies preserve messaging grants and denials under canonical names", () => {
  const template = {
    allowedTools: ["read", "agent_message_send", "agent_send", "agent_message_list"],
    deniedTools: ["agent_message_send", "bash"],
    writeScope: ["src/**"],
    executeScope: [],
  };
  const policy = completeWorkerToolPolicy(template, "session_child" as SessionId);
  expect(policy).toEqual({
    allowedTools: ["read", "agent_send", "agent_list", "code_mode"],
    deniedTools: ["agent_send", "bash"],
    writeScope: ["src/**"],
    executeScope: [],
    childSessionId: "session_child" as SessionId,
  });
  expect(template.allowedTools).toContain("agent_message_send");
  expect(completeWorkerToolPolicy({}, "session_unrestricted" as SessionId)).toEqual({
    childSessionId: "session_unrestricted" as SessionId,
  });
});

test("custom worker allowlists retain code mode without granting nested capabilities or overriding explicit denials", () => {
  const template = { allowedTools: ["read"], writeScope: [], executeScope: [] };
  const policy = completeWorkerToolPolicy(template, "session_child" as SessionId);
  expect(policy.allowedTools).toEqual(["read", "code_mode"]);
  expect(template.allowedTools).toEqual(["read"]);
  expect(isToolVisible(createCodeModeTool(), policy)).toBe(true);
  expect(completeWorkerToolPolicy(policy, "session_child" as SessionId)).toEqual(policy);
  const denied = completeWorkerToolPolicy({ ...template, deniedTools: ["code_mode"] }, "session_child" as SessionId);
  expect(isToolVisible(createCodeModeTool(), denied)).toBe(false);
});
