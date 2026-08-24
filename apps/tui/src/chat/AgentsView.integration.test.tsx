import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type {
  AgentPath,
  AgentRunId,
  SessionId,
  TaskId,
} from "@chili/protocol";
import {
  createRuntimeView,
  type RuntimeDelegatedAgent,
  type RuntimeDelegationStatusView,
} from "@chili/sdk";
import { resolveTuiTheme } from "../theme/index.js";
import { AgentsView, agentsViewModel } from "./AgentsView.js";

const theme = resolveTuiTheme("chili-dark", {});

test("the Agents view renders ad-hoc outcomes while the parent is idle and teams are absent", async () => {
  const sessionId = "session_agents_view" as SessionId;
  const items: RuntimeDelegatedAgent[] = [
    delegatedAgent(5, "failed", { error: "provider quota 2062" }),
    delegatedAgent(4, "incomplete", { summary: "needs repository evidence" }),
    delegatedAgent(3, "completed", { summary: "workbench mapped" }),
    delegatedAgent(2, "completed", { summary: "shell mapped" }),
    delegatedAgent(1, "completed", { summary: "routes mapped" }),
  ];
  const status: RuntimeDelegationStatusView = {
    delegation: {
      supported: true,
      observed: true,
      policy: "explicit",
      source: "session",
    },
    parent: {
      sessionId,
      status: "idle",
      active: false,
    },
    agents: {
      counts: {
        total: 5,
        pending: 0,
        running: 0,
        active: 0,
        completed: 3,
        incomplete: 1,
        failed: 1,
        cancelled: 0,
      },
      items,
      active: [],
      errors: [
        {
          taskId: "task_5" as TaskId,
          runId: "agent_5" as AgentRunId,
          path: "/root/task_5" as AgentPath,
          status: "failed",
          message: "provider quota 2062",
          updatedAt: 50,
        },
        {
          taskId: "task_4" as TaskId,
          runId: "agent_4" as AgentRunId,
          path: "/root/task_4" as AgentPath,
          status: "incomplete",
          message: "needs repository evidence",
          updatedAt: 40,
        },
      ],
    },
    team: { count: 0, activeCount: 0 },
    generatedAt: "2026-08-19T00:00:00.000Z",
  };

  const model = agentsViewModel({
    runtimeView: createRuntimeView(),
    status,
    sessionId,
    capabilitySupported: true,
  });

  expect(model).toMatchObject({
    parentExecution: "idle",
    capability: "available (used this session)",
    delegation: "on request (explicit; source session)",
    adHocSummary: "0 active, 5 total; 3 completed, 1 incomplete, 1 failed",
    persistentTeamSummary: "none",
    activeAdHocAgents: 0,
    teams: [],
  });
  expect(model.adHocAgents).toHaveLength(5);
  expect(model.adHocAgents[0]).toMatchObject({
    id: "task_5",
    status: "failed",
    detail: "provider quota 2062",
    error: true,
  });
  expect(model.adHocAgents[1]).toMatchObject({
    id: "task_4",
    status: "incomplete",
    detail: "needs repository evidence",
    error: true,
  });

  const app = await testRender(
    <AgentsView model={model} theme={theme} />,
    { width: 160, height: 30, exitOnCtrlC: false },
  );
  try {
    await act(async () => {
      await app.renderOnce();
    });
    const frame = app.captureCharFrame();
    expect(frame).toContain("Capability available (used this session) · delegation on request (explicit; source session) · parent idle");
    expect(frame).toContain("Ad-hoc agents — 0 active, 5 total; 3 completed, 1 incomplete, 1 failed");
    expect(frame).toContain("slice 5 · /root/task_5 · failed");
    expect(frame).toContain("provider quota 2062");
    expect(frame).toContain("slice 4 · /root/task_4 · incomplete");
    expect(frame).toContain("needs repository evidence");
    expect(frame).toContain("Persistent teams — none");
    expect(frame).not.toContain("No ad-hoc agents have been spawned");
  } finally {
    app.renderer.destroy();
  }
});

function delegatedAgent(
  index: number,
  status: RuntimeDelegatedAgent["status"],
  outcome: { summary?: string; error?: string },
): RuntimeDelegatedAgent {
  return {
    taskId: `task_${index}` as TaskId,
    runId: `agent_${index}` as AgentRunId,
    path: `/root/task_${index}` as AgentPath,
    taskName: `slice ${index}`,
    status,
    mode: "background",
    childSessionId: `session_child_${index}` as SessionId,
    ...(outcome.summary ? { summary: outcome.summary } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    updatedAt: index * 10,
    completedAt: index * 10,
  };
}
