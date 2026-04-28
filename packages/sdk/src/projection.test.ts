import { expect, test } from "bun:test";
import type {
  AgentPath,
  AgentRunId,
  ChiliEvent,
  MessageId,
  PartId,
  SessionId,
  TaskId,
  TeamId,
  ThreadId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import {
  HttpRuntimeClient,
  type RuntimeAgentTaskRecord,
  type RuntimeLocalSubagentTaskRecord,
  type RuntimeTeamExecutionRunSummary,
  type RuntimeTeamTaskDispatchResult,
  type RuntimeTeamTaskReconcileResult,
  type RuntimeTeamTaskRecord,
  type RuntimeTeamTaskSyncResult,
  type RuntimeTeamSnapshot,
} from "./client.js";
import { createRuntimeView, pendingApprovals, reduceRuntimeEvents, runtimeAgentsSnapshot, sessionMessages } from "./projection.js";

test("replays session, message, tool, and approval events into a runtime view", () => {
  const sessionId = "session_test" as SessionId;
  const threadId = "thread_test" as ThreadId;
  const turnId = "turn_test" as TurnId;
  const messageId = "msg_test" as MessageId;
  const partId = "part_test" as PartId;
  const callId = "toolcall_test" as ToolCallId;

  const events: ChiliEvent[] = [
    {
      id: "event_1",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_2",
      type: "message.created",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
      payload: { messageId, role: "assistant" },
    },
    {
      id: "event_3",
      type: "message.part_added",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: {
        messageId,
        part: { id: partId, messageId, sessionId, type: "text", text: "hello" },
      },
    },
    {
      id: "event_4",
      type: "message.part_delta",
      time: 4 as TimestampMs,
      sessionId,
      threadId,
      payload: { messageId, partId, field: "text", delta: " world" },
    },
    {
      id: "event_5",
      type: "tool.call_started",
      time: 5 as TimestampMs,
      sessionId,
      threadId,
      payload: { turnId, callId, toolName: "read", input: { filePath: "README.md" } },
    },
    {
      id: "event_6",
      type: "tool.call_updated",
      time: 6 as TimestampMs,
      sessionId,
      threadId,
      payload: { callId, status: "waiting_for_approval" },
    },
    {
      id: "event_7",
      type: "approval.requested",
      time: 7 as TimestampMs,
      sessionId,
      threadId,
      payload: { approvalId: "approval_test" as never, callId, permission: "tool.read", patterns: ["README.md"] },
    },
    {
      id: "event_8",
      type: "approval.resolved",
      time: 8 as TimestampMs,
      sessionId,
      threadId,
      payload: { approvalId: "approval_test" as never, decision: "allow_once" },
    },
    {
      id: "event_9",
      type: "tool.call_finished",
      time: 9 as TimestampMs,
      sessionId,
      threadId,
      payload: { callId, status: "completed", output: "ok" },
    },
    {
      id: "event_10",
      type: "turn.completed",
      time: 10 as TimestampMs,
      sessionId,
      threadId,
      payload: { turnId, status: "completed" },
    },
  ];

  const view = reduceRuntimeEvents(events, createRuntimeView());
  const [message] = sessionMessages(view, sessionId);

  expect(view.sessions[sessionId]?.cwd).toBe("/repo");
  expect(view.sessions[sessionId]?.status).toBe("idle");
  expect(message?.parts[0]?.type).toBe("text");
  expect(message?.parts[0]?.type === "text" ? message.parts[0].text : "").toBe("hello world");
  expect(view.toolCalls[callId]?.status).toBe("completed");
  expect(pendingApprovals(view, sessionId)).toHaveLength(0);
});

test("projects subagent runs, mailbox messages, and team tasks", () => {
  const sessionId = "session_agents" as SessionId;
  const threadId = "thread_agents" as ThreadId;
  const rootRunId = "agentrun_root" as AgentRunId;
  const childRunId = "agentrun_child" as AgentRunId;
  const teamId = "team_agents" as TeamId;
  const taskId = "task_review" as TaskId;
  const rootPath = "/root" as AgentPath;
  const childPath = "/root/reviewer" as AgentPath;

  const events: ChiliEvent[] = [
    {
      id: "event_1",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      threadId,
      payload: { sessionId, cwd: "/repo" },
    },
    {
      id: "event_2",
      type: "agent.spawned",
      time: 2 as TimestampMs,
      sessionId,
      threadId,
      payload: { runId: rootRunId, path: rootPath, taskName: "lead" },
    },
    {
      id: "event_3",
      type: "agent.spawned",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: { runId: childRunId, path: childPath, parentPath: rootPath, taskName: "review" },
    },
    {
      id: "event_team_created",
      type: "team.created",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: { teamId, name: "agents", leadPath: rootPath, description: "projection team" },
    },
    {
      id: "event_team_member_lead",
      type: "team.member_added",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: { teamId, path: rootPath, name: "team-lead", role: "leader", status: "running" },
    },
    {
      id: "event_team_member_child",
      type: "team.member_added",
      time: 3 as TimestampMs,
      sessionId,
      threadId,
      payload: { teamId, path: childPath, name: "reviewer", role: "reviewer", status: "idle", toolScope: ["read"] },
    },
    {
      id: "event_4",
      type: "team.task_created",
      time: 4 as TimestampMs,
      sessionId,
      threadId,
      payload: { teamId, taskId, title: "Review projection", ownerPath: childPath },
    },
    {
      id: "event_team_task_claimed",
      type: "team.task_claimed",
      time: 4 as TimestampMs,
      sessionId,
      threadId,
      payload: { teamId, taskId, ownerPath: childPath, claimedBy: childPath },
    },
    {
      id: "event_5",
      type: "agent.message_queued",
      time: 5 as TimestampMs,
      sessionId,
      threadId,
      payload: {
        path: childPath,
        from: rootPath,
        triggerTurn: true,
        message: {
          role: "user",
          content: "Please review projection",
          metadata: { teamId, teamMessageId: "teammsg_projection", teamMessageKind: "task_assignment" },
        },
      },
    },
    {
      id: "event_6",
      type: "agent.message_consumed",
      time: 6 as TimestampMs,
      sessionId,
      threadId,
      payload: { messageId: "event_5", path: childPath },
    },
    {
      id: "event_team_message",
      type: "team.message_sent",
      time: 6 as TimestampMs,
      sessionId,
      threadId,
      payload: {
        teamId,
        messageId: "teammsg_projection",
        from: rootPath,
        to: childPath,
        content: "Please review projection",
        kind: "task_assignment",
        delivery: "queueOnly",
        taskId,
      },
    },
    {
      id: "event_7",
      type: "team.task_updated",
      time: 7 as TimestampMs,
      sessionId,
      threadId,
      payload: { teamId, taskId, status: "completed" },
    },
    {
      id: "event_8",
      type: "agent.completed",
      time: 8 as TimestampMs,
      sessionId,
      threadId,
      payload: { runId: childRunId, path: childPath, status: "completed" },
    },
  ];

  const view = reduceRuntimeEvents(events, createRuntimeView());
  const snapshot = runtimeAgentsSnapshot(view, sessionId);

  expect(view.sessions[sessionId]?.agentRunIds).toEqual([rootRunId, childRunId]);
  expect(view.agents[rootRunId]?.childRunIds).toEqual([childRunId]);
  expect(view.agents[childRunId]?.mailboxMessageIds).toEqual(["event_5"]);
  expect(view.agents[childRunId]?.taskIds).toEqual([taskId]);
  expect(view.teams[teamId]).toMatchObject({
    id: teamId,
    name: "agents",
    leadPath: rootPath,
    description: "projection team",
    memberIds: [`${teamId}:${rootPath}`, `${teamId}:${childPath}`],
    taskIds: [taskId],
    messageIds: ["teammsg_projection"],
  });
  expect(view.teamMembers[`${teamId}:${childPath}`]).toMatchObject({
    teamId,
    path: childPath,
    name: "reviewer",
    role: "reviewer",
    status: "running",
    currentTaskId: taskId,
    toolScope: ["read"],
  });
  expect(view.teamMessages.teammsg_projection).toMatchObject({
    teamId,
    from: rootPath,
    to: childPath,
    kind: "task_assignment",
    delivery: "queueOnly",
    deliveryStatus: "delivered",
    deliveredAt: 6,
    taskId,
  });
  expect(view.tasks[taskId]?.status).toBe("completed");
  expect(view.tasks[taskId]?.title).toBe("Review projection");
  expect(view.tasks[taskId]?.completedAt).toBe(7);
  expect(snapshot.agents.map((agent) => agent.id)).toEqual([rootRunId, childRunId]);
  expect(snapshot.mailbox[0]?.triggerTurn).toBe(true);
  expect(snapshot.mailbox[0]?.status).toBe("consumed");
  expect(snapshot.mailbox[0]?.consumedAt).toBe(6);
});

test("replays completed local subagent tasks as running on newer-generation spawn without completedAt", () => {
  const sessionId = "session_local_agents" as SessionId;
  const threadId = "thread_local_agents" as ThreadId;
  const taskId = "task_local" as TaskId;
  const childSessionId = "session_child_local" as SessionId;
  const childThreadId = "thread_child_local" as ThreadId;
  const path = "/root/task_local" as AgentPath;

  const view = reduceRuntimeEvents(
    [
      {
        id: "event_task_created",
        type: "agent.task_created",
        time: 1 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: sessionId,
          parentThreadId: threadId,
          childSessionId,
          childThreadId,
          taskName: "reader",
          cwd: "/repo",
          prompt: "read",
        },
      },
      {
        id: "event_task_completed",
        type: "agent.task_completed",
        time: 2 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          taskId,
          path,
          status: "completed",
          generation: 1,
          summary: "done",
        },
      },
      {
        id: "event_agent_spawned",
        type: "agent.spawned",
        time: 3 as TimestampMs,
        sessionId,
        threadId,
        payload: {
          runId: "agent_local" as AgentRunId,
          taskId,
          path,
          parentPath: "/root" as AgentPath,
          parentSessionId: sessionId,
          parentThreadId: threadId,
          childSessionId,
          childThreadId,
          taskName: "reader",
          generation: 2,
        },
      },
    ],
    createRuntimeView(),
  );

  expect(view.tasks[taskId]).toMatchObject({
    id: taskId,
    status: "running",
    generation: 2,
    path,
    sessionId,
    childSessionId,
    childThreadId,
  });
  expect(view.tasks[taskId]?.completedAt).toBeUndefined();
  expect(view.sessions[sessionId]?.taskIds).toEqual([taskId]);
});

test("client preserves team dispatcher JSON shapes for dispatch, sync, and reconcile", async () => {
  const teamId = "team_sdk" as TeamId;
  const taskId = "task_sdk" as TaskId;
  const sessionId = "session_sdk" as SessionId;
  const threadId = "thread_sdk" as ThreadId;
  const ownerPath = "/root/reviewer" as AgentPath;
  const teamTask = sdkTeamTaskJson({ teamId, taskId, status: "in_progress", ownerPath });
  const skippedTeamTask = sdkTeamTaskJson({ teamId, taskId, status: "pending", ownerPath, includeMetadata: false });
  const agentTask = sdkAgentTaskJson({ status: "running", ownerPath });
  const syncResult: RuntimeTeamTaskSyncResult = {
    applied: false,
    reason: "agent_running",
    teamTask,
    agentTask: sdkAgentTaskRecord({ status: "running" }),
  };
  const dispatchJson: RuntimeTeamTaskDispatchResult = {
    status: "running",
    teamTask,
    team_task: teamTask,
    agentTask,
    agent_task: agentTask,
  };
  const skippedDispatchJson: RuntimeTeamTaskDispatchResult = {
    status: "skipped",
    reason: "missing_owner",
    teamTask: skippedTeamTask,
    team_task: skippedTeamTask,
  };
  const reconcileJson: RuntimeTeamTaskReconcileResult = {
    scanned: 1,
    synced: [],
    skipped: [syncResult],
    errors: [],
  };
  const runLoopJson: RuntimeTeamExecutionRunSummary = {
    teamId,
    cycles: 1,
    stopReason: "once",
    startedAt: 100,
    endedAt: 110,
    dispatched: [{ teamId, taskId, ownerPath, agentTaskId: agentTask.taskId, status: "running" }],
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
    stillRunning: [{ teamId, taskId, ownerPath, agentTaskId: agentTask.taskId, title: "SDK team task" }],
    errors: [],
  };
  const mergeJson = {
    scanned: 1,
    applied: [],
    failed: [],
    conflicted: [],
    skipped: [],
    errors: [],
  };
  const responses: unknown[] = [dispatchJson, skippedDispatchJson, syncResult, reconcileJson, mergeJson, runLoopJson];
  const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const responseBody = responses.shift();
    if (!responseBody) throw new Error("unexpected request");
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new HttpRuntimeClient({ baseUrl: "http://runtime.test/api", fetch: fetchImpl });

  expect(
    await client.dispatchTeamTask({
      teamId,
      taskId,
      ownerPath,
      sessionId,
      threadId,
      mode: "background",
      cwd: "/repo",
      prompt: "verify",
    }),
  ).toEqual(dispatchJson);
  expect(await client.dispatchTeamTask({ teamId, taskId, sessionId, threadId })).toEqual(skippedDispatchJson);
  expect(await client.syncTeamTask({ teamId, taskId, sessionId, threadId })).toEqual(syncResult);
  expect(await client.reconcileTeamTasks({ teamId, sessionId, threadId, limit: 5 })).toEqual(reconcileJson);
  expect(await client.mergeTeamTasks({ teamId, taskId, sessionId, threadId, cwd: "/repo" })).toEqual(mergeJson);
  expect(
    await client.runTeamLoop({
      teamId,
      sessionId,
      threadId,
      mode: "background",
      cwd: "/repo",
      once: true,
      maxCycles: 2,
      timeoutMs: 1000,
      pollIntervalMs: 10,
    }),
  ).toEqual(runLoopJson);
  expect(requests).toEqual([
    {
      url: "http://runtime.test/api/teams/team_sdk/tasks/task_sdk/dispatch",
      method: "POST",
      body: { teamId, taskId, ownerPath, sessionId, threadId, mode: "background", cwd: "/repo", prompt: "verify" },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/tasks/task_sdk/dispatch",
      method: "POST",
      body: { teamId, taskId, sessionId, threadId },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/tasks/task_sdk/sync",
      method: "POST",
      body: { teamId, taskId, sessionId, threadId },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/reconcile_dispatches",
      method: "POST",
      body: { teamId, sessionId, threadId, limit: 5 },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/merge",
      method: "POST",
      body: { teamId, taskId, sessionId, threadId, cwd: "/repo" },
    },
    {
      url: "http://runtime.test/api/teams/team_sdk/run_loop",
      method: "POST",
      body: {
        teamId,
        sessionId,
        threadId,
        mode: "background",
        cwd: "/repo",
        once: true,
        maxCycles: 2,
        timeoutMs: 1000,
        pollIntervalMs: 10,
      },
    },
  ]);
});

test("client fetches team snapshots through the runtime HTTP API", async () => {
  const teamId = "team_sdk_snapshot" as TeamId;
  const taskId = "task_sdk_snapshot" as TaskId;
  const ownerPath = "/root/reviewer" as AgentPath;
  const teamTask = sdkTeamTaskJson({ teamId, taskId, status: "pending", ownerPath, includeMetadata: false });
  const snapshot: RuntimeTeamSnapshot = {
    team: {
      id: teamId,
      name: "SDK snapshot",
      leadPath: "/root" as AgentPath,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    },
    members: [
      {
        teamId,
        path: ownerPath,
        name: "reviewer",
        role: "reviewer",
        status: "idle",
        taskIds: [taskId],
        deliveryIds: ["mailbox_sdk_snapshot"],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    tasks: [
      {
        ...teamTask,
        blockedBy: [],
        blocks: [],
        ready: true,
        messageIds: ["teammsg_sdk_snapshot"],
      },
    ],
    messages: [
      {
        id: "teammsg_sdk_snapshot",
        teamId,
        fromPath: "/root" as AgentPath,
        toPath: ownerPath,
        content: "review",
        kind: "task_assignment",
        delivery: "triggerTurn",
        deliveryStatus: "queued",
        taskId,
        deliveries: [
          {
            mailboxMessageId: "mailbox_sdk_snapshot",
            teamId,
            teamMessageId: "teammsg_sdk_snapshot",
            path: ownerPath,
            status: "queued",
            triggerTurn: true,
            queuedAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 2,
      },
    ],
    messageDeliveries: [
      {
        mailboxMessageId: "mailbox_sdk_snapshot",
        teamId,
        teamMessageId: "teammsg_sdk_snapshot",
        path: ownerPath,
        status: "queued",
        triggerTurn: true,
        queuedAt: 2,
        updatedAt: 2,
      },
    ],
    stats: {
      memberCount: 1,
      taskCount: 1,
      messageCount: 1,
      deliveryCount: 1,
      membersByStatus: { idle: 1, running: 0, waiting: 0, blocked: 0, closed: 0 },
      tasksByStatus: { pending: 1, in_progress: 0, blocked: 0, completed: 0, failed: 0, cancelled: 0 },
      messagesByDeliveryStatus: { queued: 1 },
      deliveriesByStatus: { queued: 1 },
      readyTaskIds: [taskId],
      blockedTaskIds: [],
    },
    generatedAt: 3,
  };
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push({ url: input instanceof Request ? input.url : String(input), method: init?.method });
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new HttpRuntimeClient({ baseUrl: "http://runtime.test/api", fetch: fetchImpl });

  expect(await client.teamSnapshot(teamId)).toEqual(snapshot);
  expect(requests).toEqual([{ url: "http://runtime.test/api/teams/team_sdk_snapshot/snapshot", method: "GET" }]);
});

function sdkTeamTaskJson(input: {
  teamId: TeamId;
  taskId: TaskId;
  status: "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
  ownerPath: AgentPath;
  includeMetadata?: boolean;
}): RuntimeTeamTaskRecord {
  return {
    id: input.taskId,
    teamId: input.teamId,
    title: "SDK team task",
    status: input.status,
    ownerPath: input.ownerPath,
    dependsOn: [],
    ...(input.includeMetadata === false
      ? {}
      : {
          metadata: {
            chiliTeamDispatch: {
              agentTaskId: "task_agent_sdk",
              agentPath: "/root/reviewer/task_agent_sdk",
              runId: "agentrun_agent_sdk",
              childSessionId: "session_child_sdk",
              childThreadId: "thread_child_sdk",
              mode: "background",
              dispatchedAt: 101,
              agentStatus: "running",
            },
          },
        }),
    createdAt: 1,
    updatedAt: 2,
  };
}

function sdkAgentTaskJson(input: {
  status: "running" | "completed" | "failed" | "cancelled";
  ownerPath: AgentPath;
}): RuntimeLocalSubagentTaskRecord {
  return {
    taskId: "task_agent_sdk" as TaskId,
    runId: "agentrun_agent_sdk",
    path: "/root/reviewer/task_agent_sdk" as AgentPath,
    parentPath: input.ownerPath,
    childSessionId: "session_child_sdk" as SessionId,
    childThreadId: "thread_child_sdk" as ThreadId,
    status: input.status,
  };
}

function sdkAgentTaskRecord(input: { status: "running" | "completed" | "failed" | "cancelled" }): RuntimeAgentTaskRecord {
  return {
    id: "task_agent_sdk" as TaskId,
    path: "/root/reviewer/task_agent_sdk" as AgentPath,
    taskName: "SDK team task",
    status: input.status,
    generation: 0,
    childSessionId: "session_child_sdk" as SessionId,
    childThreadId: "thread_child_sdk" as ThreadId,
    createdAt: 1,
    updatedAt: 2,
  };
}
