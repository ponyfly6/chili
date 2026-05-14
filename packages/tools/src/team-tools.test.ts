import { expect, test } from "bun:test";
import type {
  AgentPath,
  ChiliEvent,
  SessionId,
  TaskId,
  TeamId,
  TimestampMs,
  ToolCallId,
  TurnId,
} from "@chili/protocol";
import type { ApprovalBrokerRequest, ExecuteToolInput } from "./types.js";
import { ToolExecutor } from "./executor.js";
import { InMemoryToolRegistry } from "./registry.js";
import {
  createTeamCreateTool,
  createTeamListTool,
  createTeamMemberAddTool,
  createTeamMemberListTool,
  createTeamMessageListTool,
  createTeamMessageSendTool,
  createTeamSnapshotTool,
  createTeamTaskAssignTool,
  createTeamTaskClaimTool,
  createTeamTaskCreateBatchTool,
  createTeamTaskCreateTool,
  createTeamTaskDispatchBatchTool,
  createTeamTaskDispatchTool,
  createTeamTaskListTool,
  createTeamTaskReconcileTool,
  createTeamRunLoopTool,
  createTeamTaskSyncTool,
  createTeamTaskUpdateTool,
} from "./builtins/team.js";
import type {
  TeamDispatchAgentTaskRecord,
  TeamCreateToolInput,
  TeamListToolInput,
  TeamMemberAddToolInput,
  TeamMemberListToolInput,
  TeamMemberRecord,
  TeamMessageListToolInput,
  TeamMessageRecord,
  TeamMessageSendToolInput,
  TeamRecord,
  TeamRunLoopRecord,
  TeamRunLoopToolController,
  TeamRunLoopToolInput,
  TeamSnapshotRecord,
  TeamSnapshotToolInput,
  TeamTaskAssignToolInput,
  TeamTaskClaimRecord,
  TeamTaskClaimToolInput,
  TeamTaskCreateToolInput,
  TeamTaskDispatchBatchToolInput,
  TeamTaskDispatchRecord,
  TeamTaskDispatchToolController,
  TeamTaskDispatchToolInput,
  TeamTaskListToolInput,
  TeamTaskReconcileRecord,
  TeamTaskReconcileToolInput,
  TeamTaskRecord,
  TeamTaskSyncRecord,
  TeamTaskSyncToolInput,
  TeamTaskUpdateToolInput,
  TeamToolController,
  TeamToolContext,
} from "./team.js";

test("team write tools normalize inputs and return durable board records", async () => {
  const controller = new FakeTeamToolController();
  const approvals: ApprovalBrokerRequest[] = [];
  const executor = createExecutor(registryWithTeamTools(controller), approvals);

  const created = await executor.execute(
    toolInput("create_team", {
      name: "Core team",
      lead_path: "/lead",
      lead_status: "IDLE",
      lead_write_scope: [" packages/core "],
    }),
  );
  expect(created.status).toBe("completed");
  if (created.status === "completed") {
    expect(JSON.parse(created.result.output)).toMatchObject({
      team_id: "team_core",
      name: "Core team",
      lead_path: "/lead",
    });
  }
  expect(controller.createTeamInputs).toEqual([
    { name: "Core team", leadPath: "/lead", leadStatus: "idle", leadWriteScope: ["packages/core"] },
  ]);

  const member = await executor.execute(
    toolInput("team_member_add", {
      team_id: "team_core",
      path: "/worker",
      name: "Worker",
      role: "implementation",
      child_session_id: "session_child",
      tool_scope: ["read", "edit"],
      write_scope: ["packages/tools"],
    }),
  );
  expect(member.status).toBe("completed");
  expect(controller.memberAddInputs).toEqual([
    {
      teamId: "team_core",
      path: "/worker",
      name: "Worker",
      role: "implementation",
      childSessionId: "session_child",
      toolScope: ["read", "edit"],
      writeScope: ["packages/tools"],
    },
  ]);

  const task = await executor.execute(
    toolInput("team_task_create", {
      team_id: "team_core",
      task_id: "task_team",
      subject: "Implement team tools",
      created_by: "/lead",
      owner_path: "/worker",
      depends_on: ["task_dep"],
      status: "running",
      metadata: { priority: "p1" },
      write_scope: [" packages/tools/src "],
      execute_scope: ["scripts"],
      required_tools: ["edit", "bash"],
      suggested_test_commands: ["bun test packages/tools/src/team-tools.test.ts"],
    }),
  );
  expect(task.status).toBe("completed");
  expect(controller.taskCreateInputs).toEqual([
    {
      teamId: "team_core",
      taskId: "task_team",
      title: "Implement team tools",
      createdBy: "/lead",
      ownerPath: "/worker",
      dependsOn: ["task_dep"],
      status: "in_progress",
      metadata: {
        priority: "p1",
        writeScope: ["packages/tools/src"],
        executeScope: ["scripts"],
        requiredTools: ["edit", "bash"],
        suggestedTestCommands: ["bun test packages/tools/src/team-tools.test.ts"],
      },
      writeScope: ["packages/tools/src"],
      executeScope: ["scripts"],
      requiredTools: ["edit", "bash"],
      suggestedTestCommands: ["bun test packages/tools/src/team-tools.test.ts"],
    },
  ]);

  const batch = await executor.execute(
    toolInput("team_task_create_batch", {
      team_id: "team_core",
      created_by: "/lead",
      tasks: [
        {
          task_id: "task_core",
          title: "Update core runtime",
          owner_path: "/worker",
          write_scope: ["packages/core"],
          required_tools: ["edit"],
        },
        {
          task_id: "task_docs",
          title: "Update docs",
          depends_on: ["task_core"],
          metadata: { priority: "p2" },
          write_scope: ["docs"],
        },
      ],
    }),
  );
  expect(batch.status).toBe("completed");
  if (batch.status === "completed") {
    expect(JSON.parse(batch.result.output)).toMatchObject({
      count: 2,
      tasks: [
        { task_id: "task_core", metadata: { writeScope: ["packages/core"], requiredTools: ["edit"] } },
        { task_id: "task_docs", metadata: { priority: "p2", writeScope: ["docs"] } },
      ],
    });
  }
  expect(controller.taskCreateInputs.slice(1)).toEqual([
    {
      teamId: "team_core",
      taskId: "task_core",
      title: "Update core runtime",
      createdBy: "/lead",
      ownerPath: "/worker",
      metadata: { writeScope: ["packages/core"], requiredTools: ["edit"] },
      writeScope: ["packages/core"],
      requiredTools: ["edit"],
    },
    {
      teamId: "team_core",
      taskId: "task_docs",
      title: "Update docs",
      createdBy: "/lead",
      dependsOn: ["task_core"],
      metadata: { priority: "p2", writeScope: ["docs"] },
      writeScope: ["docs"],
    },
  ]);

  const assigned = await executor.execute(
    toolInput("team_task_assign", {
      team_id: "team_core",
      task_id: "task_team",
      owner_path: "/worker",
      assigned_by: "/lead",
      text: "Please take this slice.",
      message_delivery: "trigger-turn",
      message_summary: "assign tools",
    }),
  );
  expect(assigned.status).toBe("completed");
  expect(controller.taskAssignInputs).toEqual([
    {
      teamId: "team_core",
      taskId: "task_team",
      ownerPath: "/worker",
      assignedBy: "/lead",
      message: "Please take this slice.",
      messageDelivery: "triggerTurn",
      messageSummary: "assign tools",
    },
  ]);

  const claimed = await executor.execute(
    toolInput("team_task_claim", {
      team_id: "team_core",
      task_id: "task_team",
      owner_path: "/worker",
      claimed_by: "/worker",
    }),
  );
  expect(claimed.status).toBe("completed");
  if (claimed.status === "completed") {
    expect(JSON.parse(claimed.result.output)).toMatchObject({
      applied: true,
      task: { task_id: "task_team", status: "in_progress" },
    });
  }
  expect(controller.taskClaimInputs).toEqual([
    { teamId: "team_core", taskId: "task_team", ownerPath: "/worker", claimedBy: "/worker" },
  ]);

  const updated = await executor.execute(
    toolInput("team_task_update", {
      team_id: "team_core",
      task_id: "task_team",
      status: "canceled",
      summary: "stopped",
      metadata: { reason: "superseded" },
    }),
  );
  expect(updated.status).toBe("completed");
  expect(controller.taskUpdateInputs).toEqual([
    {
      teamId: "team_core",
      taskId: "task_team",
      status: "cancelled",
      summary: "stopped",
      metadata: { reason: "superseded" },
    },
  ]);

  const message = await executor.execute(
    toolInput("send_team_message", {
      team_id: "team_core",
      message_id: "message_team",
      from: "/lead",
      to: "*",
      text: "Status check",
      kind: "assignment",
      delivery: "queue-only",
      task_id: "task_team",
    }),
  );
  expect(message.status).toBe("completed");
  expect(controller.messageSendInputs).toEqual([
    {
      teamId: "team_core",
      messageId: "message_team",
      from: "/lead",
      to: "*",
      content: "Status check",
      kind: "task_assignment",
      delivery: "queueOnly",
      taskId: "task_team",
    },
  ]);
  if (message.status === "completed") {
    expect(JSON.parse(message.result.output)).toMatchObject({
      message_id: "message_team",
      delivery: "queueOnly",
    });
  }

  expect(approvals).toEqual([]);
});

test("team read tools forward filters and emit list-shaped JSON", async () => {
  const controller = new FakeTeamToolController();
  const approvals: ApprovalBrokerRequest[] = [];
  const executor = createExecutor(registryWithTeamTools(controller), approvals);

  const teams = await executor.execute(toolInput("team_list", { status: "active", limit: 1 }));
  expect(teams.status).toBe("completed");
  if (teams.status === "completed") {
    expect(JSON.parse(teams.result.output)).toMatchObject({
      count: 1,
      teams: [{ team_id: "team_core", status: "active" }],
    });
  }
  expect(controller.teamListInputs).toEqual([{ status: "active", limit: 1 }]);

  const members = await executor.execute(toolInput("team_member_list", { team_id: "team_core", status: "idle", limit: 2 }));
  expect(members.status).toBe("completed");
  expect(controller.memberListInputs).toEqual([{ teamId: "team_core", status: "idle", limit: 2 }]);

  const tasks = await executor.execute(
    toolInput("team_tasks", { team_id: "team_core", status: "in-progress", owner_path: "/worker", limit: 3 }),
  );
  expect(tasks.status).toBe("completed");
  if (tasks.status === "completed") {
    expect(JSON.parse(tasks.result.output)).toMatchObject({
      count: 1,
      tasks: [{ task_id: "task_team", owner_path: "/worker" }],
    });
  }
  expect(controller.taskListInputs).toEqual([
    { teamId: "team_core", status: "in_progress", ownerPath: "/worker", limit: 3 },
  ]);

  const messages = await executor.execute(
    toolInput("team_message_list", { team_id: "team_core", path: "/worker", task_id: "task_team", limit: 4 }),
  );
  expect(messages.status).toBe("completed");
  expect(controller.messageListInputs).toEqual([
    { teamId: "team_core", path: "/worker", taskId: "task_team", limit: 4 },
  ]);

  const snapshot = await executor.execute(toolInput("team_status", { team_id: "team_core" }));
  expect(snapshot.status).toBe("completed");
  if (snapshot.status === "completed") {
    expect(JSON.parse(snapshot.result.output)).toMatchObject({
      team: { team_id: "team_core" },
      stats: { memberCount: 1, taskCount: 1, messageCount: 1, deliveryCount: 1 },
      members: [{ path: "/worker", task_ids: ["task_team"], delivery_ids: ["mailbox_team"] }],
      tasks: [{ task_id: "task_team", ready: true, message_ids: ["message_team"] }],
      messages: [{ message_id: "message_team", deliveries: [{ mailbox_message_id: "mailbox_team", status: "queued" }] }],
    });
  }
  expect(controller.snapshotInputs).toEqual([{ teamId: "team_core" }]);

  expect(approvals).toEqual([]);
});

test("team dispatch tools expose subagent dispatch, sync, and reconcile", async () => {
  const controller = new FakeTeamToolController();
  const approvals: ApprovalBrokerRequest[] = [];
  const executor = createExecutor(registryWithTeamTools(controller), approvals);

  await expect(executor.canRunConcurrently("team_task_dispatch", { team_id: "team_core", task_id: "task_team" })).resolves.toBe(true);
  await expect(
    executor.canRunConcurrently("team_task_dispatch", { team_id: "team_core", task_id: "task_team", mode: "one_shot" }),
  ).resolves.toBe(false);

  const dispatched = await executor.execute(
    toolInput("team_dispatch", {
      team_id: "team_core",
      task_id: "task_team",
      owner_path: "/worker",
      mode: "one-shot",
      prompt: "Implement this slice.",
    }),
  );
  expect(dispatched.status).toBe("completed");
  if (dispatched.status === "completed") {
    expect(JSON.parse(dispatched.result.output)).toMatchObject({
      status: "completed",
      team_task: { task_id: "task_team", owner_path: "/worker" },
      agent_task: { task_id: "agent_task", status: "completed", summary: "done" },
    });
  }
  expect(controller.taskDispatchInputs).toEqual([
    {
      teamId: "team_core",
      taskId: "task_team",
      ownerPath: "/worker",
      mode: "one_shot",
      prompt: "Implement this slice.",
    },
  ]);
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toMatchObject({
    permission: "team_task_dispatch",
    patterns: ["team_core", "task_team", "one_shot"],
  });

  const synced = await executor.execute(toolInput("sync_team_task", { team_id: "team_core", task_id: "task_team" }));
  expect(synced.status).toBe("completed");
  if (synced.status === "completed") {
    expect(JSON.parse(synced.result.output)).toMatchObject({
      applied: true,
      team_task: { task_id: "task_team", status: "completed", summary: "done" },
      agent_task: { task_id: "agent_task", status: "completed" },
    });
  }
  expect(controller.taskSyncInputs).toEqual([{ teamId: "team_core", taskId: "task_team" }]);

  const reconciled = await executor.execute(toolInput("team_reconcile", { team_id: "team_core", limit: 10 }));
  expect(reconciled.status).toBe("completed");
  if (reconciled.status === "completed") {
    expect(JSON.parse(reconciled.result.output)).toMatchObject({
      scanned: 2,
      synced: [{ applied: true, team_task: { task_id: "task_team" } }],
      skipped: [{ applied: false, reason: "agent_running" }],
      errors: [],
    });
  }
  expect(controller.taskReconcileInputs).toEqual([{ teamId: "team_core", limit: 10 }]);
});

test("team run loop tool schedules scoped team work through the runner", async () => {
  const controller = new FakeTeamToolController();
  const approvals: ApprovalBrokerRequest[] = [];
  const executor = createExecutor(registryWithTeamTools(controller), approvals);

  const result = await executor.execute(toolInput("team_run", {
    team_id: "team_core",
    max_concurrent_dispatches: 6,
    timeout_ms: 5000,
  }));

  expect(result.status).toBe("completed");
  expect(controller.teamRunLoopInputs).toEqual([
    {
      teamId: "team_core",
      once: true,
      timeoutMs: 5000,
      maxConcurrentDispatches: 6,
    },
  ]);
  if (result.status === "completed") {
    expect(JSON.parse(result.result.output)).toMatchObject({
      team_id: "team_core",
      stop_reason: "cycle_limit",
      max_concurrent_dispatches: 6,
      dispatched: [{ task_id: "task_team", owner_path: "/worker", agent_task_id: "agent_task" }],
      still_running: [{ task_id: "task_team", title: "Implement team tools" }],
    });
    expect(result.result.metadata).toMatchObject({
      team_id: "team_core",
      stop_reason: "cycle_limit",
      max_concurrent_dispatches: 6,
      dispatched: 1,
      still_running: 1,
    });
  }
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toMatchObject({
    permission: "team_run_loop",
    patterns: ["team_core", "once:true", "concurrency:6", "background"],
  });

  const rejected = await executor.execute(toolInput("team_run_loop", {
    team_id: "team_core",
    max_concurrent_dispatches: 65,
  }));
  expect(rejected.status).toBe("failed");
});

test("team dispatch batch launches background tasks with bounded parallelism", async () => {
  const controller = new FakeTeamToolController();
  controller.dispatchDelayMs = 20;
  const approvals: ApprovalBrokerRequest[] = [];
  const executor = createExecutor(registryWithTeamTools(controller), approvals);

  await expect(executor.canRunConcurrently("team_task_dispatch_batch", {
    team_id: "team_core",
    task_ids: ["task_one"],
  })).resolves.toBe(true);

  const result = await executor.execute(toolInput("team_dispatch_batch", {
    team_id: "team_core",
    max_concurrency: 2,
    tasks: [
      { task_id: "task_one", owner_path: "/worker-a", prompt: "Implement one." },
      { task_id: "task_two", owner_path: "/worker-b" },
      "task_three",
    ],
  }));

  expect(result.status).toBe("completed");
  expect(controller.maxRunningDispatches).toBe(2);
  expect(controller.taskDispatchInputs).toEqual([
    { teamId: "team_core", taskId: "task_one", ownerPath: "/worker-a", mode: "background", prompt: "Implement one." },
    { teamId: "team_core", taskId: "task_two", ownerPath: "/worker-b", mode: "background" },
    { teamId: "team_core", taskId: "task_three", mode: "background" },
  ]);
  if (result.status === "completed") {
    expect(JSON.parse(result.result.output)).toMatchObject({
      count: 3,
      dispatched: [
        { status: "running", team_task: { task_id: "task_one", owner_path: "/worker-a" } },
        { status: "running", team_task: { task_id: "task_two", owner_path: "/worker-b" } },
        { status: "running", team_task: { task_id: "task_three" } },
      ],
      errors: [],
    });
  }
  expect(approvals).toHaveLength(1);
  expect(approvals[0]).toMatchObject({
    permission: "team_task_dispatch",
    patterns: ["team_core", "count:3", "concurrency:2", "background"],
  });

  const rejected = await executor.execute(toolInput("team_dispatch_batch", {
    team_id: "team_core",
    mode: "one_shot",
    task_ids: ["task_one"],
  }));
  expect(rejected.status).toBe("failed");
});

test("team tools reject non-absolute agent paths", async () => {
  const controller = new FakeTeamToolController();
  const executor = createExecutor(registryWithTeamTools(controller), []);

  const result = await executor.execute(
    toolInput("team_member_add", { team_id: "team_core", path: "worker", name: "Worker", role: "implementation" }),
  );

  expect(result.status).toBe("failed");
  if (result.status === "failed") {
    expect(result.error.message).toContain("path must be an absolute agent path");
  }
  expect(controller.memberAddInputs).toEqual([]);
});

function registryWithTeamTools(controller: TeamToolController & TeamTaskDispatchToolController & TeamRunLoopToolController): InMemoryToolRegistry {
  const registry = new InMemoryToolRegistry();
  registry.register(createTeamCreateTool(controller));
  registry.register(createTeamListTool(controller));
  registry.register(createTeamSnapshotTool(controller));
  registry.register(createTeamMemberAddTool(controller));
  registry.register(createTeamMemberListTool(controller));
  registry.register(createTeamTaskCreateTool(controller));
  registry.register(createTeamTaskCreateBatchTool(controller));
  registry.register(createTeamTaskListTool(controller));
  registry.register(createTeamTaskAssignTool(controller));
  registry.register(createTeamTaskClaimTool(controller));
  registry.register(createTeamTaskUpdateTool(controller));
  registry.register(createTeamTaskDispatchTool(controller));
  registry.register(createTeamTaskDispatchBatchTool(controller));
  registry.register(createTeamTaskSyncTool(controller));
  registry.register(createTeamTaskReconcileTool(controller));
  registry.register(createTeamRunLoopTool(controller));
  registry.register(createTeamMessageSendTool(controller));
  registry.register(createTeamMessageListTool(controller));
  return registry;
}

function createExecutor(registry: InMemoryToolRegistry, approvals: ApprovalBrokerRequest[]): ToolExecutor {
  return new ToolExecutor({
    registry,
    events: { publish: async (_event: ChiliEvent) => undefined },
    approvals: {
      decide: async (request) => {
        approvals.push(request);
        return { action: "allow_once" };
      },
    },
    createId: createSequentialId(),
    now: () => 1 as TimestampMs,
  });
}

function toolInput(toolName: string, input: unknown, callId?: ToolCallId): ExecuteToolInput {
  const value: ExecuteToolInput = {
    sessionId: "session_tools" as SessionId,
    turnId: "turn_tools" as TurnId,
    toolName,
    input,
    cwd: process.cwd(),
  };
  if (callId) value.callId = callId;
  return value;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeTeamToolController implements TeamToolController, TeamTaskDispatchToolController, TeamRunLoopToolController {
  createTeamInputs: TeamCreateToolInput[] = [];
  teamListInputs: TeamListToolInput[] = [];
  snapshotInputs: TeamSnapshotToolInput[] = [];
  memberAddInputs: TeamMemberAddToolInput[] = [];
  memberListInputs: TeamMemberListToolInput[] = [];
  taskCreateInputs: TeamTaskCreateToolInput[] = [];
  taskListInputs: TeamTaskListToolInput[] = [];
  taskAssignInputs: TeamTaskAssignToolInput[] = [];
  taskClaimInputs: TeamTaskClaimToolInput[] = [];
  taskUpdateInputs: TeamTaskUpdateToolInput[] = [];
  taskDispatchInputs: TeamTaskDispatchToolInput[] = [];
  taskDispatchBatchInputs: TeamTaskDispatchBatchToolInput[] = [];
  taskSyncInputs: TeamTaskSyncToolInput[] = [];
  taskReconcileInputs: TeamTaskReconcileToolInput[] = [];
  teamRunLoopInputs: TeamRunLoopToolInput[] = [];
  messageSendInputs: TeamMessageSendToolInput[] = [];
  messageListInputs: TeamMessageListToolInput[] = [];
  dispatchDelayMs = 0;
  runningDispatches = 0;
  maxRunningDispatches = 0;

  async createTeam(input: TeamCreateToolInput, _context: TeamToolContext): Promise<TeamRecord> {
    this.createTeamInputs.push(input);
    return teamRecord(input);
  }

  async listTeams(input: TeamListToolInput): Promise<TeamRecord[]> {
    this.teamListInputs.push(input);
    return [teamRecord({ name: "Core team", leadPath: "/lead" })];
  }

  async snapshotTeam(input: TeamSnapshotToolInput): Promise<TeamSnapshotRecord> {
    this.snapshotInputs.push(input);
    return snapshotRecord(input.teamId);
  }

  async addMember(input: TeamMemberAddToolInput): Promise<TeamMemberRecord> {
    this.memberAddInputs.push(input);
    return memberRecord(input);
  }

  async listMembers(input: TeamMemberListToolInput): Promise<TeamMemberRecord[]> {
    this.memberListInputs.push(input);
    return [memberRecord({ teamId: input.teamId, path: "/worker", name: "Worker", role: "implementation" })];
  }

  async createTask(input: TeamTaskCreateToolInput): Promise<TeamTaskRecord> {
    this.taskCreateInputs.push(input);
    return taskRecord(input);
  }

  async listTasks(input: TeamTaskListToolInput): Promise<TeamTaskRecord[]> {
    this.taskListInputs.push(input);
    return [taskRecord({ teamId: input.teamId, ownerPath: input.ownerPath ?? "/worker", title: "Implement team tools" })];
  }

  async assignTask(input: TeamTaskAssignToolInput): Promise<TeamTaskRecord> {
    this.taskAssignInputs.push(input);
    return taskRecord(input);
  }

  async claimTask(input: TeamTaskClaimToolInput): Promise<TeamTaskClaimRecord> {
    this.taskClaimInputs.push(input);
    return { applied: true, task: taskRecord(input) };
  }

  async updateTask(input: TeamTaskUpdateToolInput): Promise<TeamTaskRecord> {
    this.taskUpdateInputs.push(input);
    return taskRecord(input);
  }

  async dispatchTask(input: TeamTaskDispatchToolInput): Promise<TeamTaskDispatchRecord> {
    this.runningDispatches++;
    this.maxRunningDispatches = Math.max(this.maxRunningDispatches, this.runningDispatches);
    this.taskDispatchInputs.push(input);
    try {
      if (this.dispatchDelayMs > 0) await sleepMs(this.dispatchDelayMs);
      const status = input.mode === "one_shot" ? "completed" : "running";
      const teamTaskInput: Partial<TeamTaskCreateToolInput & TeamTaskAssignToolInput & TeamTaskClaimToolInput & TeamTaskUpdateToolInput> = {
        teamId: input.teamId,
        taskId: input.taskId,
        status: "in_progress",
      };
      if (input.ownerPath) teamTaskInput.ownerPath = input.ownerPath;
      const agentTask: TeamDispatchAgentTaskRecord = {
        taskId: "agent_task",
        path: input.ownerPath ?? "/worker",
        runId: "run_team",
        childSessionId: "session_child",
        childThreadId: "thread_child",
        status,
      };
      if (status === "completed") agentTask.summary = "done";
      return {
        status,
        teamTask: taskRecord(teamTaskInput),
        agentTask,
      };
    } finally {
      this.runningDispatches--;
    }
  }

  async syncTask(input: TeamTaskSyncToolInput): Promise<TeamTaskSyncRecord> {
    this.taskSyncInputs.push(input);
    return {
      applied: true,
      teamTask: taskRecord({ teamId: input.teamId, taskId: input.taskId, status: "completed", summary: "done" }),
      agentTask: {
        taskId: "agent_task",
        path: "/worker",
        runId: "run_team",
        status: "completed",
        summary: "done",
      },
    };
  }

  async reconcileTasks(input: TeamTaskReconcileToolInput): Promise<TeamTaskReconcileRecord> {
    this.taskReconcileInputs.push(input);
    return {
      scanned: 2,
      synced: [
        {
          applied: true,
          teamTask: taskRecord({ teamId: input.teamId ?? "team_core", taskId: "task_team", status: "completed" }),
          agentTask: { taskId: "agent_task", status: "completed", summary: "done" },
        },
      ],
      skipped: [
        {
          applied: false,
          reason: "agent_running",
          teamTask: taskRecord({ teamId: input.teamId ?? "team_core", taskId: "task_running", status: "in_progress" }),
          agentTask: { taskId: "agent_running", status: "running" },
        },
      ],
      errors: [],
    };
  }

  async runTeam(input: TeamRunLoopToolInput): Promise<TeamRunLoopRecord> {
    this.teamRunLoopInputs.push(input);
    return {
      teamId: input.teamId,
      cycles: input.once === false ? 3 : 1,
      stopReason: input.once === false ? "drained" : "cycle_limit",
      startedAt: 1,
      endedAt: 2,
      maxConcurrentDispatches: input.maxConcurrentDispatches ?? 4,
      dispatched: [
        { teamId: input.teamId, taskId: "task_team", ownerPath: "/worker", agentTaskId: "agent_task", status: "running" },
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
        { teamId: input.teamId, taskId: "task_team", ownerPath: "/worker", title: "Implement team tools", agentTaskId: "agent_task" },
      ],
      errors: [],
    };
  }

  async sendMessage(input: TeamMessageSendToolInput): Promise<TeamMessageRecord> {
    this.messageSendInputs.push(input);
    return messageRecord(input);
  }

  async listMessages(input: TeamMessageListToolInput): Promise<TeamMessageRecord[]> {
    this.messageListInputs.push(input);
    return [messageRecord({ teamId: input.teamId, from: "/lead", to: input.path ?? "/worker", content: "Status check" })];
  }
}

function teamRecord(input: Partial<TeamCreateToolInput>): TeamRecord {
  return {
    teamId: input.teamId ?? ("team_core" as TeamId),
    name: input.name ?? "Core team",
    leadPath: (input.leadPath ?? "/lead") as AgentPath,
    status: "active",
    createdAt: 1,
    updatedAt: 2,
  };
}

function memberRecord(input: TeamMemberAddToolInput): TeamMemberRecord {
  return {
    teamId: input.teamId,
    path: input.path as AgentPath,
    name: input.name,
    role: input.role,
    status: input.status ?? "idle",
    ...(input.childSessionId ? { childSessionId: input.childSessionId } : {}),
    ...(input.toolScope ? { toolScope: input.toolScope } : {}),
    ...(input.writeScope ? { writeScope: input.writeScope } : {}),
    createdAt: 1,
    updatedAt: 2,
  };
}

function taskRecord(
  input: Partial<TeamTaskCreateToolInput & TeamTaskAssignToolInput & TeamTaskClaimToolInput & TeamTaskUpdateToolInput>,
): TeamTaskRecord {
  return {
    taskId: (input.taskId ?? "task_team") as TaskId,
    teamId: (input.teamId ?? "team_core") as TeamId,
    title: input.title ?? "Implement team tools",
    status: input.status ?? "in_progress",
    ownerPath: (input.ownerPath ?? "/worker") as AgentPath,
    dependsOn: input.dependsOn ?? [],
    ...(input.createdBy ? { createdBy: input.createdBy as AgentPath } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    createdAt: 1,
    updatedAt: 2,
  };
}

function messageRecord(input: TeamMessageSendToolInput): TeamMessageRecord {
  return {
    messageId: input.messageId ?? "message_team",
    teamId: input.teamId,
    fromPath: input.from as AgentPath,
    toPath: input.to as AgentPath | "*",
    content: input.content,
    kind: input.kind ?? "text",
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    createdAt: 1,
  };
}

function snapshotRecord(teamId: string): TeamSnapshotRecord {
  const member = memberRecord({ teamId, path: "/worker", name: "Worker", role: "implementation" });
  const task = taskRecord({ teamId, taskId: "task_team", ownerPath: "/worker", title: "Implement team tools", status: "pending" });
  const delivery = {
    mailboxMessageId: "mailbox_team",
    teamId,
    teamMessageId: "message_team",
    path: "/worker" as AgentPath,
    status: "queued" as const,
    triggerTurn: true,
    queuedAt: 1,
    updatedAt: 1,
  };
  return {
    team: teamRecord({ teamId, name: "Core team", leadPath: "/lead" }),
    members: [
      {
        ...member,
        taskIds: [task.taskId],
        deliveryIds: [delivery.mailboxMessageId],
      },
    ],
    tasks: [
      {
        ...task,
        blockedBy: [],
        blocks: [],
        ready: true,
        messageIds: ["message_team"],
        owner: member,
      },
    ],
    messages: [
      {
        ...messageRecord({
          teamId,
          messageId: "message_team",
          from: "/lead",
          to: "/worker",
          content: "Status check",
          delivery: "triggerTurn",
          taskId: task.taskId,
        }),
        deliveries: [delivery],
      },
    ],
    messageDeliveries: [delivery],
    stats: {
      memberCount: 1,
      taskCount: 1,
      messageCount: 1,
      deliveryCount: 1,
      membersByStatus: { idle: 1 },
      tasksByStatus: { pending: 1 },
      messagesByDeliveryStatus: { queued: 1 },
      deliveriesByStatus: { queued: 1 },
      readyTaskIds: [task.taskId],
      blockedTaskIds: [],
    },
    generatedAt: 1,
  };
}

function createSequentialId(): (prefix: string) => string {
  let index = 0;
  return (prefix) => `${prefix}_${++index}`;
}
