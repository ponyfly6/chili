import { expect, test } from "bun:test";
import type { ChatSessionView, TeamLiveView } from "@chili/sdk";
import type { AgentsViewModel } from "./AgentsView.js";
import { statusFooterStatusText, statusFooterWorkspaceText } from "./StatusFooter.js";

test("status footer surfaces live ad-hoc agents independently from parent execution", () => {
  const chatView = { status: "idle" } as ChatSessionView;
  const teamModel = {} as TeamLiveView;
  const agents: AgentsViewModel = {
    parentExecution: "idle",
    capability: "available",
    delegation: "proactive (source session)",
    adHocSummary: "2 active, 4 total; 2 completed",
    persistentTeamSummary: "none",
    activeAdHocAgents: 2,
    adHocAgents: [],
    teams: [],
  };

  expect(statusFooterStatusText(chatView, true, teamModel, agents)).toBe("2 ad-hoc agents");
});

test("footer uses the persisted workspace and hides an unproven local branch", () => {
  const chatView = {
    status: "idle",
    items: [],
    pendingApprovals: [],
    activeTools: [],
    generatedAt: "now",
  } as ChatSessionView;
  const options = {
    cwd: "/local/checkout",
    gitBranch: "local-only",
    modeName: "Build",
    modelName: "test-model",
    providerName: "test-provider",
  };

  expect(statusFooterWorkspaceText({ ...chatView, cwd: "/server/persisted-workspace" }, options))
    .toBe("persisted-workspace");
  expect(statusFooterWorkspaceText({ ...chatView, cwd: "/local/checkout" }, options))
    .toBe("checkout (local-only)");
});
