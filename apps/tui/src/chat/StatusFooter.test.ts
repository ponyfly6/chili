import { expect, test } from "bun:test";
import { applyRuntimeEvent, chatSessionView, createRuntimeView } from "@chili/sdk";
import { parseChiliEvent, type SessionId } from "@chili/protocol";
import { agentsViewModel } from "./AgentsView.js";
import { statusFooterStatusText, statusFooterWorkspaceText } from "./StatusFooter.js";

const sessionId = "session_main" as SessionId;

function projectedChat() {
  const view = createRuntimeView();
  applyRuntimeEvent(view, parseChiliEvent({
    id: "created_main", type: "session.created", time: 1, sessionId,
    payload: { sessionId, cwd: "/repo" },
  }));
  return { view, chat: chatSessionView(view, { sessionId, generatedAt: "now" }) };
}

test("status footer counts active Agent sessions independently from parent execution", () => {
  const { view, chat } = projectedChat();
  for (const name of ["reader", "reviewer"]) {
    const childId = `session_${name}`;
    applyRuntimeEvent(view, parseChiliEvent({
      id: `created_${name}`, type: "session.created", time: 2, sessionId: childId,
      payload: { sessionId: childId, cwd: "/repo", agent: { parentSessionId: sessionId, name, path: `/root/${name}`, policy: {} } },
    }));
    applyRuntimeEvent(view, parseChiliEvent({
      id: `status_${name}`, type: "session.status_changed", time: 3, sessionId: childId,
      payload: { sessionId: childId, status: "running" },
    }));
  }
  const agents = agentsViewModel({ runtimeView: view, sessionId });
  expect(statusFooterStatusText(chat, true, agents)).toBe("2 agents");
  expect(statusFooterStatusText({ ...chat, status: "running" }, true, agents)).toBe("running · 2 agents");
  expect(statusFooterStatusText(chat, true, { ...agents, activeAgents: 1 })).toBe("1 agent");
  expect(statusFooterStatusText(chat, true, { ...agents, activeAgents: 0 })).toBeUndefined();
});

test.each([
  ["failed", "failed"],
  ["cancelled", "cancelled"],
  ["cancelling", "cancelling"],
  ["waiting_for_approval", "approval"],
  ["running", "running"],
] as const)("footer retains the parent %s state", (status, expected) => {
  const { chat } = projectedChat();
  expect(statusFooterStatusText({ ...chat, status }, true, undefined)).toBe(expected);
});

test("footer uses the persisted workspace and hides an unproven local branch", () => {
  const { chat } = projectedChat();
  const options = { cwd: "/local/checkout", gitBranch: "local-only", modeName: "Build", modelName: "test-model", providerName: "test-provider" };
  expect(statusFooterWorkspaceText({ ...chat, cwd: "/server/persisted-workspace" }, options)).toBe("persisted-workspace");
  expect(statusFooterWorkspaceText({ ...chat, cwd: "/local/checkout" }, options)).toBe("checkout (local-only)");
  expect(statusFooterStatusText({ ...chat, status: "idle" }, false, undefined)).toBe("waiting");
});
