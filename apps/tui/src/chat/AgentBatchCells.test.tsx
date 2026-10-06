import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { resolveTuiTheme } from "../theme/index.js";
import {
  AgentBatchCell,
  agentBatchCellLines,
  type InlineAgentBatchDisplay,
  type InlineAgentStatus,
} from "./AgentBatchCells.js";
import { buildChatDisplayItems } from "./presentation.js";
import { inlineAgentBatchDisplays, inlineTeamBatchDisplays } from "./inline-agent-batches.js";
import { inlineAgentBatchesForSession } from "./inline-agent-batches.js";
import { teamLiveFixture } from "../test-fixtures.js";
import {
  chatAgentBatches,
  chatSessionView,
  createRuntimeView,
  reduceRuntimeEvents,
  type ChatSessionView,
  type ChatTranscriptItem,
} from "@chili/sdk";
import type {
  AgentPath,
  AgentRunId,
  ChiliEvent,
  MessageId,
  PartId,
  SessionId,
  TaskId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import { MessageList } from "./MessageList.js";
import { messageListLineCount } from "./MessageList.js";
import { charDisplayWidth } from "./markdown.js";

const theme = resolveTuiTheme("chili-dark", {});

test("completed agent batch stays visible with every task result in compact mode", async () => {
  const batch = batchFixture([
    agent("routes", "Map routes", "completed", "Found four route groups."),
    agent("shell", "Map shell", "completed", "Shell owns navigation state."),
    agent("workbench", "Map workbench", "completed", "Workbench renders the task surface."),
  ], { integration: "ready" });

  const text = agentBatchCellLines(batch, 120, false, theme).map((line) => line.text).join("\n");
  expect(text).toContain("3/3 agents completed");
  expect(text).toContain("3 completed");
  expect(text).toContain("routes · completed · result: Found four route groups.");
  expect(text).toContain("result: Found four route groups.");
  expect(text).toContain("shell · completed · result: Shell owns navigation state.");
  expect(text).toContain("workbench · completed · result: Workbench renders the task surface.");
  expect(text).toContain("Results: 3 available · awaiting parent · Ctrl+O");
  expect(text).toContain("interaction: 0 follow-ups · 3 one-shot results");
  expect(text).toContain("Ctrl+O");
  expect(text).not.toContain("output hidden");

  const app = await testRender(
    <box width={120} height={16} flexDirection="column">
      <AgentBatchCell batch={batch} width={120} expanded={false} theme={theme} />
    </box>,
    { width: 120, height: 16, exitOnCtrlC: false },
  );
  try {
    await act(async () => {
      await app.renderOnce();
    });
    const frame = app.captureCharFrame();
    expect(frame).toContain("3/3 agents completed");
    expect(frame).toContain("Found four route groups");
    expect(frame).toContain("awaiting parent");
  } finally {
    app.renderer.destroy();
  }
});

test("running and failed agents expose lifecycle, errors, and parent messages", () => {
  const batch = batchFixture([
    agent("runner", "Run tests", "running", undefined, "tool: bash (running)"),
    agent("reviewer", "Review API", "incomplete", "Needs provider evidence"),
  ], { expected: 3, integration: "pending" });
  batch.agents[0]!.turns = 2;
  batch.agents[0]!.followupCount = 1;
  batch.messages.push({
    id: "message_parent",
    from: "/root",
    to: "/root/runner",
    text: "Please verify the failing test.",
    status: "consumed",
    time: 8,
    direction: "parent_to_agent",
  });

  const compact = agentBatchCellLines(batch, 110, false, theme).map((line) => line.text).join("\n");
  expect(compact).toContain("1/3 agents finished");
  expect(compact).toContain("1 running");
  expect(compact).toContain("1 incomplete");
  expect(compact).toContain("now: tool: bash (running)");
  expect(compact).toContain("runner · running · 2 turns, 1 follow-up · now: tool: bash (running)");
  expect(compact).toContain("error: Needs provider evidence");
  expect(compact).toContain("interaction: 1 follow-up · 1 one-shot result · 1 parent→agent · 0 agent→parent · 0 agent↔agent");

  const expanded = agentBatchCellLines(batch, 110, true, theme).map((line) => line.text).join("\n");
  expect(expanded).toContain("root → runner · consumed: Please verify the failing test.");
});

test("large batches preview six results and advertise the remaining agents", () => {
  const agents = Array.from({ length: 10 }, (_, index) => agent(
    `agent-${index + 1}`,
    `Inspect slice ${index + 1}`,
    "completed",
    `Result ${index + 1}`,
  ));
  const batch = batchFixture(agents, { integration: "responded" });
  batch.requestedMaxConcurrency = 10;
  batch.observedPeakConcurrency = 3;
  const compact = agentBatchCellLines(batch, 120, false, theme).map((line) => line.text).join("\n");
  expect(compact).toContain("10/10 agents completed");
  expect(compact).toContain("peak 3 concurrent (requested 10)");
  expect(compact).toContain("agent-1 · completed · result: Result 1");
  expect(compact).toContain("agent-6 · completed · result: Result 6");
  expect(compact).not.toContain("agent-7 · completed");
  expect(compact).toContain("… 4 more agents · Ctrl+O expands all");
  expect(compact).toContain("parent responded after results");

  const expanded = agentBatchCellLines(batch, 120, true, theme).map((line) => line.text).join("\n");
  expect(expanded).toContain("agent-10 · completed · Inspect slice 10");
});

test("compact batches prioritize running, terminal problems, and queued work over old completions", () => {
  const agents = [
    ...Array.from({ length: 6 }, (_, index) => agent(`done-${index + 1}`, `Completed ${index + 1}`, "completed", `Done ${index + 1}`)),
    ...Array.from({ length: 3 }, (_, index) => agent(`live-${index + 7}`, `Running ${index + 7}`, "running", undefined, "working")),
    agent("queued-10", "Queued 10", "pending"),
  ];
  const batch = batchFixture(agents, { expected: 10, integration: "pending" });
  const compact = agentBatchCellLines(batch, 120, false, theme).map((line) => line.text).join("\n");

  expect(compact).toContain("live-7 · running");
  expect(compact).toContain("live-8 · running");
  expect(compact).toContain("live-9 · running");
  expect(compact).toContain("queued-10 · pending");
  expect(compact).toContain("done-1 · completed");
  expect(compact).toContain("done-2 · completed");
  expect(compact).not.toContain("done-3 · completed");
  expect(compact).toContain("… 4 more agents");
});

test("compact ten-agent cards stay within a ten-line budget at common terminal widths", () => {
  const agents = Array.from({ length: 10 }, (_, index) => agent(
    `agent-${index + 1}`,
    `Inspect the unusually long subsystem slice ${index + 1} and collect implementation evidence`,
    "completed",
    `Result ${index + 1}: verified a deliberately long summary that must stay on one compact visual line.`,
  ));
  const batch = batchFixture(agents, { integration: "responded" });
  batch.requestedMaxConcurrency = 10;
  batch.observedPeakConcurrency = 3;

  for (const width of [120, 80, 50]) {
    const lines = agentBatchCellLines(batch, width, false, theme);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.every((line) => charDisplayWidth(line.text) <= width)).toBe(true);
    expect(lines.map((line) => line.text).join("\n")).toContain("10/10 agents completed");
  }

  const wide = agentBatchCellLines(batch, 120, false, theme).map((line) => line.text).join("\n");
  expect(wide).toContain("… 4 more agents · Ctrl+O expands all");
  const medium = agentBatchCellLines(batch, 80, false, theme).map((line) => line.text).join("\n");
  expect(medium).toContain("… 5 more agents · Ctrl+O expands all");
  const expanded = agentBatchCellLines(batch, 50, true, theme).map((line) => line.text).join("\n");
  expect(expanded.replace(/\s+/g, "")).toContain("Inspecttheunusuallylongsubsystem");
  expect(expanded.replace(/\s+/g, "")).toContain("deliberatelylongsummary");
  expect(agentBatchCellLines(batch, 50, true, theme).length).toBeGreaterThan(agentBatchCellLines(batch, 50, false, theme).length);
});

test("followed-up terminal agents are not also counted as one-shot results", () => {
  const batch = batchFixture([
    agent("one-shot", "Inspect once", "completed", "Done once"),
    agent("iterated", "Inspect twice", "completed", "Done after follow-up"),
  ]);
  batch.agents[1]!.turns = 2;
  batch.agents[1]!.followupCount = 1;
  const text = agentBatchCellLines(batch, 100, false, theme).map((line) => line.text).join("\n");
  expect(text).toContain("interaction: 1 follow-up · 1 one-shot result");
  expect(text).not.toContain("2 one-shot results");
});

test("expanded batches render a shared completion message only once", () => {
  const sharedMessage = {
    id: "message_shared_completion",
    from: "/root/worker",
    to: "/root",
    text: "Shared completion evidence",
    status: "consumed",
    time: 9,
    direction: "agent_to_parent" as const,
  };
  const batch = batchFixture([
    agent("first", "First", "completed", "First done"),
    agent("second", "Second", "completed", "Second done"),
  ]);
  batch.agents[0]!.messages = [sharedMessage];
  batch.agents[1]!.messages = [sharedMessage];
  batch.messages = [sharedMessage];

  const expanded = agentBatchCellLines(batch, 100, true, theme).map((line) => line.text).join("\n");
  expect(expanded.split("Shared completion evidence")).toHaveLength(2);
});

test.each(["task_batch", "agent_spawn"])("%s tool cell is replaced by lifecycle card instead of hidden JSON output", (toolName) => {
  const callId = "call_agents" as ToolCallId;
  const item: ChatTranscriptItem = {
    id: callId,
    kind: "tool",
    toolName,
    status: "completed",
    displayStatus: "succeeded",
    waitingForApproval: false,
    updatedAt: 20,
    inputSummary: { title: toolName },
    input: { tasks: [{ description: "Map routes", prompt: "Inspect routes" }] },
    output: JSON.stringify({ tasks: [{ status: "completed", summary: "Found routes" }] }),
  };
  const batch = batchFixture([agent("routes", "Map routes", "completed", "Found routes")], { callId });
  const display = buildChatDisplayItems([item], { agentBatches: [batch] });

  expect(display).toHaveLength(1);
  expect(display[0]).toMatchObject({ kind: "agent_batch", batch: { callId, status: "completed" } });
});

test("terminal cards whose source call aged out stay out of a long resumed transcript", () => {
  const callId = "call_aged_out_agents" as ToolCallId;
  const history = Array.from({ length: 130 }, (_, index): ChatTranscriptItem => ({
    id: `message_history_${index}` as MessageId,
    kind: "message",
    role: "user",
    createdAt: 100 + index,
    parts: [{ type: "text", id: `part_history_${index}` as PartId, text: `history ${index}` }],
  }));
  const terminal = batchFixture([agent("old", "Old task", "completed", "Old result")], { callId, integration: "responded" });
  terminal.createdAt = 1;
  const active = batchFixture([agent("live", "Live task", "running", undefined, "working")], { callId, integration: "pending" });
  active.createdAt = 2;

  expect(buildChatDisplayItems(history, { agentBatches: [terminal] }).some((item) => item.kind === "agent_batch")).toBe(false);
  expect(buildChatDisplayItems(history, { agentBatches: [active] }).some((item) => item.kind === "agent_batch")).toBe(true);
});

test("spawn failures count as terminal outcomes and expose their error", () => {
  const batch = batchFixture([], { expected: 2, integration: "not_required" });
  batch.status = "failed";
  batch.spawnFailures = [
    { id: "spawn-0", name: "agent-1", task: "Inspect API", error: "provider quota" },
    { id: "spawn-1", name: "agent-2", task: "Inspect UI", error: "provider quota" },
  ];
  const text = agentBatchCellLines(batch, 100, false, theme).map((line) => line.text).join("\n");
  expect(text).toContain("2/2 agents failed");
  expect(text).toContain("2 failed");
  expect(text).toContain("agent-1 · failed · error: provider quota");
  expect(text).toContain("error: provider quota");
});

test("batch-level launch errors replace the misleading waiting-for-handles row", () => {
  const batch = batchFixture([], { expected: 10, integration: "not_required" });
  batch.status = "failed";
  batch.error = "launch rejected";
  const compact = agentBatchCellLines(batch, 80, false, theme).map((line) => line.text).join("\n");
  const expanded = agentBatchCellLines(batch, 80, true, theme).map((line) => line.text).join("\n");

  expect(compact).toContain("batch error: launch rejected");
  expect(expanded).toContain("batch error: launch rejected");
  expect(compact).toContain("10/10 agents failed to start");
  expect(compact).toContain("launch failed");
  expect(compact).not.toContain("10 planned");
  expect(compact).toContain("Results: launch failed");
  expect(expanded).toContain("Results: Launch failed");
  expect(compact).not.toContain("Results: pending");
  expect(compact).not.toContain("Waiting for agent handles");
  expect(expanded).not.toContain("Waiting for agent handles");
});

test("projected zero-spawn failures report failed-to-start instead of zero failed", () => {
  const sessionId = "session_zero_spawn" as SessionId;
  const callId = "call_zero_spawn" as ToolCallId;
  const view = reduceRuntimeEvents([
    {
      id: "event_zero_spawn_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_zero_spawn_start",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId,
      payload: {
        turnId: "turn_zero_spawn" as TurnId,
        callId,
        toolName: "task_batch",
        input: { tasks: [{}, {}, {}] },
      },
    },
    {
      id: "event_zero_spawn_failure",
      type: "tool.call_finished",
      time: 3 as TimestampMs,
      sessionId,
      payload: { callId, status: "failed", error: "launch rejected" },
    },
  ], createRuntimeView());
  const projected = chatAgentBatches(view, { sessionId });
  const [batch] = inlineAgentBatchDisplays(projected);
  if (!batch) throw new Error("expected zero-spawn batch");

  const text = agentBatchCellLines(batch, 100, false, theme).map((line) => line.text).join("\n");
  expect(text).toContain("3/3 agents failed to start");
  expect(text).toContain("batch error: launch rejected");
  expect(text).not.toContain("0/3 agents failed");
  expect(text).not.toContain("3 planned");
});

test("a new home without a current session does not inherit historical agent or team cards", () => {
  const sessionId = "session_historical_agents" as SessionId;
  const turnId = "turn_historical_agents" as TurnId;
  const callId = "call_historical_agents" as ToolCallId;
  const runtimeView = reduceRuntimeEvents(realTenAgentEvents({ sessionId, turnId, callId }), createRuntimeView());
  const teamView = teamLiveFixture();

  expect(inlineAgentBatchesForSession({ runtimeView, teamView })).toEqual([]);
  expect(inlineAgentBatchesForSession({ runtimeView, teamView, sessionId })).not.toHaveLength(0);
  expect(inlineTeamBatchDisplays(teamView, "session_after_resume")).toEqual([]);
});

test("MessageList renders the lifecycle card in the normal chat surface", async () => {
  const callId = "call_main_chat_agents" as ToolCallId;
  const tool: Extract<ChatTranscriptItem, { kind: "tool" }> = {
    id: callId,
    kind: "tool",
    toolName: "task_batch",
    status: "completed",
    displayStatus: "succeeded",
    waitingForApproval: false,
    updatedAt: 20,
    inputSummary: { title: "task_batch" },
    input: { tasks: Array.from({ length: 10 }, (_, index) => ({ description: `slice-${index + 1}` })) },
    output: JSON.stringify({ tasks: Array.from({ length: 10 }, (_, index) => ({ status: "completed", summary: `result-${index + 1}` })) }),
  };
  const batch = batchFixture(Array.from({ length: 10 }, (_, index) => (
    agent(`agent-${index + 1}`, `slice-${index + 1}`, "completed", `result-${index + 1}`)
  )), { callId, integration: "responded" });
  const chatView: ChatSessionView = {
    status: "idle",
    items: [tool],
    pendingApprovals: [],
    activeTools: [],
    generatedAt: "2026-08-19T00:00:00.000Z",
  };
  const app = await testRender(
    <box width={120} height={24} flexDirection="column">
      <MessageList chatView={chatView} localItems={[]} width={120} theme={theme} agentBatches={[batch]} />
    </box>,
    { width: 120, height: 24, exitOnCtrlC: false },
  );
  try {
    await act(async () => {
      await app.renderOnce();
    });
    const frame = app.captureCharFrame();
    expect(frame).toContain("10/10 agents completed");
    expect(frame).toContain("agent-1 · completed · result: result-1");
    expect(frame).toContain("… 4 more agents · Ctrl+O expands all");
    expect(frame).toContain("interaction: 0 follow-ups · 10 one-shot results");
    expect(frame).not.toContain("output hidden");
    expect(frame).not.toContain("Started 10 ad-hoc agents");
  } finally {
    app.renderer.destroy();
  }
});

test("persistent team lifecycle is visible in the main-chat card model", () => {
  const view = teamLiveFixture();
  if (!view.selected) throw new Error("fixture requires selected team");
  const workerPath = view.selected.members.find((member) => !member.isLead)?.path;
  if (!workerPath) throw new Error("fixture requires worker");
  view.selected.recentActivity.push({
    id: "team_message",
    kind: "message",
    time: 13,
    label: "lead sent worker follow-up",
    status: "consumed",
    teamId: view.selected.team.id,
  });
  view.selected.recentActivity.push(
    {
      id: "team_message_to_worker",
      kind: "message",
      time: 14,
      label: "lead follow-up",
      status: "consumed",
      teamId: view.selected.team.id,
      from: view.selected.team.leadPath,
      to: workerPath,
    },
    {
      id: "team_message_to_lead",
      kind: "mailbox",
      time: 15,
      label: "worker result",
      status: "consumed",
      teamId: view.selected.team.id,
      from: workerPath,
      to: view.selected.team.leadPath,
    },
  );
  const [batch] = inlineTeamBatchDisplays(view, view.scope.sessionId);
  expect(batch).toBeDefined();
  const text = agentBatchCellLines(batch!, 120, false, theme).map((line) => line.text).join("\n");
  expect(text).toContain("Team live · 0/1 tasks finished");
  expect(text).toContain("worker · running · now: worker: running");
  expect(text).toContain("1 parent→agent · 1 agent→parent · 0 agent↔agent · 1 related");
  expect(text).toContain("Team results");
  expect(text).not.toContain("no parent integration required");

  const expanded = agentBatchCellLines(batch!, 120, true, theme).map((line) => line.text).join("\n");
  expect(expanded).toContain("root → worker");
  expect(expanded).toContain("worker → root");
});

test("team message delivery mirrors count and render as one interaction", () => {
  const view = teamLiveFixture();
  if (!view.selected) throw new Error("fixture requires selected team");
  const workerPath = view.selected.members.find((member) => !member.isLead)?.path;
  if (!workerPath) throw new Error("fixture requires worker");
  view.selected.recentActivity = [
    {
      id: "team_message_semantic",
      kind: "message",
      time: 20,
      label: "task_assignment",
      detail: "Inspect the renderer",
      status: "delivered",
      teamId: view.selected.team.id,
      teamMessageId: "team_message_semantic",
      from: view.selected.team.leadPath,
      to: workerPath,
    },
    {
      id: "mailbox_delivery_mirror",
      kind: "mailbox",
      time: 21,
      label: "mailbox root -> worker",
      status: "consumed",
      teamId: view.selected.team.id,
      teamMessageId: "team_message_semantic",
      from: view.selected.team.leadPath,
      to: workerPath,
    },
  ];

  const [batch] = inlineTeamBatchDisplays(view, view.scope.sessionId);
  if (!batch) throw new Error("expected team card");
  expect(batch.messages).toHaveLength(1);
  expect(batch.messages[0]).toMatchObject({ id: "team_message_semantic", direction: "parent_to_agent", status: "delivered" });

  const compact = agentBatchCellLines(batch, 120, false, theme).map((line) => line.text).join("\n");
  expect(compact).toContain("1 parent→agent");
  expect(compact).not.toContain("2 parent→agent");
  const expanded = agentBatchCellLines(batch, 120, true, theme).map((line) => line.text).join("\n");
  expect(expanded.split("Inspect the renderer")).toHaveLength(2);
  expect(expanded).not.toContain("mailbox root -> worker");
});

test("real projection keeps a 10-agent joined batch visible after the parent returns idle", async () => {
  const sessionId = "session_real_agents" as SessionId;
  const turnId = "turn_real_agents" as TurnId;
  const callId = "call_real_agents" as ToolCallId;
  const view = reduceRuntimeEvents(realTenAgentEvents({ sessionId, turnId, callId }), createRuntimeView());

  const projected = chatAgentBatches(view, { sessionId });
  expect(view.sessions[sessionId]?.status).toBe("idle");
  expect(projected).toHaveLength(1);
  expect(projected[0]).toMatchObject({
    callId,
    status: "completed",
    expected: 10,
    terminal: true,
    counts: { active: 0, completed: 10 },
    requestedMaxConcurrency: 10,
    observedPeakConcurrency: 3,
    integration: { status: "responded", evidence: "assistant_response_after_terminal_result" },
  });
  expect(projected[0]?.agents.every((agent) => agent.followupCount === 0 && agent.turns === 1)).toBe(true);

  const [batch] = inlineAgentBatchDisplays(projected);
  if (!batch) throw new Error("expected inline batch");
  const lines = agentBatchCellLines(batch, 128, false, theme).map((line) => line.text).join("\n");
  expect(lines).toContain("10/10 agents completed");
  expect(lines).toContain("peak 3 concurrent (requested 10)");
  expect(lines).toContain("… 4 more agents · Ctrl+O expands all");
  expect(lines).toContain("interaction: 0 follow-ups · 10 one-shot results");
  expect(lines).toContain("parent responded after results");
  expect(lines).not.toContain("output hidden");

  const chat = chatSessionView(view, { sessionId });
  const app = await testRender(
    <box width={128} height={28} flexDirection="column">
      <MessageList chatView={chat} localItems={[]} width={128} theme={theme} agentBatches={[batch]} />
    </box>,
    { width: 128, height: 28, exitOnCtrlC: false },
  );
  try {
    await act(async () => {
      await app.renderOnce();
    });
    const frame = app.captureCharFrame();
    expect(frame).toContain("10/10 agents completed");
    expect(frame).toContain("parent responded after results");
    expect(frame).toContain("Parent acknowledged the completed batch.");
    expect(frame).not.toContain("Started 10 ad-hoc agents");
    expect(frame).not.toContain("output hidden");
  } finally {
    app.renderer.destroy();
  }
});

test("message-list line counts follow lifecycle cards and Ctrl+O expansion", () => {
  const callId = "call_line_count_agents" as ToolCallId;
  const tool: Extract<ChatTranscriptItem, { kind: "tool" }> = {
    id: callId,
    kind: "tool",
    toolName: "task_batch",
    status: "completed",
    displayStatus: "succeeded",
    waitingForApproval: false,
    updatedAt: 20,
    inputSummary: { title: "task_batch" },
    input: { tasks: Array.from({ length: 10 }, (_, index) => ({ description: `slice-${index + 1}` })) },
    output: "{}",
  };
  const batch = batchFixture(Array.from({ length: 10 }, (_, index) => (
    agent(`agent-${index + 1}`, `Inspect slice ${index + 1}`, "completed", `Result ${index + 1}`)
  )), { callId, integration: "responded" });
  const chatView: ChatSessionView = {
    status: "idle",
    items: [tool],
    pendingApprovals: [],
    activeTools: [],
    generatedAt: "2026-08-19T00:00:00.000Z",
  };
  const base = messageListLineCount({ chatView, localItems: [], width: 80, theme });
  const compact = messageListLineCount({ chatView, localItems: [], width: 80, theme, agentBatches: [batch] });
  const expanded = messageListLineCount({
    chatView,
    localItems: [],
    width: 80,
    theme,
    agentBatches: [batch],
    showToolDetails: true,
  });

  expect(compact).toBeGreaterThan(base);
  expect(expanded).toBeGreaterThan(compact);
});

function agent(
  name: string,
  task: string,
  status: InlineAgentStatus,
  summary?: string,
  activity?: string,
) {
  return {
    id: `task_${name}`,
    name,
    task,
    status,
    ...(summary ? { summary } : {}),
    ...(activity ? { activity } : {}),
    messages: [],
  };
}

function batchFixture(
  agents: InlineAgentBatchDisplay["agents"],
  options: {
    expected?: number;
    integration?: InlineAgentBatchDisplay["integration"]["status"];
    callId?: ToolCallId;
  } = {},
): InlineAgentBatchDisplay {
  const expected = options.expected ?? agents.length;
  const count = (status: InlineAgentStatus) => agents.filter((agent) => agent.status === status).length;
  const pending = count("pending");
  const running = count("running");
  const completed = count("completed");
  const incomplete = count("incomplete");
  const failed = count("failed");
  const cancelled = count("cancelled");
  const terminal = completed + incomplete + failed + cancelled;
  const status = pending + running > 0
    ? "running"
    : incomplete + failed + cancelled > 0
      ? completed > 0 ? "mixed" : incomplete > 0 ? "incomplete" : failed > 0 ? "failed" : "cancelled"
      : "completed";
  return {
    id: "batch_agents",
    ...(options.callId ? { callId: options.callId } : {}),
    status,
    expected,
    counts: {
      total: agents.length,
      pending,
      running,
      active: pending + running,
      completed,
      incomplete,
      failed,
      cancelled,
    },
    agents,
    spawnFailures: [],
    messages: [],
    integration: { status: options.integration ?? (terminal > 0 ? "ready" : "pending") },
    completionPolicy: "join",
    createdAt: 2,
    updatedAt: 20,
  };
}

function realTenAgentEvents(input: {
  sessionId: SessionId;
  turnId: TurnId;
  callId: ToolCallId;
}): ChiliEvent[] {
  const batchId = "batch_real_agents";
  const tasks = Array.from({ length: 10 }, (_, index) => ({
    description: `agent-${index + 1}`,
    prompt: `Inspect slice ${index + 1} and report evidence.`,
  }));
  const taskIds = tasks.map((_, index) => `task_real_${index + 1}` as TaskId);
  const lifecycle = tasks.flatMap((task, index): ChiliEvent[] => {
    const taskId = taskIds[index]!;
    const path = `/root/agent-${index + 1}` as AgentPath;
    const runId = `agent_run_real_${index + 1}` as AgentRunId;
    const wave = Math.floor(index / 3);
    const offset = index % 3;
    const spawnAt = 10 + wave * 12 + offset;
    const completeAt = 20 + wave * 12 + offset;
    const terminal = {
      taskId,
      path,
      runId,
      generation: 1,
      status: "completed" as const,
      summary: `Result ${index + 1}: verified slice ${index + 1}.`,
    };
    return [
      {
        id: `event_real_task_${index}`,
        type: "agent.task_created",
        time: (spawnAt - 1) as TimestampMs,
        sessionId: input.sessionId,
        payload: {
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: input.sessionId,
          childSessionId: `session_real_child_${index}` as SessionId,
          taskName: task.description,
          cwd: "/repo",
          prompt: task.prompt,
          mode: "background",
          sourceCallId: input.callId,
          batchId,
          batchIndex: index,
          expectedBatchSize: tasks.length,
          completionPolicy: "join",
          maxConcurrency: 10,
        },
      },
      {
        id: `event_real_spawn_${index}`,
        type: "agent.spawned",
        time: spawnAt as TimestampMs,
        sessionId: input.sessionId,
        payload: {
          runId,
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: input.sessionId,
          childSessionId: `session_real_child_${index}` as SessionId,
          taskName: task.description,
          cwd: "/repo",
          mode: "background",
          generation: 1,
          sourceCallId: input.callId,
          batchId,
          batchIndex: index,
          expectedBatchSize: tasks.length,
          completionPolicy: "join",
          maxConcurrency: 10,
        },
      },
      {
        id: `event_real_task_completed_${index}`,
        type: "agent.task_completed",
        time: completeAt as TimestampMs,
        sessionId: input.sessionId,
        payload: terminal,
      },
      {
        id: `event_real_agent_completed_${index}`,
        type: "agent.completed",
        time: (completeAt + 1) as TimestampMs,
        sessionId: input.sessionId,
        payload: terminal,
      },
    ];
  });
  const assistantMessageId = "message_real_parent_response" as MessageId;
  const assistantPartId = "part_real_parent_response" as PartId;
  const responseTurnId = "turn_real_agents_continuation" as TurnId;
  return [
    {
      id: "event_real_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId: input.sessionId,
      payload: { sessionId: input.sessionId, cwd: "/repo" },
    },
    {
      id: "event_real_batch_started",
      type: "tool.call_started",
      time: 2 as TimestampMs,
      sessionId: input.sessionId,
      payload: {
        turnId: input.turnId,
        callId: input.callId,
        toolName: "task_batch",
        input: { tasks, maxConcurrency: 10, completionPolicy: "join", batchId },
      },
    },
    ...lifecycle,
    {
      id: "event_real_batch_finished",
      type: "tool.call_finished",
      time: 60 as TimestampMs,
      sessionId: input.sessionId,
      payload: {
        callId: input.callId,
        status: "completed",
        output: JSON.stringify({
          batchId,
          expectedBatchSize: 10,
          spawnedCount: 10,
          completionPolicy: "join",
          joined: true,
          tasks: taskIds.map((taskId, index) => ({ taskId, status: "completed", summary: `Result ${index + 1}` })),
        }),
      },
    },
    {
      id: "event_real_continuation_started",
      type: "turn.started",
      time: 61 as TimestampMs,
      sessionId: input.sessionId,
      payload: { turnId: responseTurnId },
    },
    {
      id: "event_real_parent_response",
      type: "message.created",
      time: 62 as TimestampMs,
      sessionId: input.sessionId,
      payload: { messageId: assistantMessageId, role: "assistant", turnId: responseTurnId },
    },
    {
      id: "event_real_parent_response_text",
      type: "message.part_added",
      time: 63 as TimestampMs,
      sessionId: input.sessionId,
      payload: {
        messageId: assistantMessageId,
        part: {
          id: assistantPartId,
          messageId: assistantMessageId,
          sessionId: input.sessionId,
          type: "text",
          text: "Parent acknowledged the completed batch.",
          phase: "final_answer",
        },
      },
    },
    {
      id: "event_real_continuation_completed",
      type: "turn.completed",
      time: 64 as TimestampMs,
      sessionId: input.sessionId,
      payload: { turnId: responseTurnId, status: "completed" },
    },
  ];
}
