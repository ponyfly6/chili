import { expect, test } from "bun:test";
import type { ChatSessionView, TeamLiveView } from "@chili/sdk";
import type { AgentsViewModel } from "./AgentsView.js";
import { statusFooterStatusText } from "./StatusFooter.js";

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
