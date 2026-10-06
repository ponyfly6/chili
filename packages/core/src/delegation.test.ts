import { expect, test } from "bun:test";
import type { SessionId } from "@chili/protocol";
import {
  DelegationPolicyGate,
  DelegationPolicyOffError,
  type DelegationPolicyGateOptions,
  resolveDelegationConfig,
} from "./delegation.js";

const sessionId = "session_delegation" as SessionId;

test("delegation selector defaults to explicit regardless of reasoning effort", () => {
  expect(resolveDelegationConfig({ sessionId })).toEqual({
    sessionId,
    policy: "explicit",
    source: "default",
  });
  expect(resolveDelegationConfig({ sessionId, reasoningLevel: "ultra" })).toEqual({
    sessionId,
    policy: "explicit",
    source: "default",
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
      return [{ teamId: "team_1", path: "/root/worker", childSessionId, updatedAt: 1 }];
    },
    async teams() {
      return [{ id: "team_1", sessionId: rootSessionId, leadPath: "/root" }];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "off", source: "session" };
    },
  });

  expect(await gate.rootSessionId(childSessionId)).toBe(rootSessionId);
  expect(memberQueries).toContainEqual({ childSessionId, limit: 10_000 });
});

test("delegation policy gate fails closed for duplicate agent task session ownership", async () => {
  const childSessionId = "session_task_duplicate" as SessionId;
  const store = {
    async agentTasks(query: { childSessionId?: SessionId; limit?: number }) {
      expect(query).toEqual({ childSessionId, limit: 2 });
      return [
        { id: "task_one", childSessionId, parentSessionId: "session_root_one", updatedAt: 1 },
        { id: "task_two", childSessionId, parentSessionId: "session_root_two", updatedAt: 2 },
      ];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "explicit", source: "default" };
    },
  });

  await expect(gate.assertEnabled({ sessionId: childSessionId, action: "task.spawn" }))
    .rejects.toThrow(`Ambiguous delegation ancestry for agent task session ${childSessionId}`);
});

test("delegation policy gate fails closed for duplicate team session ancestry", async () => {
  const childSessionId = "session_team_duplicate" as SessionId;
  const store = {
    async agentTasks() {
      return [];
    },
    async teamMembers(query: { childSessionId?: SessionId; limit?: number }) {
      expect(query).toEqual({ childSessionId, limit: 10_000 });
      return [
        { teamId: "team_1", path: "/root/one", childSessionId, updatedAt: 1 },
        { teamId: "team_2", path: "/root/two", childSessionId, updatedAt: 2 },
      ];
    },
    async teams(query: { teamId?: string }) {
      return query.teamId === "team_1"
        ? [{ id: "team_1", sessionId: "session_parent_one", leadPath: "/root" }]
        : [{ id: "team_2", sessionId: "session_parent_two", leadPath: "/root" }];
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

test("delegation policy gate fails closed when task and run projections disagree", async () => {
  const childSessionId = "session_cross_projection" as SessionId;
  const store = {
    async agentTasks() {
      return [{ childSessionId, parentSessionId: "session_task_parent" as SessionId }];
    },
    async agentRuns() {
      return [{ childSessionId, parentSessionId: "session_run_parent" as SessionId }];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "explicit", source: "default" };
    },
  });

  await expect(gate.rootSessionId(childSessionId))
    .rejects.toThrow(`Conflicting delegation ancestry for session ${childSessionId}`);
});

test("delegation policy gate fails closed when task and team projections disagree", async () => {
  const childSessionId = "session_task_team_conflict" as SessionId;
  const store = {
    async agentTasks() {
      return [{ childSessionId, parentSessionId: "session_task_parent" as SessionId }];
    },
    async agentRuns() {
      return [];
    },
    async teamMembers() {
      return [{ teamId: "team_conflict", path: "/root/worker", childSessionId }];
    },
    async teams() {
      return [{
        id: "team_conflict",
        sessionId: "session_team_parent" as SessionId,
        leadPath: "/root",
      }];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "explicit", source: "default" };
    },
  });

  await expect(gate.rootSessionId(childSessionId))
    .rejects.toThrow(`Conflicting delegation ancestry for session ${childSessionId}`);
});

test("delegation policy gate rejects a projected parent missing from sessions", async () => {
  const childSessionId = "session_orphan_child" as SessionId;
  const missingParentSessionId = "session_orphan_parent" as SessionId;
  const store = {
    async sessions() {
      return [{
        id: childSessionId,
        cwd: "/repo",
        status: "active" as const,
        createdAt: 1,
        updatedAt: 1,
      }];
    },
    async agentTasks() {
      return [{ childSessionId, parentSessionId: missingParentSessionId }];
    },
    async agentRuns() {
      return [];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "explicit", source: "default" };
    },
  });

  await expect(gate.rootSessionId(childSessionId))
    .rejects.toThrow(`Delegation parent session not found: ${missingParentSessionId} (child ${childSessionId})`);
});

test("delegation policy gate rejects an archived root behind an active child", async () => {
  const rootSessionId = "session_archived_root" as SessionId;
  const childSessionId = "session_active_child" as SessionId;
  const store = {
    async sessions() {
      return [
        {
          id: rootSessionId,
          cwd: "/repo",
          status: "archived" as const,
          source: "interactive" as const,
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: childSessionId,
          cwd: "/repo",
          status: "active" as const,
          source: "subagent" as const,
          createdAt: 1,
          updatedAt: 1,
        },
      ];
    },
    async agentTasks(query: { childSessionId?: SessionId }) {
      return query.childSessionId === childSessionId
        ? [{ childSessionId, parentSessionId: rootSessionId }]
        : [];
    },
    async agentRuns() {
      return [];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "proactive", source: "session" };
    },
  });

  await expect(gate.rootSessionId(childSessionId))
    .rejects.toThrow(`Delegation parent session is not active: ${rootSessionId} (archived)`);
});

test("delegation policy gate rejects an orphan subagent as a root", async () => {
  const orphanSessionId = "session_orphan_subagent" as SessionId;
  const store = {
    async sessions() {
      return [{
        id: orphanSessionId,
        cwd: "/repo",
        status: "active" as const,
        source: "subagent" as const,
        createdAt: 1,
        updatedAt: 1,
      }];
    },
    async agentTasks() {
      return [];
    },
    async agentRuns() {
      return [];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "proactive", source: "session" };
    },
  });

  await expect(gate.rootSessionId(orphanSessionId))
    .rejects.toThrow(`Delegation root session cannot be a subagent: ${orphanSessionId}`);
});

test("delegation policy gate fails closed for multi-session ancestry cycles", async () => {
  const first = "session_cycle_first" as SessionId;
  const second = "session_cycle_second" as SessionId;
  const store = {
    async agentTasks(query: { childSessionId?: SessionId }) {
      return query.childSessionId === first
        ? [{ childSessionId: first, parentSessionId: second }]
        : [{ childSessionId: second, parentSessionId: first }];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "explicit", source: "default" };
    },
  });

  await expect(gate.assertEnabled({ sessionId: first, action: "task.spawn" }))
    .rejects.toThrow(`Cyclic delegation ancestry for session ${first}`);
});

test("delegation policy gate fails closed when ancestry exceeds its depth bound", async () => {
  const start = "session_depth_0" as SessionId;
  const store = {
    async agentTasks(query: { childSessionId?: SessionId }) {
      const depth = Number(query.childSessionId?.split("_").at(-1));
      return [{
        childSessionId: query.childSessionId,
        parentSessionId: `session_depth_${depth + 1}` as SessionId,
      }];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "explicit", source: "default" };
    },
  });

  await expect(gate.rootSessionId(start))
    .rejects.toThrow("Delegation ancestry exceeds 64 sessions");
});

test("delegation policy ignores lead self-memberships across multiple teams", async () => {
  const rootSessionId = "session_multi_team_root" as SessionId;
  const store = {
    async agentTasks() {
      return [];
    },
    async teamMembers(query: { childSessionId?: SessionId; limit?: number }) {
      expect(query).toEqual({ childSessionId: rootSessionId, limit: 10_000 });
      return [
        { teamId: "team_one", path: "/root", childSessionId: rootSessionId },
        { teamId: "team_two", path: "/root", childSessionId: rootSessionId },
      ];
    },
    async teams(query: { teamId?: string }) {
      return [{ id: query.teamId, sessionId: rootSessionId, leadPath: "/root" }];
    },
  } as unknown as DelegationPolicyGateOptions["store"];
  const gate = new DelegationPolicyGate({
    store,
    async getDelegationConfig(requestedSessionId) {
      return { sessionId: requestedSessionId, policy: "proactive", source: "session" };
    },
  });

  expect(await gate.rootSessionId(rootSessionId)).toBe(rootSessionId);
  await expect(gate.assertEnabled({ sessionId: rootSessionId, action: "task.spawn" })).resolves.toBeUndefined();
});
