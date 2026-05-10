import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { TeamControlService, type AgentTreeSnapshot, type SubmitPromptInput } from "@chili/core";
import type {
  ApprovalRow,
  AgentMailboxQuery,
  AgentTaskRow,
  AgentMailboxRow,
  AgentRunRow,
  EventPublisher,
  EventQuery,
  EventStore,
  SessionRow,
  TeamTaskRow,
} from "@chili/store";
import { ObservableEventStore, SqliteEventStore } from "@chili/store";
import type {
  AgentPath,
  AgentRunId,
  ApprovalDecisionAction,
  ChiliEvent,
  EventEnvelope,
  Message,
  ModelSelection,
  ReasoningLevel,
  RuntimeModelConfig,
  RuntimeModelDescriptor,
  RuntimePermissionConfig,
  RuntimePermissionProfileId,
  RuntimePromptCommandInvocation,
  RuntimePromptCommandList,
  RuntimeSessionRef,
  ServiceTier,
  SessionId,
  TaskId,
  TeamId,
  ThreadGoal,
  ThreadGoalStatus,
  ThreadId,
  TimestampMs,
} from "@chili/protocol";
import type { RuntimeAgentsSnapshot } from "./agent-projection.js";
import type {
  RuntimeAgentTreeService,
  RuntimeHttpService,
  RuntimeMcpControlService,
  RuntimeTaskControlService,
  RuntimeTeamDispatcherService,
  RuntimeTeamExecutionRunnerService,
  RuntimeTeamMergeService,
} from "./runtime-http.js";
import type { PromptCommandControl, PromptCommandRunResult } from "./commands.js";
import { createRuntimeHttpHandler } from "./runtime-http.js";

test("serves sessions and event backlog over the runtime HTTP handler", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });

  const createResponse = await handler(
    new Request("http://chili.test/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd: "/repo" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(createResponse.status).toBe(201);
  const session = (await createResponse.json()) as RuntimeSessionRef;

  const sessionsResponse = await handler(new Request("http://chili.test/sessions"));
  expect(sessionsResponse.status).toBe(200);
  const sessions = (await sessionsResponse.json()) as SessionRow[];
  expect(sessions[0]?.id).toBe(session.sessionId);

  const controller = new AbortController();
  const eventsResponse = await handler(
    new Request(`http://chili.test/events?sessionId=${session.sessionId}`, {
      signal: controller.signal,
    }),
  );
  expect(eventsResponse.status).toBe(200);
  const reader = eventsResponse.body?.getReader();
  if (!reader) throw new Error("expected event stream body");
  const chunk = await reader.read();
  controller.abort();
  reader.releaseLock();

  expect(new TextDecoder().decode(chunk.value)).toContain("session.created");
});

test("serves subagent runs and tasks through an event replay projection", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const session = await service.createSession({ cwd: "/repo" });
  const rootRunId = "agentrun_http_root" as AgentRunId;
  const childRunId = "agentrun_http_child" as AgentRunId;
  const rootPath = "/root" as AgentPath;
  const childPath = "/root/reviewer" as AgentPath;
  const teamId = "team_http" as TeamId;
  const taskId = "task_http" as TaskId;
  const localTaskId = "task_local_http" as TaskId;
  const localRunId = "agentrun_local_http" as AgentRunId;
  const localPath = "/root/local_reader" as AgentPath;

  await store.appendMany([
    {
      id: "event_agent_root",
      type: "agent.spawned",
      time: 2 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: { runId: rootRunId, path: rootPath, taskName: "lead" },
    },
    {
      id: "event_agent_child",
      type: "agent.spawned",
      time: 3 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: { runId: childRunId, path: childPath, parentPath: rootPath, taskName: "review" },
    },
    {
      id: "event_task_created",
      type: "team.task_created",
      time: 4 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: { teamId, taskId, ownerPath: childPath },
    },
    {
      id: "event_mailbox",
      type: "agent.message_queued",
      time: 5 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: { path: childPath, from: rootPath, triggerTurn: true },
    },
    {
      id: "event_task_done",
      type: "team.task_updated",
      time: 6 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: { teamId, taskId, status: "completed" },
    },
    {
      id: "event_local_task",
      type: "agent.task_created",
      time: 7 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: {
        taskId: localTaskId,
        path: localPath,
        parentPath: rootPath,
        parentSessionId: session.sessionId,
        parentThreadId: session.threadId,
        childSessionId: "session_child_http" as SessionId,
        childThreadId: "thread_child_http" as ThreadId,
        taskName: "local reader",
        cwd: "/repo",
        prompt: "read",
      },
    },
    {
      id: "event_local_task_completed",
      type: "agent.task_completed",
      time: 8 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: {
        taskId: localTaskId,
        path: localPath,
        status: "completed",
        generation: 1,
        summary: "done",
      },
    },
    {
      id: "event_local_agent",
      type: "agent.spawned",
      time: 9 as TimestampMs,
      sessionId: session.sessionId,
      threadId: session.threadId,
      payload: {
        runId: localRunId,
        taskId: localTaskId,
        path: localPath,
        parentPath: rootPath,
        parentSessionId: session.sessionId,
        parentThreadId: session.threadId,
        childSessionId: "session_child_http" as SessionId,
        childThreadId: "thread_child_http" as ThreadId,
        taskName: "local reader",
        generation: 2,
      },
    },
  ]);

  const response = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/agents`));
  expect(response.status).toBe(200);
  const body = (await response.json()) as RuntimeAgentsSnapshot;

  expect(body.agents.map((agent) => agent.id)).toEqual([rootRunId, childRunId, localRunId]);
  expect(body.agents[0]?.childRunIds).toEqual([childRunId, localRunId]);
  expect(body.agents[1]?.mailboxMessageIds).toEqual(["event_mailbox"]);
  expect(body.tasks[0]?.status).toBe("completed");
  const localTask = body.tasks.find((task) => task.id === localTaskId);
  expect(localTask?.status).toBe("running");
  expect(localTask?.completedAt).toBeUndefined();
  expect(body.mailbox[0]?.triggerTurn).toBe(true);
});

test("serves task control routes", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const tasks = new FakeTaskControlService();
  const handler = createRuntimeHttpHandler({ service, store, tasks });

  const listResponse = await handler(new Request("http://chili.test/tasks?status=running"));
  expect(listResponse.status).toBe(200);
  expect(await listResponse.json()).toMatchObject([{ id: "task_http", status: "running" }]);
  expect(tasks.lastListStatus).toBe("running");

  const taskResponse = await handler(new Request("http://chili.test/tasks/task_http"));
  expect(taskResponse.status).toBe(200);
  expect(await taskResponse.json()).toMatchObject({ id: "task_http", status: "running" });

  const followupResponse = await handler(
    new Request("http://chili.test/tasks/task_http/followup", {
      method: "POST",
      body: JSON.stringify({ text: "continue", maxTurns: 2 }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(followupResponse.status).toBe(200);
  expect(await followupResponse.json()).toMatchObject({
    task: { id: "task_http", status: "completed", summary: "done" },
    result: { status: "completed", finishReason: "stop" },
  });
  expect(tasks.lastFollowupText).toBe("continue");

  const legacyFollowupResponse = await handler(
    new Request("http://chili.test/tasks/task_http/followup", {
      method: "POST",
      body: JSON.stringify({ text: "continue", system: ["old"] }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(legacyFollowupResponse.status).toBe(400);
  expect(await legacyFollowupResponse.json()).toMatchObject({
    error: { message: "system is no longer supported in runtime prompt requests" },
  });

  const waitResponse = await handler(
    new Request("http://chili.test/tasks/task_http/wait", {
      method: "POST",
      body: JSON.stringify({ timeoutMs: 10 }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(waitResponse.status).toBe(200);
  expect(await waitResponse.json()).toMatchObject({ id: "task_http" });

  const closeResponse = await handler(
    new Request("http://chili.test/tasks/task_http/close", {
      method: "POST",
      body: JSON.stringify({ status: "cancelled", summary: "stopped" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(closeResponse.status).toBe(200);
  expect(await closeResponse.json()).toMatchObject({ id: "task_http", status: "cancelled", summary: "stopped" });

  const reconcileResponse = await handler(
    new Request("http://chili.test/tasks/reconcile_stale", {
      method: "POST",
      body: JSON.stringify({ staleAfterMs: 0, modes: ["background"], limit: 25 }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(reconcileResponse.status).toBe(200);
  expect(await reconcileResponse.json()).toMatchObject({
    scanned: 1,
    closed: [{ id: "task_http", status: "cancelled" }],
  });
  expect(tasks.lastReconcile).toMatchObject({ staleAfterMs: 0, modes: ["background"], limit: 25 });
});

test("serves agent tree and mailbox control routes", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const agents = new FakeAgentTreeService();
  const handler = createRuntimeHttpHandler({ service, store, agents });

  const treeResponse = await handler(new Request("http://chili.test/agents/tree?rootPath=/root&includeConsumedMailbox=true"));
  expect(treeResponse.status).toBe(200);
  expect(await treeResponse.json()).toMatchObject({
    rootPath: "/root",
    nodes: [{ path: "/root", children: [{ path: "/root/task_http" }] }],
  });

  const runsResponse = await handler(new Request("http://chili.test/agent_runs?path=/root/task_http"));
  expect(runsResponse.status).toBe(200);
  expect(await runsResponse.json()).toMatchObject([{ id: "agent_http_child", path: "/root/task_http" }]);

  const mailboxResponse = await handler(new Request("http://chili.test/mailbox?status=queued"));
  expect(mailboxResponse.status).toBe(200);
  expect(await mailboxResponse.json()).toMatchObject([{ id: "event_mailbox", status: "queued" }]);
  expect(agents.mailboxQueries.at(-1)).toMatchObject({ status: "queued" });

  const taskMailboxResponse = await handler(new Request("http://chili.test/mailbox?taskId=task_http&status=queued"));
  expect(taskMailboxResponse.status).toBe(200);
  expect(await taskMailboxResponse.json()).toMatchObject([{ id: "event_mailbox", status: "queued" }]);
  expect(agents.mailboxQueries.at(-1)).toMatchObject({ taskId: "task_http", status: "queued" });

  const consumeResponse = await handler(
    new Request("http://chili.test/mailbox/event_mailbox/consume", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(consumeResponse.status).toBe(200);
  expect(await consumeResponse.json()).toMatchObject({ id: "event_mailbox", status: "consumed" });
  expect(agents.consumedIds).toEqual(["event_mailbox"]);
});

test("serves team control routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chili-http-team-"));
  const baseStore = new SqliteEventStore(join(dir, "events.sqlite"));
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const teams = new TeamControlService({
    store,
    createId: createSequentialId(),
    now: () => 10 as TimestampMs,
  });
  const teamDispatcher = new FakeTeamDispatcherService();
  const teamMerger = new FakeTeamMergeService();
  const teamRunner = new FakeTeamExecutionRunnerService();
  const handler = createRuntimeHttpHandler({ service, store, teams, teamDispatcher, teamMerger, teamRunner });

  try {
    const createTeamResponse = await handler(
      new Request("http://chili.test/teams", {
        method: "POST",
        body: JSON.stringify({ name: "alpha", leadPath: "/root", description: "team api" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(createTeamResponse.status).toBe(201);
    const team = (await createTeamResponse.json()) as { id: TeamId };
    expect(team).toMatchObject({ id: "team_1", name: "alpha", leadPath: "/root" });

    const addMemberResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/members`, {
        method: "POST",
        body: JSON.stringify({
          path: "/root/reviewer",
          name: "reviewer",
          role: "reviewer",
          childSessionId: "session_reviewer",
          childThreadId: "thread_reviewer",
          toolScope: ["read"],
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(addMemberResponse.status).toBe(201);
    expect(await addMemberResponse.json()).toMatchObject({ path: "/root/reviewer", role: "reviewer" });

    const createTaskResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title: "Review HTTP team API", createdBy: "/root" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(createTaskResponse.status).toBe(201);
    const task = (await createTaskResponse.json()) as { id: TaskId };

    const assignResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/assign`, {
        method: "POST",
        body: JSON.stringify({
          ownerPath: "/root/reviewer",
          assignedBy: "/root",
          message: "please review",
          messageDelivery: "triggerTurn",
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(assignResponse.status).toBe(200);
    expect(await assignResponse.json()).toMatchObject({ id: task.id, ownerPath: "/root/reviewer" });

    const claimResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/claim`, {
        method: "POST",
        body: JSON.stringify({ ownerPath: "/root/reviewer", claimedBy: "/root/reviewer" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(claimResponse.status).toBe(200);
    expect(await claimResponse.json()).toMatchObject({ applied: true, task: { id: task.id, status: "in_progress" } });

    const dispatchResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/dispatch`, {
        method: "POST",
        body: JSON.stringify({ mode: "background", sessionId: "session_dispatch", threadId: "thread_dispatch" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(dispatchResponse.status).toBe(200);
    const runningTeamTask = teamTaskRow({
      teamId: team.id,
      taskId: task.id,
      status: "in_progress",
      metadata: teamDispatchMetadata("running"),
    });
    const runningAgentTask = localSubagentTaskRow({ status: "running" });
    expect(await dispatchResponse.json()).toEqual({
      status: "running",
      teamTask: runningTeamTask,
      team_task: runningTeamTask,
      agentTask: runningAgentTask,
      agent_task: runningAgentTask,
    });
    expect(teamDispatcher.dispatchInputs).toMatchObject([
      { teamId: team.id, taskId: task.id, mode: "background", sessionId: "session_dispatch", threadId: "thread_dispatch" },
    ]);

    teamDispatcher.nextDispatchResult = {
      status: "skipped",
      reason: "missing_owner",
      teamTask: teamTaskRow({ teamId: team.id, taskId: task.id, status: "pending" }),
    };
    const skippedDispatchResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/dispatch`, {
        method: "POST",
        body: JSON.stringify({ sessionId: "session_dispatch" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(skippedDispatchResponse.status).toBe(200);
    const skippedTeamTask = teamTaskRow({ teamId: team.id, taskId: task.id, status: "pending" });
    expect(await skippedDispatchResponse.json()).toEqual({
      status: "skipped",
      teamTask: skippedTeamTask,
      team_task: skippedTeamTask,
      reason: "missing_owner",
    });

    const syncResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/sync`, {
        method: "POST",
        body: JSON.stringify({ sessionId: "session_dispatch" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toEqual({
      applied: true,
      teamTask: teamTaskRow({
        teamId: team.id,
        taskId: task.id,
        status: "completed",
        metadata: teamDispatchMetadata("completed", 102),
      }),
      agentTask: taskRow({ status: "completed", summary: "done" }),
    });
    expect(teamDispatcher.syncInputs).toMatchObject([{ teamId: team.id, taskId: task.id, sessionId: "session_dispatch" }]);

    const teamReconcileResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/reconcile_dispatches`, {
        method: "POST",
        body: JSON.stringify({ sessionId: "session_dispatch", limit: 5 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(teamReconcileResponse.status).toBe(200);
    expect(await teamReconcileResponse.json()).toEqual(reconcileResultJson(team.id));
    expect(teamDispatcher.reconcileInputs.at(-1)).toMatchObject({ teamId: team.id, sessionId: "session_dispatch", limit: 5 });

    const globalReconcileResponse = await handler(
      new Request("http://chili.test/teams/reconcile_dispatches", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(globalReconcileResponse.status).toBe(200);
    expect(await globalReconcileResponse.json()).toEqual(reconcileResultJson("team_http" as TeamId));
    expect(teamDispatcher.reconcileInputs.at(-1)).toMatchObject({ limit: 10 });

    const mergeResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/merge`, {
        method: "POST",
        body: JSON.stringify({ sessionId: "session_dispatch", threadId: "thread_dispatch", taskId: task.id, cwd: "/repo" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(mergeResponse.status).toBe(200);
    expect(await mergeResponse.json()).toEqual(teamMergeResultJson(team.id, task.id));
    expect(teamMerger.mergeInputs).toMatchObject([
      { teamId: team.id, taskId: task.id, sessionId: "session_dispatch", threadId: "thread_dispatch", cwd: "/repo" },
    ]);

    const runLoopResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/run_loop`, {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session_dispatch",
          threadId: "thread_dispatch",
          cwd: "/repo",
          mode: "background",
          once: true,
          maxCycles: 2,
          timeoutMs: 1000,
          pollIntervalMs: 10,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(runLoopResponse.status).toBe(200);
    expect(await runLoopResponse.json()).toEqual(teamRunLoopResultJson(team.id));
    expect(teamRunner.runInputs).toMatchObject([
      {
        teamId: team.id,
        sessionId: "session_dispatch",
        threadId: "thread_dispatch",
        cwd: "/repo",
        mode: "background",
        once: true,
        maxCycles: 2,
        timeoutMs: 1000,
        pollIntervalMs: 10,
      },
    ]);

    const updateResponse = await handler(
      new Request(`http://chili.test/teams/${team.id}/tasks/${task.id}/update`, {
        method: "POST",
        body: JSON.stringify({ status: "completed", summary: "done" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({ id: task.id, status: "completed", summary: "done" });

    const tasksResponse = await handler(new Request(`http://chili.test/teams/${team.id}/tasks`));
    expect(tasksResponse.status).toBe(200);
    expect(await tasksResponse.json()).toMatchObject([{ id: task.id, status: "completed" }]);

    const messagesResponse = await handler(new Request(`http://chili.test/teams/${team.id}/messages`));
    expect(messagesResponse.status).toBe(200);
    expect(await messagesResponse.json()).toMatchObject([
      { kind: "task_assignment", delivery: "triggerTurn", deliveryStatus: "queued", content: "please review" },
    ]);
    const snapshotResponse = await handler(new Request(`http://chili.test/teams/${team.id}/snapshot`));
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      stats: {
        memberCount: number;
        taskCount: number;
        messageCount: number;
        deliveryCount: number;
      };
      members: Array<{ path: string; taskIds: string[]; deliveryIds: string[] }>;
      tasks: Array<{ id: string; owner?: { path: string }; messageIds: string[] }>;
      messages: Array<{ deliveries: Array<{ path: string; status: string }> }>;
    };
    expect(snapshot.stats).toMatchObject({
      memberCount: 2,
      taskCount: 1,
      messageCount: 1,
      deliveryCount: 1,
    });
    expect(snapshot.members.find((member) => member.path === "/root/reviewer")).toMatchObject({
      taskIds: [task.id],
    });
    expect(snapshot.members.find((member) => member.path === "/root/reviewer")?.deliveryIds).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      id: task.id,
      owner: { path: "/root/reviewer" },
    });
    expect(snapshot.tasks[0]?.messageIds).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      deliveries: [{ path: "/root/reviewer", status: "queued" }],
    });
    expect(await store.agentMailbox({ path: "/root/reviewer" as AgentPath, status: "queued" })).toMatchObject([
      {
        path: "/root/reviewer",
        fromPath: "/root",
        triggerTurn: true,
        childSessionId: "session_reviewer",
        childThreadId: "thread_reviewer",
        taskId: task.id,
      },
    ]);
  } finally {
    baseStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolves approvals through the runtime HTTP handler", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const calls: unknown[] = [];
  const approvals = {
    resolved: false,
    resolve(input: { decision: ApprovalDecisionAction; feedback?: string }) {
      calls.push(input);
      this.resolved = input.decision === "allow_session";
      return this.resolved;
    },
  };
  const handler = createRuntimeHttpHandler({ service, store, approvals });

  const response = await handler(
    new Request("http://chili.test/approvals/approval_http/resolve", {
      method: "POST",
      body: JSON.stringify({ decision: "allow_session", feedback: "" }),
      headers: { "content-type": "application/json" },
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ resolved: true });
  expect(approvals.resolved).toBe(true);
  expect(calls).toEqual([{ approvalId: "approval_http", decision: "allow_session", feedback: "" }]);
});

test("gets and sets permission profiles through the runtime HTTP handler", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  let profile: RuntimePermissionProfileId = "default";
  const permissions = {
    get() {
      return permissionConfig(profile);
    },
    set(nextProfile: RuntimePermissionProfileId) {
      profile = nextProfile;
      return permissionConfig(profile);
    },
  };
  const handler = createRuntimeHttpHandler({ service, store, permissions });

  const getResponse = await handler(new Request("http://chili.test/permissions"));
  expect(getResponse.status).toBe(200);
  expect(await getResponse.json()).toMatchObject({ profile: "default" });

  const setResponse = await handler(
    new Request("http://chili.test/permissions", {
      method: "POST",
      body: JSON.stringify({ profile: "full-access" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(setResponse.status).toBe(200);
  expect(await setResponse.json()).toMatchObject({ profile: "full-access" });
  expect(String(profile)).toBe("full-access");

  const badResponse = await handler(
    new Request("http://chili.test/permissions", {
      method: "POST",
      body: JSON.stringify({ profile: "unsafe" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(badResponse.status).toBe(400);
});

test("serves prompt commands and submits expanded command prompts", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const commands = new FakePromptCommandControl();
  const handler = createRuntimeHttpHandler({ service, store, commands });
  const session = await service.createSession();

  const listResponse = await handler(new Request("http://chili.test/commands"));
  expect(listResponse.status).toBe(200);
  expect(await listResponse.json()).toMatchObject({
    commands: [{ name: "joke", description: "Tell a joke" }],
  });

  const reloadResponse = await handler(
    new Request("http://chili.test/commands/reload", { method: "POST" }),
  );
  expect(reloadResponse.status).toBe(200);
  expect(commands.reloadCount).toBe(1);

  const submitResponse = await handler(
    new Request(`http://chili.test/sessions/${session.sessionId}/command_async`, {
      method: "POST",
      body: JSON.stringify({
        threadId: session.threadId,
        name: "joke",
        args: "typescript",
        modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
        reasoningLevel: "high",
      }),
      headers: { "content-type": "application/json" },
    }),
  );

  expect(submitResponse.status).toBe(202);
  expect(commands.lastRun).toEqual({ name: "joke", args: "typescript" });
  expect(service.lastPrompt).toMatchObject({
    text: "Tell a short joke about typescript.",
    displayText: "/joke typescript",
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    reasoningLevel: "high",
  });
});

test("serves MCP management routes through optional runtime control", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const mcp = new FakeMcpControlService();
  const handler = createRuntimeHttpHandler({ service, store, mcp });

  const listResponse = await handler(new Request("http://chili.test/mcp"));
  expect(listResponse.status).toBe(200);
  expect(await listResponse.json()).toMatchObject({
    servers: [{ name: "github", status: "running", toolCount: 2 }],
  });

  const statusResponse = await handler(new Request("http://chili.test/mcp/status"));
  expect(statusResponse.status).toBe(200);
  expect(await statusResponse.json()).toMatchObject({
    summary: { total: 1, running: 1, disabled: 0, authRequired: 0, errored: 0 },
  });

  const addResponse = await handler(
    new Request("http://chili.test/mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "remote_docs",
        transport: "http",
        url: "https://mcp.example/docs",
        enabled: false,
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(addResponse.status).toBe(201);
  expect(await addResponse.json()).toMatchObject({ name: "remote_docs", status: "disabled", enabled: false });
  expect(mcp.added).toMatchObject({
    name: "remote_docs",
    transport: "http",
    url: "https://mcp.example/docs",
    enabled: false,
  });

  const stdioAddResponse = await handler(
    new Request("http://chili.test/mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
      }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(stdioAddResponse.status).toBe(403);

  const serverResponse = await handler(new Request("http://chili.test/mcp/github"));
  expect(serverResponse.status).toBe(200);
  expect(await serverResponse.json()).toMatchObject({ name: "github", status: "running" });

  const toolsResponse = await handler(new Request("http://chili.test/mcp/github/tools"));
  expect(toolsResponse.status).toBe(200);
  expect(await toolsResponse.json()).toEqual({
    server: "github",
    tools: [{ name: "search_issues", description: "Search issues" }],
  });

  const authResponse = await handler(
    new Request("http://chili.test/mcp/github/auth", {
      method: "POST",
      body: JSON.stringify({ callbackUrl: "http://localhost/callback", scopes: ["repo"] }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(authResponse.status).toBe(200);
  expect(await authResponse.json()).toEqual({
    server: "github",
    status: "pending",
    url: "https://auth.example/github",
  });
  expect(mcp.authInput).toEqual({ callbackUrl: "http://localhost/callback", scopes: ["repo"] });

  const reloadResponse = await handler(new Request("http://chili.test/mcp/reload", { method: "POST" }));
  expect(reloadResponse.status).toBe(200);
  expect(await reloadResponse.json()).toMatchObject({ reloaded: true, errors: [] });

  const logoutResponse = await handler(new Request("http://chili.test/mcp/github/logout", { method: "POST" }));
  expect(logoutResponse.status).toBe(200);
  expect(await logoutResponse.json()).toEqual({ server: "github", loggedOut: true });

  const removeResponse = await handler(new Request("http://chili.test/mcp/github", { method: "DELETE" }));
  expect(removeResponse.status).toBe(200);
  expect(await removeResponse.json()).toEqual({ server: "github", removed: true });
});

test("returns not implemented for MCP routes without runtime control", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });

  const response = await handler(new Request("http://chili.test/mcp"));

  expect(response.status).toBe(501);
  expect(await response.json()).toEqual({ error: { message: "No MCP control service is configured" } });
});

test("rejects malformed approval resolve payloads before the runtime resolver", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const calls: unknown[] = [];
  const handler = createRuntimeHttpHandler({
    service,
    store,
    approvals: {
      resolve(input: unknown) {
        calls.push(input);
        return true;
      },
    },
  });

  const cases = [
    { body: {}, message: "decision is required" },
    { body: { decision: "allow_forever" }, message: "decision must be one of allow_once, allow_session, allow_always, deny" },
    { body: { decision: "allow_once", feedback: 123 }, message: "feedback must be a string" },
    { body: { decision: "allow_once", scope: "session" }, message: "Unexpected field: scope" },
  ];

  for (const testCase of cases) {
    const response = await handler(
      new Request("http://chili.test/approvals/approval_http/resolve", {
        method: "POST",
        body: JSON.stringify(testCase.body),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: testCase.message } });
  }

  expect(calls).toEqual([]);
});

test("returns conflict when approval is not pending in the runtime queue", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const approvals = {
    resolve() {
      return false;
    },
  };
  const handler = createRuntimeHttpHandler({ service, store, approvals });

  const response = await handler(
    new Request("http://chili.test/approvals/approval_orphan/resolve", {
      method: "POST",
      body: JSON.stringify({ decision: "allow_once" }),
      headers: { "content-type": "application/json" },
    }),
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: {
      message: "Approval is not pending in this runtime. It may have been handled already or orphaned by a server restart.",
    },
  });
});

test("passes request cancellation through team run loop HTTP route", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const controller = new AbortController();
  const teamRunner = new AbortObservingTeamExecutionRunnerService(() => controller.abort());
  const handler = createRuntimeHttpHandler({ service, store, teamRunner });

  const response = await handler(
    new Request("http://chili.test/teams/team_abort/run_loop", {
      method: "POST",
      body: JSON.stringify({ once: true }),
      headers: { "content-type": "application/json" },
      signal: controller.signal,
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ teamId: "team_abort", stopReason: "aborted" });
  expect(teamRunner.seenSignal).toBeInstanceOf(AbortSignal);
  expect(teamRunner.signalAbortedAfterAbort).toBe(true);
});

test("serves model control routes and prompt model overrides", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const session = await service.createSession();

  const modelsResponse = await handler(new Request("http://chili.test/models?provider=openai-codex"));
  expect(modelsResponse.status).toBe(200);
  expect(await modelsResponse.json()).toEqual([
    {
      provider: "openai-codex",
      model: "gpt-5.5",
      displayName: "GPT-5.5",
      capabilities: { reasoning: true },
    },
  ]);

  const setModelResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/model`, {
    method: "POST",
    body: JSON.stringify({
      threadId: session.threadId,
      modelSelection: { provider: "openai-codex", model: "gpt-5.3-codex" },
    }),
    headers: { "content-type": "application/json" },
  }));
  expect(setModelResponse.status).toBe(200);
  expect(service.modelSelection).toEqual({ provider: "openai-codex", model: "gpt-5.3-codex" });

  const setReasoningResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/reasoning`, {
    method: "POST",
    body: JSON.stringify({ threadId: session.threadId, reasoningLevel: "high" }),
    headers: { "content-type": "application/json" },
  }));
  expect(setReasoningResponse.status).toBe(200);
  expect(service.reasoningLevel).toBe("high");

  const setServiceTierResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/service-tier`, {
    method: "POST",
    body: JSON.stringify({ threadId: session.threadId, serviceTier: "fast" }),
    headers: { "content-type": "application/json" },
  }));
  expect(setServiceTierResponse.status).toBe(200);
  expect(service.serviceTier).toBe("fast");

  const promptResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      threadId: session.threadId,
      text: "hello",
      skillMentions: [{ name: "reviewer", path: "/repo/.chili/skills/reviewer/SKILL.md" }],
      modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
      reasoningLevel: "xhigh",
      serviceTier: "fast",
    }),
    headers: { "content-type": "application/json" },
  }));
  expect(promptResponse.status).toBe(202);
  expect(service.lastPrompt).toMatchObject({
    skillMentions: [{ name: "reviewer", path: "/repo/.chili/skills/reviewer/SKILL.md" }],
    modelSelection: { provider: "openai-codex", model: "gpt-5.5" },
    reasoningLevel: "xhigh",
    serviceTier: "fast",
  });

  const legacyPromptResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      threadId: session.threadId,
      text: "hello",
      system: ["old"],
    }),
    headers: { "content-type": "application/json" },
  }));
  expect(legacyPromptResponse.status).toBe(400);
  expect(await legacyPromptResponse.json()).toMatchObject({
    error: { message: "system is no longer supported in runtime prompt requests" },
  });
});

test("serves persistent goal control routes", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });
  const session = await service.createSession();

  const setResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/goal`, {
    method: "POST",
    body: JSON.stringify({
      threadId: session.threadId,
      objective: "Ship the goal route",
      tokenBudget: 50_000,
      replace: true,
    }),
    headers: { "content-type": "application/json" },
  }));
  expect(setResponse.status).toBe(201);
  expect(await setResponse.json()).toMatchObject({ objective: "Ship the goal route", status: "active" });

  const pauseResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/goal`, {
    method: "PATCH",
    body: JSON.stringify({ threadId: session.threadId, status: "paused" }),
    headers: { "content-type": "application/json" },
  }));
  expect(pauseResponse.status).toBe(200);
  expect(await pauseResponse.json()).toMatchObject({ status: "paused" });

  const getResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/goal?threadId=${session.threadId}`));
  expect(getResponse.status).toBe(200);
  expect(await getResponse.json()).toMatchObject({ objective: "Ship the goal route", status: "paused" });

  const clearResponse = await handler(new Request(`http://chili.test/sessions/${session.sessionId}/goal?threadId=${session.threadId}`, {
    method: "DELETE",
  }));
  expect(clearResponse.status).toBe(200);
  expect(await clearResponse.json()).toMatchObject({ cleared: true });
});

test("does not accept async prompts for missing or busy sessions", async () => {
  const baseStore = new MemoryEventStore();
  const store = new ObservableEventStore(baseStore);
  const service = new BusyRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });

  const missingResponse = await handler(
    new Request("http://chili.test/sessions/session_missing/prompt_async", {
      method: "POST",
      body: JSON.stringify({ threadId: "thread_missing", text: "hello" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(missingResponse.status).toBe(404);
  expect(service.accepted).toBe(false);

  const created = await service.createSession();
  const busyResponse = await handler(
    new Request(`http://chili.test/sessions/${created.sessionId}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ threadId: created.threadId, text: "hello" }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(busyResponse.status).toBe(409);
  expect(service.accepted).toBe(false);
});

test("cleans up SSE subscriptions when the stream reader is cancelled", async () => {
  const store = new CountingEventStore();
  const service = new FakeRuntimeService(store);
  const handler = createRuntimeHttpHandler({ service, store });

  const response = await handler(new Request("http://chili.test/events"));
  const reader = response.body?.getReader();
  if (!reader) throw new Error("expected event stream body");

  expect(store.listenerCount).toBe(1);
  await reader.cancel();
  expect(store.listenerCount).toBe(0);
});

class FakeRuntimeService implements RuntimeHttpService {
  modelSelection: ModelSelection | undefined;
  reasoningLevel: ReasoningLevel | undefined;
  serviceTier: ServiceTier | undefined;
  lastPrompt: SubmitPromptInput | undefined;
  goal: ThreadGoal | undefined;

  constructor(private readonly store: EventStore & EventPublisher) {}

  async createSession(input: { sessionId?: SessionId; threadId?: ThreadId; cwd?: string } = {}): Promise<RuntimeSessionRef> {
    const sessionId = input.sessionId ?? ("session_http" as SessionId);
    const threadId = input.threadId ?? ("thread_http" as ThreadId);
    await this.store.append({
      id: "event_session_created",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, cwd: input.cwd ?? "/repo" },
    });
    return { sessionId, threadId };
  }

  async listModels(input: { provider?: string } = {}): Promise<RuntimeModelDescriptor[]> {
    const models: RuntimeModelDescriptor[] = [
      {
        provider: "openai-codex",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        capabilities: { reasoning: true },
      },
    ];
    return input.provider ? models.filter((model) => model.provider === input.provider) : models;
  }

  async getModelConfig(sessionId: SessionId): Promise<RuntimeModelConfig> {
    return {
      sessionId,
      availableReasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
      models: await this.listModels(),
      ...(this.modelSelection ? { modelSelection: this.modelSelection } : {}),
      ...(this.reasoningLevel ? { reasoningLevel: this.reasoningLevel } : {}),
      ...(this.serviceTier ? { serviceTier: this.serviceTier } : {}),
    };
  }

  async setModel(input: { sessionId: SessionId; modelSelection: ModelSelection }): Promise<RuntimeModelConfig> {
    this.modelSelection = input.modelSelection;
    return this.getModelConfig(input.sessionId);
  }

  async setReasoning(input: { sessionId: SessionId; reasoningLevel: ReasoningLevel }): Promise<RuntimeModelConfig> {
    this.reasoningLevel = input.reasoningLevel;
    return this.getModelConfig(input.sessionId);
  }

  async setServiceTier(input: { sessionId: SessionId; serviceTier: ServiceTier }): Promise<RuntimeModelConfig> {
    this.serviceTier = input.serviceTier;
    return this.getModelConfig(input.sessionId);
  }

  async getGoal(input: { threadId: ThreadId }): Promise<ThreadGoal | undefined> {
    return this.goal?.threadId === input.threadId ? this.goal : undefined;
  }

  async setGoal(input: { sessionId: SessionId; threadId: ThreadId; objective: string; tokenBudget?: number }): Promise<ThreadGoal> {
    this.goal = {
      sessionId: input.sessionId,
      threadId: input.threadId,
      objective: input.objective,
      status: "active",
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 3 as TimestampMs,
      updatedAt: 3 as TimestampMs,
    };
    return this.goal;
  }

  async updateGoal(input: { sessionId: SessionId; threadId: ThreadId; status?: ThreadGoalStatus }): Promise<ThreadGoal> {
    if (!this.goal || this.goal.threadId !== input.threadId) throw new Error("No goal");
    this.goal = {
      ...this.goal,
      sessionId: input.sessionId,
      ...(input.status ? { status: input.status } : {}),
      updatedAt: 4 as TimestampMs,
    };
    return this.goal;
  }

  async clearGoal(input: { threadId: ThreadId }): Promise<{ cleared: boolean; previousGoal?: ThreadGoal }> {
    if (!this.goal || this.goal.threadId !== input.threadId) return { cleared: false };
    const previousGoal = this.goal;
    this.goal = undefined;
    return { cleared: true, previousGoal };
  }

  async submitPrompt(input: SubmitPromptInput): Promise<Awaited<ReturnType<RuntimeHttpService["submitPrompt"]>>> {
    this.lastPrompt = input;
    return { status: "completed", turns: [], finishReason: "stop" };
  }

  submitPromptAsync(input: SubmitPromptInput): void {
    this.lastPrompt = input;
  }

  async interrupt(): Promise<boolean> {
    return true;
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    await this.store.append({
      id: "event_session_archived",
      type: "session.archived",
      time: 2 as TimestampMs,
      sessionId,
      payload: { sessionId },
    });
  }
}

class BusyRuntimeService extends FakeRuntimeService {
  accepted = false;

  override submitPromptAsync(): void {
    const error = new Error("Session is already running: session_http");
    error.name = "RuntimeBusyError";
    throw error;
  }
}

class FakePromptCommandControl implements PromptCommandControl {
  reloadCount = 0;
  lastRun: RuntimePromptCommandInvocation | undefined;

  async list(): Promise<RuntimePromptCommandList> {
    return promptCommandList();
  }

  async reload(): Promise<RuntimePromptCommandList> {
    this.reloadCount += 1;
    return promptCommandList();
  }

  async run(input: RuntimePromptCommandInvocation): Promise<PromptCommandRunResult> {
    this.lastRun = { ...input };
    return {
      prompt: `Tell a short joke about ${input.args ?? "coding"}.`,
      command: promptCommandList().commands[0]!,
    };
  }
}

class FakeMcpControlService implements RuntimeMcpControlService {
  added: Parameters<NonNullable<RuntimeMcpControlService["add"]>>[0] | undefined;
  authInput: Parameters<NonNullable<RuntimeMcpControlService["auth"]>>[1] | undefined;

  async list(): Promise<Awaited<ReturnType<RuntimeMcpControlService["list"]>>> {
    return {
      servers: [mcpServer()],
    };
  }

  async reload(): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["reload"]>>>> {
    return {
      reloaded: true,
      servers: [mcpServer()],
      errors: [],
    };
  }

  async add(input: Parameters<NonNullable<RuntimeMcpControlService["add"]>>[0]): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["add"]>>>> {
    this.added = input;
    const server: Awaited<ReturnType<NonNullable<RuntimeMcpControlService["add"]>>> = {
      name: input.name,
      status: input.enabled === false ? "disabled" : "running",
      enabled: input.enabled ?? true,
    };
    if (input.transport) server.transport = input.transport;
    if (input.command) server.command = input.command;
    if (input.args) server.args = input.args;
    if (input.url) server.url = input.url;
    return server;
  }

  async remove(server: string): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["remove"]>>>> {
    return { server, removed: true };
  }

  async tools(server: string): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["tools"]>>>> {
    return {
      server,
      tools: [{ name: "search_issues", description: "Search issues" }],
    };
  }

  async auth(
    server: string,
    input?: Parameters<NonNullable<RuntimeMcpControlService["auth"]>>[1],
  ): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["auth"]>>>> {
    this.authInput = input;
    return {
      server,
      status: "pending",
      url: `https://auth.example/${server}`,
    };
  }

  async logout(server: string): Promise<Awaited<ReturnType<NonNullable<RuntimeMcpControlService["logout"]>>>> {
    return { server, loggedOut: true };
  }
}

class FakeTaskControlService implements RuntimeTaskControlService {
  lastListStatus: string | undefined;
  lastFollowupText: string | undefined;
  lastReconcile: unknown;

  async listTasks(query: { status?: string } = {}): Promise<AgentTaskRow[]> {
    this.lastListStatus = query.status;
    return [taskRow({ status: "running" })];
  }

  async getTask(): Promise<AgentTaskRow> {
    return taskRow({ status: "running" });
  }

  async followupTask(input: { text: string }): Promise<Awaited<ReturnType<RuntimeTaskControlService["followupTask"]>>> {
    this.lastFollowupText = input.text;
    return {
      task: taskRow({ status: "completed", summary: "done" }),
      result: {
        status: "completed",
        turns: [],
        finishReason: "stop",
      },
    };
  }

  async waitForTask(): Promise<AgentTaskRow> {
    return taskRow({ status: "completed", summary: "done" });
  }

  async closeTask(input: { status?: "completed" | "failed" | "cancelled"; summary?: string }): Promise<AgentTaskRow> {
    const rowInput: { status: AgentTaskRow["status"]; summary?: string } = { status: input.status ?? "cancelled" };
    if (input.summary) rowInput.summary = input.summary;
    return taskRow(rowInput);
  }

  async reconcileStaleTasks(input = {}): Promise<{ scanned: number; closed: AgentTaskRow[] }> {
    this.lastReconcile = input;
    return { scanned: 1, closed: [taskRow({ status: "cancelled" })] };
  }
}

class FakeAgentTreeService implements RuntimeAgentTreeService {
  consumedIds: string[] = [];
  mailboxQueries: AgentMailboxQuery[] = [];

  async snapshot(): Promise<AgentTreeSnapshot> {
    const root = agentRunRow({ id: "agent_http_root", path: "/root", taskName: "lead" });
    const child = agentRunRow({ id: "agent_http_child", path: "/root/task_http", parentPath: "/root", taskName: "review" });
    const mailbox = mailboxRow({ status: "queued" });
    return {
      rootPath: "/root" as AgentPath,
      agents: [root, child],
      tasks: [taskRow({ status: "running" })],
      mailbox: [mailbox],
      nodes: [
        {
          path: "/root" as AgentPath,
          taskName: "lead",
          status: "running",
          runIds: [root.id],
          runs: [root],
          tasks: [],
          mailbox: [],
          createdAt: 1,
          updatedAt: 1,
          children: [
            {
              path: "/root/task_http" as AgentPath,
              parentPath: "/root" as AgentPath,
              taskName: "review",
              status: "running",
              runIds: [child.id],
              runs: [child],
              tasks: [taskRow({ status: "running" })],
              mailbox: [mailbox],
              children: [],
              createdAt: 2,
              updatedAt: 2,
            },
          ],
        },
      ],
    };
  }

  async agentRuns(): Promise<AgentRunRow[]> {
    return [agentRunRow({ id: "agent_http_child", path: "/root/task_http", parentPath: "/root", taskName: "review" })];
  }

  async mailbox(query: AgentMailboxQuery = {}): Promise<AgentMailboxRow[]> {
    this.mailboxQueries.push(query);
    return [mailboxRow({ status: "queued" })];
  }

  async consumeMailbox(input: { messageId: string }): Promise<AgentMailboxRow> {
    this.consumedIds.push(input.messageId);
    return mailboxRow({ status: "consumed" });
  }
}

class FakeTeamDispatcherService implements RuntimeTeamDispatcherService {
  dispatchInputs: Array<Parameters<RuntimeTeamDispatcherService["dispatchTask"]>[0]> = [];
  syncInputs: Array<Parameters<RuntimeTeamDispatcherService["syncTask"]>[0]> = [];
  reconcileInputs: Array<NonNullable<Parameters<RuntimeTeamDispatcherService["reconcileTasks"]>[0]>> = [];
  nextDispatchResult: Awaited<ReturnType<RuntimeTeamDispatcherService["dispatchTask"]>> | undefined;

  async dispatchTask(
    input: Parameters<RuntimeTeamDispatcherService["dispatchTask"]>[0],
  ): Promise<Awaited<ReturnType<RuntimeTeamDispatcherService["dispatchTask"]>>> {
    this.dispatchInputs.push(input);
    if (this.nextDispatchResult) {
      const result = this.nextDispatchResult;
      this.nextDispatchResult = undefined;
      return result;
    }
    return {
      status: "running",
      teamTask: teamTaskRow({
        teamId: input.teamId,
        taskId: input.taskId,
        status: "in_progress",
        metadata: teamDispatchMetadata("running"),
      }),
      agentTask: localSubagentTaskRow({ status: "running" }),
    };
  }

  async syncTask(
    input: Parameters<RuntimeTeamDispatcherService["syncTask"]>[0],
  ): Promise<Awaited<ReturnType<RuntimeTeamDispatcherService["syncTask"]>>> {
    this.syncInputs.push(input);
    return {
      applied: true,
      teamTask: teamTaskRow({
        teamId: input.teamId,
        taskId: input.taskId,
        status: "completed",
        metadata: teamDispatchMetadata("completed", 102),
      }),
      agentTask: taskRow({ status: "completed", summary: "done" }),
    };
  }

  async reconcileTasks(
    input: NonNullable<Parameters<RuntimeTeamDispatcherService["reconcileTasks"]>[0]> = {},
  ): Promise<Awaited<ReturnType<RuntimeTeamDispatcherService["reconcileTasks"]>>> {
    this.reconcileInputs.push(input);
    return reconcileResultJson(input.teamId ?? ("team_http" as TeamId));
  }
}

class FakeTeamExecutionRunnerService implements RuntimeTeamExecutionRunnerService {
  runInputs: Array<Parameters<RuntimeTeamExecutionRunnerService["run"]>[0]> = [];

  async run(input: Parameters<RuntimeTeamExecutionRunnerService["run"]>[0]): Promise<Awaited<ReturnType<RuntimeTeamExecutionRunnerService["run"]>>> {
    this.runInputs.push(input);
    return teamRunLoopResultJson(input.teamId);
  }
}

class FakeTeamMergeService implements RuntimeTeamMergeService {
  mergeInputs: Array<Parameters<RuntimeTeamMergeService["mergeTeamTasks"]>[0]> = [];

  async mergeTeamTasks(
    input: Parameters<RuntimeTeamMergeService["mergeTeamTasks"]>[0],
  ): Promise<Awaited<ReturnType<RuntimeTeamMergeService["mergeTeamTasks"]>>> {
    this.mergeInputs.push(input);
    return teamMergeResultJson(input.teamId, input.taskId ?? ("task_http" as TaskId));
  }
}

class AbortObservingTeamExecutionRunnerService implements RuntimeTeamExecutionRunnerService {
  seenSignal: AbortSignal | undefined;
  signalAbortedAfterAbort = false;

  constructor(private readonly abortRequest: () => void) {}

  async run(input: Parameters<RuntimeTeamExecutionRunnerService["run"]>[0]): Promise<Awaited<ReturnType<RuntimeTeamExecutionRunnerService["run"]>>> {
    this.seenSignal = input.signal;
    this.abortRequest();
    this.signalAbortedAfterAbort = input.signal?.aborted ?? false;
    return {
      ...teamRunLoopResultJson(input.teamId),
      stopReason: this.signalAbortedAfterAbort ? "aborted" : "once",
    };
  }
}

function reconcileResultJson(teamId: TeamId): Awaited<ReturnType<RuntimeTeamDispatcherService["reconcileTasks"]>> {
  return {
    scanned: 2,
    synced: [
      {
        applied: true,
        teamTask: teamTaskRow({
          teamId,
          taskId: "task_http" as TaskId,
          status: "completed",
          metadata: teamDispatchMetadata("completed", 102),
        }),
        agentTask: taskRow({ status: "completed", summary: "done" }),
      },
    ],
    skipped: [
      {
        applied: false,
        reason: "agent_running",
        teamTask: teamTaskRow({
          teamId,
          taskId: "task_skip_http" as TaskId,
          status: "in_progress",
          metadata: teamDispatchMetadata("running"),
        }),
        agentTask: taskRow({ status: "running" }),
      },
    ],
    errors: [],
  };
}

function teamRunLoopResultJson(teamId: TeamId): Awaited<ReturnType<RuntimeTeamExecutionRunnerService["run"]>> {
  return {
    teamId,
    cycles: 1,
    stopReason: "once",
    startedAt: 100,
    endedAt: 110,
    dispatched: [
      {
        teamId,
        taskId: "task_http" as TaskId,
        ownerPath: "/root/reviewer" as AgentPath,
        agentTaskId: "task_agent_http" as TaskId,
        status: "running",
      },
    ],
    completed: [],
    accepted: [],
    reopened: [],
    merged: [],
    mergeFailed: [],
    mergeConflicted: [],
    mergeSkipped: [],
    failed: [],
    blocked: [],
    skipped: [],
    stillRunning: [
      {
        teamId,
        taskId: "task_http" as TaskId,
        ownerPath: "/root/reviewer" as AgentPath,
        agentTaskId: "task_agent_http" as TaskId,
        title: "HTTP team task",
      },
    ],
    errors: [],
  };
}

function teamMergeResultJson(teamId: TeamId, taskId: TaskId): Awaited<ReturnType<RuntimeTeamMergeService["mergeTeamTasks"]>> {
  return {
    scanned: 1,
    applied: [
      {
        status: "applied",
        teamTask: teamTaskRow({ teamId, taskId, status: "completed" }),
        diffSummary: { filesChanged: 1, paths: ["packages/core/src/team.ts"], truncatedPaths: false, diffBytes: 120 },
      },
    ],
    failed: [],
    conflicted: [],
    skipped: [],
    errors: [],
  };
}

function teamDispatchMetadata(agentStatus: "running" | "completed", syncedAt?: number): Record<string, unknown> {
  return {
    chiliTeamDispatch: {
      agentTaskId: "task_agent_http",
      agentPath: "/root/reviewer/task_agent_http",
      runId: "agent_http_dispatch",
      childSessionId: "session_child_dispatch",
      childThreadId: "thread_child_dispatch",
      mode: "background",
      dispatchedAt: 101,
      agentStatus,
      ...(syncedAt === undefined ? {} : { syncedAt }),
    },
  };
}

function localSubagentTaskRow(input: { status: "running" | "completed" | "failed" | "cancelled" }): {
  taskId: TaskId;
  runId: AgentRunId;
  path: AgentPath;
  parentPath: AgentPath;
  childSessionId: SessionId;
  childThreadId: ThreadId;
  status: "running" | "completed" | "failed" | "cancelled";
} {
  return {
    taskId: "task_agent_http" as TaskId,
    runId: "agent_http_dispatch" as AgentRunId,
    path: "/root/reviewer/task_agent_http" as AgentPath,
    parentPath: "/root/reviewer" as AgentPath,
    childSessionId: "session_child_dispatch" as SessionId,
    childThreadId: "thread_child_dispatch" as ThreadId,
    status: input.status,
  };
}

function mcpServer() {
  return {
    name: "github",
    status: "running" as const,
    enabled: true,
    transport: "http" as const,
    url: "https://mcp.example/github",
    toolCount: 2,
    auth: {
      required: true,
      authenticated: true,
      provider: "github",
    },
  };
}

function teamTaskRow(input: {
  teamId: TeamId;
  taskId: TaskId;
  status: TeamTaskRow["status"];
  metadata?: Record<string, unknown>;
}): TeamTaskRow {
  const row: TeamTaskRow = {
    id: input.taskId,
    teamId: input.teamId,
    title: "HTTP team task",
    status: input.status,
    ownerPath: "/root/reviewer" as AgentPath,
    dependsOn: [],
    createdAt: 1,
    updatedAt: 2,
  };
  if (input.metadata) row.metadata = input.metadata;
  return row;
}

function taskRow(input: { status: AgentTaskRow["status"]; summary?: string }): AgentTaskRow {
  const row: AgentTaskRow = {
    id: "task_http" as TaskId,
    path: "/root/task_http" as AgentPath,
    taskName: "review",
    status: input.status,
    generation: 0,
    childSessionId: "session_child" as SessionId,
    childThreadId: "thread_child" as ThreadId,
    createdAt: 1,
    updatedAt: 2,
  };
  if (input.summary) row.summary = input.summary;
  return row;
}

function agentRunRow(input: { id: string; path: string; parentPath?: string; taskName: string }): AgentRunRow {
  const row: AgentRunRow = {
    id: input.id,
    path: input.path as AgentPath,
    taskName: input.taskName,
    status: "running",
    createdAt: 1,
  };
  if (input.parentPath) row.parentPath = input.parentPath as AgentPath;
  return row;
}

function mailboxRow(input: { status: AgentMailboxRow["status"] }): AgentMailboxRow {
  const row: AgentMailboxRow = {
    id: "event_mailbox",
    path: "/root/task_http" as AgentPath,
    fromPath: "/root" as AgentPath,
    triggerTurn: true,
    status: input.status,
    taskId: "task_http" as TaskId,
    createdAt: 3,
  };
  if (input.status === "consumed") row.consumedAt = 4;
  return row;
}

function createSequentialId(): (prefix: string) => string {
  let next = 0;
  return (prefix: string) => `${prefix}_${++next}`;
}

function permissionConfig(profile: RuntimePermissionProfileId): RuntimePermissionConfig {
  return {
    profile,
    profiles: [
      { id: "default", label: "Default", description: "Default permissions", current: profile === "default" },
      { id: "auto-review", label: "Auto-review", description: "Auto-review permissions", current: profile === "auto-review", disabledReason: "disabled" },
      { id: "full-access", label: "Full Access", description: "Full access permissions", current: profile === "full-access" },
    ],
  };
}

function promptCommandList(): RuntimePromptCommandList {
  return {
    commands: [
      {
        name: "joke",
        aliases: [],
        description: "Tell a joke",
        category: "project",
        source: "project",
        argumentHint: "[topic]",
        hidden: false,
      },
    ],
    diagnostics: [],
    directories: ["/repo/.chili/commands"],
    skippedConflicts: [],
  };
}

class MemoryEventStore implements EventStore {
  readonly items: ChiliEvent[] = [];
  readonly sessionRows = new Map<string, SessionRow>();

  async append(event: ChiliEvent): Promise<void> {
    this.items.push(event);
    if (event.type === "session.created") {
      this.sessionRows.set(event.payload.sessionId, {
        id: event.payload.sessionId,
        cwd: event.payload.cwd,
        title: "repo",
        status: "active",
        createdAt: event.time,
        updatedAt: event.time,
      });
    }
  }

  async appendMany(events: readonly ChiliEvent[]): Promise<void> {
    for (const event of events) await this.append(event);
  }

  async events(query: EventQuery = {}): Promise<EventEnvelope[]> {
    return this.items.filter((event) => {
      if (query.sessionId && event.sessionId !== query.sessionId) return false;
      if (query.threadId && event.threadId !== query.threadId) return false;
      if (query.type && event.type !== query.type) return false;
      return true;
    });
  }

  async sessions(): Promise<SessionRow[]> {
    return [...this.sessionRows.values()];
  }

  async messages(): Promise<Message[]> {
    return [];
  }

  async pendingApprovals(): Promise<ApprovalRow[]> {
    return [];
  }
}

class CountingEventStore extends MemoryEventStore implements EventPublisher {
  listenerCount = 0;

  subscribe(): () => void {
    this.listenerCount++;
    return () => {
      this.listenerCount--;
    };
  }
}
