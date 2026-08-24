import { expect, test } from "bun:test";
import type { SessionId } from "@chili/protocol";
import {
  DelegationPolicyGate,
  DelegationPolicyOffError,
  type DelegationPolicyGateOptions,
  resolveDelegationConfig,
} from "./delegation.js";

const sessionId = "session_delegation" as SessionId;

test("delegation selector defaults to explicit and preserves the legacy ultra fallback", () => {
  expect(resolveDelegationConfig({ sessionId })).toEqual({
    sessionId,
    policy: "explicit",
    source: "default",
  });
  expect(resolveDelegationConfig({ sessionId, reasoningLevel: "ultra" })).toEqual({
    sessionId,
    policy: "proactive",
    source: "reasoning_legacy",
  });
});

test("delegation selector gives explicit policy inputs precedence over reasoning", () => {
  expect(resolveDelegationConfig({ sessionId, defaultPolicy: "proactive", reasoningLevel: "off" })).toEqual({
    sessionId,
    policy: "proactive",
    source: "default",
  });
  expect(resolveDelegationConfig({
    sessionId,
    sessionPolicy: "off",
    defaultPolicy: "proactive",
    reasoningLevel: "ultra",
  })).toEqual({
    sessionId,
    policy: "off",
    source: "session",
  });
});

test("delegation policy gate resolves nested child sessions to the root override", async () => {
  const rootSessionId = "session_root" as SessionId;
  const childSessionId = "session_child" as SessionId;
  const grandchildSessionId = "session_grandchild" as SessionId;
  const store = {
    async agentTasks(query: { childSessionId?: SessionId }) {
      if (query.childSessionId === childSessionId) {
        return [{ parentSessionId: rootSessionId, childSessionId, updatedAt: 1 }];
      }
      if (query.childSessionId === grandchildSessionId) {
        return [{ parentSessionId: childSessionId, childSessionId: grandchildSessionId, updatedAt: 2 }];
      }
      return [];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const requested: SessionId[] = [];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      requested.push(requestedSessionId);
      return {
        sessionId: requestedSessionId,
        policy: requestedSessionId === rootSessionId ? "off" : "proactive",
        source: "session",
      };
    },
  });

  expect(await gate.rootSessionId(grandchildSessionId)).toBe(rootSessionId);
  expect(await gate.isOff(grandchildSessionId)).toBe(true);
  expect(requested.at(-1)).toBe(rootSessionId);
  await expect(gate.assertEnabled({ sessionId: grandchildSessionId, action: "task.spawn" }))
    .rejects.toBeInstanceOf(DelegationPolicyOffError);
});

test("delegation policy gate falls back through persistent team membership", async () => {
  const rootSessionId = "session_team_root" as SessionId;
  const childSessionId = "session_team_child" as SessionId;
  const memberQueries: Array<{ childSessionId?: SessionId; limit?: number }> = [];
  const store = {
    async agentTasks() {
      return [];
    },
    async teamMembers(query: { childSessionId?: SessionId; limit?: number }) {
      memberQueries.push(query);
      return [{ teamId: "team_1", childSessionId, updatedAt: 1 }];
    },
    async teams() {
      return [{ id: "team_1", sessionId: rootSessionId }];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "off", source: "session" };
    },
  });

  expect(await gate.rootSessionId(childSessionId)).toBe(rootSessionId);
  expect(memberQueries).toContainEqual({ childSessionId, limit: 2 });
});

test("delegation policy gate fails closed for duplicate team session ancestry", async () => {
  const childSessionId = "session_team_duplicate" as SessionId;
  const store = {
    async agentTasks() {
      return [];
    },
    async teamMembers(query: { childSessionId?: SessionId; limit?: number }) {
      expect(query).toEqual({ childSessionId, limit: 2 });
      return [
        { teamId: "team_1", childSessionId, updatedAt: 1 },
        { teamId: "team_2", childSessionId, updatedAt: 2 },
      ];
    },
    async teams() {
      throw new Error("ambiguous membership must be rejected before resolving a team");
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "explicit", source: "default" };
    },
  });

  await expect(gate.assertEnabled({ sessionId: childSessionId, action: "task.spawn" }))
    .rejects.toThrow(`Ambiguous delegation ancestry for team member session ${childSessionId}`);
});
