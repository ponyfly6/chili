import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { TeamLiveAction, TeamLiveView } from "@chili/sdk";
import type { ApprovalId, TaskId } from "@chili/protocol";
import { ChatShellSurface } from "./ChatShellApp.js";
import { TeamLiveSurface } from "./TeamLiveApp.js";
import type { TeamLiveSurfaceRuntime } from "./components/types.js";
import { teamLiveFixture } from "./test-fixtures.js";

test("slash team opens cockpit and Escape returns to chat shell", async () => {
  const app = await mountShell(teamLiveFixture());

  try {
    await typeText(app, "/team");
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("Chili Team Live");

    await press(app, () => app.mockInput.pressEscape());
    expect(app.captureCharFrame()).toContain("Ask anything");
    expect(app.captureCharFrame()).not.toContain("Chili Team Live");
  } finally {
    app.renderer.destroy();
  }
});

test("Ctrl+P opens the command palette", async () => {
  const app = await mountShell(teamLiveFixture());

  try {
    await press(app, () => app.mockInput.pressKey("p", { ctrl: true }));
    expect(app.captureCharFrame()).toContain("Command Palette");
    expect(app.captureCharFrame()).toContain("/team");
  } finally {
    app.renderer.destroy();
  }
});

test("slash completion includes team command", async () => {
  const app = await mountShell(teamLiveFixture());

  try {
    await typeText(app, "/");
    expect(app.captureCharFrame()).toContain("Commands");
    expect(app.captureCharFrame()).toContain("/team");
  } finally {
    app.renderer.destroy();
  }
});

test("team run slash command executes SDK run-loop action", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountShell(withRunLoopReady(teamLiveFixture()), { executed });

  try {
    await typeText(app, "/team run");
    await press(app, () => app.mockInput.pressEnter());
    expect(executed[0]).toMatchObject({ type: "run_loop", enabled: true });
  } finally {
    app.renderer.destroy();
  }
});

test("team merge slash command executes SDK merge action", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountShell(teamLiveFixture(), { executed });

  try {
    await typeText(app, "/team merge");
    await press(app, () => app.mockInput.pressEnter());
    expect(executed[0]).toMatchObject({ type: "merge", enabled: true, taskId: "task_live" });
  } finally {
    app.renderer.destroy();
  }
});

test("keyboard changes focus with Tab and Shift+Tab", async () => {
  const app = await mountSurface(teamLiveFixture());

  try {
    expect(app.captureCharFrame()).toContain("[teams]");

    await press(app, () => app.mockInput.pressTab());
    expect(app.captureCharFrame()).toContain("[runs]");

    await press(app, () => app.mockInput.pressTab({ shift: true }));
    expect(app.captureCharFrame()).toContain("[teams]");
  } finally {
    app.renderer.destroy();
  }
});

test("keyboard opens detail and Esc closes it", async () => {
  const app = await mountSurface(teamLiveFixture(), { width: 80, height: 24 });

  try {
    await press(app, () => app.mockInput.pressEnter());
    expect(app.captureCharFrame()).toContain("Detail");
    expect(app.captureCharFrame()).toContain("lead:/root");

    await press(app, () => app.mockInput.pressEscape());
    expect(app.captureCharFrame()).toContain("Teams");
    expect(app.captureCharFrame()).not.toContain("lead:/root");
  } finally {
    app.renderer.destroy();
  }
});

test("keyboard opens and closes help", async () => {
  const app = await mountSurface(teamLiveFixture());

  try {
    await press(app, () => app.mockInput.pressKey("?"));
    expect(app.captureCharFrame()).toContain("Team Live Help");

    await press(app, () => app.mockInput.pressEscape());
    expect(app.captureCharFrame()).not.toContain("Team Live Help");
  } finally {
    app.renderer.destroy();
  }
});

test("approve action asks for confirmation before SDK action", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountSurface(teamLiveFixture(), { executed });

  try {
    await press(app, () => app.mockInput.pressKey("a"));
    expect(app.captureCharFrame()).toContain("Approve pending permission?");
    expect(executed).toHaveLength(0);

    await press(app, () => app.mockInput.pressEnter());
    expect(executed[0]?.type).toBe("approve");
  } finally {
    app.renderer.destroy();
  }
});

test("reject action asks for confirmation before SDK action", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountSurface(teamLiveFixture(), { executed });

  try {
    await press(app, () => app.mockInput.pressKey("x"));
    expect(app.captureCharFrame()).toContain("Reject pending permission?");
    expect(executed).toHaveLength(0);

    await press(app, () => app.mockInput.pressEnter());
    expect(executed[0]?.type).toBe("reject");
  } finally {
    app.renderer.destroy();
  }
});

test("merge action asks for confirmation before SDK action and Esc cancels", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountSurface(teamLiveFixture(), { executed });

  try {
    await press(app, () => app.mockInput.pressKey("m"));
    expect(app.captureCharFrame()).toContain("Merge task worktree?");
    await press(app, () => app.mockInput.pressEscape());
    expect(executed).toHaveLength(0);
    expect(app.captureCharFrame()).not.toContain("Merge task worktree?");

    await press(app, () => app.mockInput.pressKey("m"));
    await press(app, () => app.mockInput.pressEnter());
    expect(executed[0]?.type).toBe("merge");
  } finally {
    app.renderer.destroy();
  }
});

test("merge hotkey stays bound to the selected task", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountSurface(withMergeActionOnSecondTask(), { executed });

  try {
    await press(app, () => app.mockInput.pressKey("m"));
    expect(app.captureCharFrame()).not.toContain("Merge task worktree?");
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      type: "merge",
      taskId: "task_without_merge",
      enabled: false,
      reason: "no_selected_merge",
    });
  } finally {
    app.renderer.destroy();
  }
});

test("approval hotkey stays bound to the selected approval", async () => {
  const executed: TeamLiveAction[] = [];
  const app = await mountSurface(withApprovalActionOnSecondApproval(), { executed });

  try {
    await press(app, () => app.mockInput.pressKey("a"));
    expect(app.captureCharFrame()).not.toContain("Approve pending permission?");
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      type: "approve",
      approvalId: "approval_without_action",
      enabled: false,
      reason: "action_unavailable",
    });
  } finally {
    app.renderer.destroy();
  }
});

test("keyboard keeps task selection visible past the first window", async () => {
  const app = await mountSurface(withManyTasks(teamLiveFixture()), { width: 120, height: 40 });

  try {
    await press(app, () => app.mockInput.pressTab());
    await press(app, () => app.mockInput.pressTab());
    await press(app, () => app.mockInput.pressTab());
    for (let index = 0; index < 15; index += 1) {
      await press(app, () => app.mockInput.pressArrow("down"));
    }

    const frame = app.captureCharFrame();
    expect(frame).toContain("[Task Board 5-16/16]");
    expect(frame).toContain("Task row 16");
  } finally {
    app.renderer.destroy();
  }
});

async function mountSurface(
  model: TeamLiveView,
  options: {
    width?: number;
    height?: number;
    executed?: TeamLiveAction[];
  } = {},
) {
  const runtime: TeamLiveSurfaceRuntime = {
    message: "test stream",
    reconnect: () => undefined,
    executeAction: (action) => {
      options.executed?.push(action);
    },
    clearActionFeedback: () => undefined,
  };

  const app = await testRender(
    <TeamLiveSurface
      model={model}
      runtime={runtime}
      selectedTeamId={model.selectedTeamId}
      selectedTeamLocked={false}
      onSelectTeam={() => undefined}
      onExit={() => undefined}
    />,
    { width: options.width ?? 120, height: options.height ?? 40, exitOnCtrlC: false },
  );
  await act(async () => {
    await app.renderOnce();
  });
  return app;
}

async function mountShell(
  model: TeamLiveView,
  options: {
    width?: number;
    height?: number;
    executed?: TeamLiveAction[];
  } = {},
) {
  const runtime: TeamLiveSurfaceRuntime = {
    message: "test stream",
    reconnect: () => undefined,
    executeAction: (action) => {
      options.executed?.push(action);
    },
    clearActionFeedback: () => undefined,
  };

  const app = await testRender(
    <ChatShellSurface
      model={model}
      runtime={runtime}
      selectedTeamId={model.selectedTeamId}
      selectedTeamLocked={false}
      onSelectTeam={() => undefined}
      onExit={() => undefined}
      options={{ cwd: "/repo/chili", modeName: "Build", modelName: "test-model", providerName: "test-provider" }}
    />,
    { width: options.width ?? 120, height: options.height ?? 40, exitOnCtrlC: false },
  );
  await act(async () => {
    await app.renderOnce();
  });
  return app;
}

async function press(app: Awaited<ReturnType<typeof mountSurface>> | Awaited<ReturnType<typeof mountShell>>, input: () => void): Promise<void> {
  act(() => {
    input();
  });
  await Bun.sleep(60);
  await app.renderOnce();
}

async function typeText(app: Awaited<ReturnType<typeof mountShell>>, text: string): Promise<void> {
  await act(async () => {
    await app.mockInput.typeText(text);
  });
  await Bun.sleep(60);
  await app.renderOnce();
}

function withRunLoopReady(view: TeamLiveView): TeamLiveView {
  const selected = requireSelected(view);
  const teamId = requireTeamId(view);
  const actions: TeamLiveAction[] = [
    { type: "run_loop", teamId, enabled: true },
    ...selected.availableActions.filter((action) => action.type !== "run_loop"),
  ];
  return {
    ...view,
    availableActions: actions,
    selected: {
      ...selected,
      availableActions: actions,
    },
  };
}

function withMergeActionOnSecondTask(): TeamLiveView {
  const view = teamLiveFixture();
  const selected = requireSelected(view);
  const baseTask = requireFirst(selected.tasks);
  const teamId = requireTeamId(view);
  const firstTaskId = "task_without_merge" as TaskId;
  const secondTaskId = "task_with_merge" as TaskId;
  const { merge: _merge, ...taskWithoutMerge } = baseTask;
  const firstTask = {
    ...taskWithoutMerge,
    id: firstTaskId,
    title: "Selected task without merge",
    metadata: withoutMergeMetadata(baseTask.metadata),
  };
  const secondTask = {
    ...baseTask,
    id: secondTaskId,
    title: "Second task with merge",
    merge: { ...requireFirst(selected.mergeQueue), taskId: secondTaskId, title: "Second task with merge" },
  };
  const actions: TeamLiveAction[] = [
    { type: "merge", teamId, taskId: secondTaskId, enabled: true },
  ];

  return {
    ...view,
    availableActions: actions,
    selected: {
      ...selected,
      tasks: [firstTask, secondTask],
      mergeQueue: [secondTask.merge],
      availableActions: actions,
    },
  };
}

function withApprovalActionOnSecondApproval(): TeamLiveView {
  const view = teamLiveFixture();
  const selected = requireSelected(view);
  const baseApproval = requireFirst(selected.pendingApprovals);
  const sessionId = baseApproval.sessionId;
  if (!sessionId) throw new Error("fixture requires approval session");
  const firstApprovalId = "approval_without_action" as ApprovalId;
  const secondApprovalId = "approval_with_action" as ApprovalId;
  const firstApproval = { ...baseApproval, id: firstApprovalId, toolName: "first-edit" };
  const secondApproval = { ...baseApproval, id: secondApprovalId, toolName: "second-edit" };
  const actions: TeamLiveAction[] = [
    { type: "approve", approvalId: secondApprovalId, sessionId, enabled: true },
    { type: "reject", approvalId: secondApprovalId, sessionId, enabled: true },
  ];

  return {
    ...view,
    availableActions: actions,
    selected: {
      ...selected,
      pendingApprovals: [firstApproval, secondApproval],
      availableActions: actions,
    },
  };
}

function withManyTasks(view: TeamLiveView): TeamLiveView {
  const selected = requireSelected(view);
  const baseTask = requireFirst(selected.tasks);
  return {
    ...view,
    selected: {
      ...selected,
      tasks: Array.from({ length: 16 }, (_, index) => ({
        ...baseTask,
        id: `task_window_${index + 1}` as TaskId,
        title: `Task row ${String(index + 1).padStart(2, "0")}`,
      })),
    },
  };
}

function withoutMergeMetadata(metadata: NonNullable<TeamLiveView["selected"]>["tasks"][number]["metadata"]) {
  const { merge: _metadataMerge, ...rest } = metadata;
  return rest;
}

function requireSelected(view: TeamLiveView): NonNullable<TeamLiveView["selected"]> {
  if (!view.selected) throw new Error("fixture requires selected team");
  return view.selected;
}

function requireTeamId(view: TeamLiveView): NonNullable<TeamLiveView["selectedTeamId"]> {
  if (!view.selectedTeamId) throw new Error("fixture requires selected team id");
  return view.selectedTeamId;
}

function requireFirst<T>(items: readonly T[]): T {
  const first = items[0];
  if (!first) throw new Error("fixture requires at least one item");
  return first;
}
