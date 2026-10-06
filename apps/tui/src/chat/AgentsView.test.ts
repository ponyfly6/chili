import { expect, test } from "bun:test";
import { applyRuntimeEvent, createRuntimeView, type ChiliRuntimeView } from "@chili/sdk";
import { parseChiliEvent, type RuntimeSessionStatus, type SessionId } from "@chili/protocol";
import { agentsViewModel, delegationPolicyText } from "./AgentsView.js";

const parentId = "session_main" as SessionId;

function addAgent(view: ChiliRuntimeView, name: string, status: RuntimeSessionStatus = "idle", parentSessionId = parentId, path = `/root/${name}`): SessionId {
  const sessionId = `session_${name}` as SessionId;
  applyRuntimeEvent(view, parseChiliEvent({
    id: `created_${name}`, type: "session.created", time: 1, sessionId,
    payload: { sessionId, cwd: "/repo", agent: { parentSessionId, name, path, policy: { deniedTools: ["bash"] } } },
  }));
  applyRuntimeEvent(view, parseChiliEvent({
    id: `status_${name}`, type: "session.status_changed", time: 2, sessionId,
    payload: { sessionId, status },
  }));
  return sessionId;
}

test("agents view derives descendant identities and active counts from Session events", () => {
  const view = createRuntimeView();
  const readerId = addAgent(view, "reader", "running");
  addAgent(view, "reviewer", "waiting_for_approval");
  addAgent(view, "stopping", "cancelling");
  addAgent(view, "idle");
  addAgent(view, "failed", "failed");
  const archivedId = addAgent(view, "archived", "running");
  addAgent(view, "external", "running", "session_other" as SessionId);
  addAgent(view, "nested", "running", readerId, "/root/reader/nested");
  applyRuntimeEvent(view, parseChiliEvent({
    id: "archive_child", type: "session.archived", time: 3, sessionId: archivedId,
    payload: { sessionId: archivedId },
  }));

  const model = agentsViewModel({
    runtimeView: view,
    sessionId: parentId,
    parentExecution: "idle",
    capabilitySupported: true,
    delegationConfig: { sessionId: parentId, policy: "explicit", source: "session" },
  });
  expect(model).toMatchObject({
    parentExecution: "idle",
    capability: "available",
    delegation: "on request (source session)",
    summary: "4 active, 6 total",
    activeAgents: 4,
  });
  expect(model.agents).toEqual([
    { id: "session_failed", name: "failed", path: "/root/failed", status: "idle" },
    { id: "session_idle", name: "idle", path: "/root/idle", status: "idle" },
    { id: readerId, name: "reader", path: "/root/reader", status: "running" },
    { id: "session_nested", name: "nested", path: "/root/reader/nested", status: "running" },
    { id: "session_reviewer", name: "reviewer", path: "/root/reviewer", status: "running" },
    { id: "session_stopping", name: "stopping", path: "/root/stopping", status: "running" },
  ]);
});

test("paused inputs retain the same Agent identity without an active count", () => {
  const view = createRuntimeView();
  const sessionId = addAgent(view, "reader", "running");
  applyRuntimeEvent(view, parseChiliEvent({
    id: "queue_paused", type: "session.input_queue_changed", time: 3, sessionId,
    payload: { sessionId, paused: true, revision: 1, pendingCount: 0, interruptedCount: 0, items: [] },
  }));
  const model = agentsViewModel({ runtimeView: view, sessionId: parentId });
  expect(model.summary).toBe("0 active, 1 total");
  expect(model.agents).toEqual([{ id: sessionId, name: "reader", path: "/root/reader", status: "paused" }]);
});

test("agents view has a simple empty model and explicit capability fallback", () => {
  expect(agentsViewModel({ runtimeView: createRuntimeView(), capabilitySupported: false })).toEqual({
    parentExecution: "unknown",
    capability: "unavailable for the selected model",
    delegation: "not configured",
    summary: "0 active, 0 total",
    activeAgents: 0,
    agents: [],
  });
  expect(delegationPolicyText({ sessionId: parentId, policy: "proactive", source: "default" })).toBe("proactive (source default)");
  expect(delegationPolicyText({ sessionId: parentId, policy: "explicit", source: "default" })).toBe("on request (source default)");
});
