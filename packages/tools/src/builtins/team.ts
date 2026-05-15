import type { AgentPath, ToolResult } from "@chili/protocol";
import { ROOT_AGENT_PATH, normalizeAgentPath } from "@chili/protocol";
import type { ChiliToolDefinition, ValidationResult } from "../types.js";
import type {
  TeamCreateToolInput,
  TeamListToolInput,
  TeamMemberAddToolInput,
  TeamMemberListToolInput,
  TeamMemberRecord,
  TeamMessageListToolInput,
  TeamMessageRecord,
  TeamMessageSendToolInput,
  TeamRecord,
  TeamSnapshotRecord,
  TeamSnapshotToolInput,
  TeamTaskAssignToolInput,
  TeamTaskClaimRecord,
  TeamTaskClaimToolInput,
  TeamTaskCreateBatchRecord,
  TeamTaskCreateBatchToolInput,
  TeamTaskCreateToolInput,
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
  TeamMemberStatus,
  TeamMessageDelivery,
  TeamMessageKind,
  TeamTaskDispatchBatchErrorRecord,
  TeamTaskDispatchBatchRecord,
  TeamTaskDispatchBatchToolInput,
  TeamTaskStatus,
  TeamRunLoopRecord,
  TeamRunLoopToolController,
  TeamRunLoopToolInput,
} from "../team.js";

export interface TeamToolResult extends ToolResult {
  metadata: Record<string, unknown>;
}

const MAX_TEAM_TASK_CREATE_BATCH_TASKS = 64;
const DEFAULT_TEAM_DISPATCH_BATCH_CONCURRENCY = 8;
const MAX_TEAM_DISPATCH_BATCH_CONCURRENCY = 32;
const MAX_TEAM_DISPATCH_BATCH_TASKS = 64;
const MAX_TEAM_RUN_LOOP_CONCURRENCY = 64;
const MAX_TEAM_RUN_LOOP_VERIFICATIONS = 4;

export function createTeamCreateTool(controller: TeamToolController): ChiliToolDefinition<TeamCreateToolInput, TeamToolResult> {
  return {
    name: "team_create",
    aliases: ["create_team"],
    description: "Create a persistent agent team with a leader member.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        name: { type: "string" },
        leadPath: { type: "string" },
        lead_path: { type: "string" },
        description: { type: "string" },
        leadName: { type: "string" },
        lead_name: { type: "string" },
        leadRole: { type: "string" },
        lead_role: { type: "string" },
        leadStatus: { type: "string" },
        lead_status: { type: "string" },
        leadWriteScope: { type: "array", items: { type: "string" } },
        lead_write_scope: { type: "array", items: { type: "string" } },
      },
    },
    validate: validateTeamCreateInput,
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { name: input.name, leadPath: input.leadPath } });
      return teamRecordToolResult("team_create", await controller.createTeam(input, context));
    },
  };
}

export function createTeamListTool(controller: TeamToolController): ChiliToolDefinition<TeamListToolInput, TeamToolResult> {
  return {
    name: "team_list",
    aliases: ["list_teams"],
    description: "List persistent agent teams.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "archived"] },
        limit: { type: "number" },
      },
    },
    validate: validateTeamListInput,
    approval: () => false,
    async execute(input, context) {
      return teamListToolResult(await controller.listTeams(input, context));
    },
  };
}

export function createTeamSnapshotTool(controller: TeamToolController): ChiliToolDefinition<TeamSnapshotToolInput, TeamToolResult> {
  return {
    name: "team_snapshot",
    aliases: ["snapshot_team", "team_status"],
    description: "Read a joined snapshot of a team, including members, tasks, messages, deliveries, and board stats.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      required: ["teamId"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
      },
    },
    validate: validateTeamSnapshotInput,
    approval: () => false,
    async execute(input, context) {
      return teamSnapshotToolResult(await controller.snapshotTeam(input, context));
    },
  };
}

export function createTeamMemberAddTool(
  controller: TeamToolController,
): ChiliToolDefinition<TeamMemberAddToolInput, TeamToolResult> {
  return {
    name: "team_member_add",
    aliases: ["add_team_member"],
    description: "Add or update a persistent team member record.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["teamId", "path", "name", "role"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        path: { type: "string" },
        name: { type: "string" },
        role: { type: "string" },
        status: { type: "string" },
        childSessionId: { type: "string" },
        child_session_id: { type: "string" },
        childThreadId: { type: "string" },
        child_thread_id: { type: "string" },
        model: { type: "string" },
        toolScope: { type: "array", items: { type: "string" } },
        tool_scope: { type: "array", items: { type: "string" } },
        writeScope: { type: "array", items: { type: "string" } },
        write_scope: { type: "array", items: { type: "string" } },
      },
    },
    validate: validateTeamMemberAddInput,
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { teamId: input.teamId, team_id: input.teamId, path: input.path } });
      return teamMemberRecordToolResult("team_member_add", await controller.addMember(input, context));
    },
  };
}

export function createTeamMemberListTool(
  controller: TeamToolController,
): ChiliToolDefinition<TeamMemberListToolInput, TeamToolResult> {
  return {
    name: "team_member_list",
    aliases: ["list_team_members"],
    description: "List members in a persistent agent team.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      required: ["teamId"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        status: { type: "string" },
        limit: { type: "number" },
      },
    },
    validate: validateTeamMemberListInput,
    approval: () => false,
    async execute(input, context) {
      return teamMemberListToolResult(await controller.listMembers(input, context));
    },
  };
}

export function createTeamTaskCreateTool(
  controller: TeamToolController,
): ChiliToolDefinition<TeamTaskCreateToolInput, TeamToolResult> {
  return {
    name: "team_task_create",
    aliases: ["create_team_task"],
    description: "Create a task on a persistent team task board. Declare writeScope, executeScope, and requiredTools when they are known so independent tasks can run in parallel safely.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["teamId", "title"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        taskId: { type: "string" },
        task_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        createdBy: { type: "string" },
        created_by: { type: "string" },
        ownerPath: { type: "string" },
        owner_path: { type: "string" },
        dependsOn: { type: "array", items: { type: "string" } },
        depends_on: { type: "array", items: { type: "string" } },
        status: { type: "string" },
        metadata: { type: "object" },
        writeScope: { type: "array", items: { type: "string" } },
        write_scope: { type: "array", items: { type: "string" } },
        executeScope: { type: "array", items: { type: "string" } },
        execute_scope: { type: "array", items: { type: "string" } },
        requiredTools: { type: "array", items: { type: "string" } },
        required_tools: { type: "array", items: { type: "string" } },
        suggestedTestCommands: { type: "array", items: { type: "string" } },
        suggested_test_commands: { type: "array", items: { type: "string" } },
      },
    },
    validate: validateTeamTaskCreateInput,
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { teamId: input.teamId, team_id: input.teamId, title: input.title } });
      return teamTaskRecordToolResult("team_task_create", await controller.createTask(input, context));
    },
  };
}

export function createTeamTaskCreateBatchTool(
  controller: TeamToolController,
): ChiliToolDefinition<TeamTaskCreateBatchToolInput, TeamToolResult> {
  return {
    name: "team_task_create_batch",
    aliases: ["create_team_tasks", "team_tasks_create"],
    description: "Create multiple persistent team tasks in one call. Prefer this when planning independent slices; include writeScope, executeScope, and requiredTools for each task.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["teamId", "tasks"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        createdBy: { type: "string" },
        created_by: { type: "string" },
        tasks: {
          type: "array",
          items: {
            type: "object",
            required: ["title"],
            properties: {
              taskId: { type: "string" },
              task_id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              createdBy: { type: "string" },
              created_by: { type: "string" },
              ownerPath: { type: "string" },
              owner_path: { type: "string" },
              dependsOn: { type: "array", items: { type: "string" } },
              depends_on: { type: "array", items: { type: "string" } },
              status: { type: "string" },
              metadata: { type: "object" },
              writeScope: { type: "array", items: { type: "string" } },
              write_scope: { type: "array", items: { type: "string" } },
              executeScope: { type: "array", items: { type: "string" } },
              execute_scope: { type: "array", items: { type: "string" } },
              requiredTools: { type: "array", items: { type: "string" } },
              required_tools: { type: "array", items: { type: "string" } },
              suggestedTestCommands: { type: "array", items: { type: "string" } },
              suggested_test_commands: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    validate: validateTeamTaskCreateBatchInput,
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { teamId: input.teamId, team_id: input.teamId, count: input.tasks.length } });
      const tasks: TeamTaskRecord[] = [];
      for (const task of input.tasks) {
        tasks.push(await controller.createTask({ ...task, teamId: input.teamId }, context));
      }
      return teamTaskCreateBatchToolResult({ count: tasks.length, tasks });
    },
  };
}

export function createTeamTaskListTool(
  controller: TeamToolController,
): ChiliToolDefinition<TeamTaskListToolInput, TeamToolResult> {
  return {
    name: "team_task_list",
    aliases: ["list_team_tasks", "team_tasks"],
    description: "List tasks on a persistent team task board.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      required: ["teamId"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        status: { type: "string" },
        ownerPath: { type: "string" },
        owner_path: { type: "string" },
        limit: { type: "number" },
      },
    },
    validate: validateTeamTaskListInput,
    approval: () => false,
    async execute(input, context) {
      return teamTaskListToolResult(await controller.listTasks(input, context));
    },
  };
}

export function createTeamTaskAssignTool(
  controller: TeamToolController,
): ChiliToolDefinition<TeamTaskAssignToolInput, TeamToolResult> {
  return {
    name: "team_task_assign",
    aliases: ["assign_team_task"],
    description: "Assign a team task to a team member.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["teamId", "taskId", "ownerPath"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        taskId: { type: "string" },
        task_id: { type: "string" },
        ownerPath: { type: "string" },
        owner_path: { type: "string" },
        assignedBy: { type: "string" },
        assigned_by: { type: "string" },
        message: { type: "string" },
        messageDelivery: { type: "string", enum: ["queueOnly", "triggerTurn"] },
        message_delivery: { type: "string", enum: ["queueOnly", "triggerTurn"] },
        delivery: { type: "string", enum: ["queueOnly", "triggerTurn"] },
        messageSummary: { type: "string" },
        message_summary: { type: "string" },
      },
    },
    validate: validateTeamTaskAssignInput,
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { teamId: input.teamId, team_id: input.teamId, taskId: input.taskId, task_id: input.taskId } });
      return teamTaskRecordToolResult("team_task_assign", await controller.assignTask(input, context));
    },
  };
}

export function createTeamTaskClaimTool(
  controller: TeamToolController,
): ChiliToolDefinition<TeamTaskClaimToolInput, TeamToolResult> {
  return {
    name: "team_task_claim",
    aliases: ["claim_team_task"],
    description: "Atomically claim a pending unblocked team task for a team member.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["teamId", "taskId", "ownerPath"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        taskId: { type: "string" },
        task_id: { type: "string" },
        ownerPath: { type: "string" },
        owner_path: { type: "string" },
        claimedBy: { type: "string" },
        claimed_by: { type: "string" },
      },
    },
    validate: validateTeamTaskClaimInput,
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { teamId: input.teamId, team_id: input.teamId, taskId: input.taskId, task_id: input.taskId } });
      return teamTaskClaimToolResult(await controller.claimTask(input, context));
    },
  };
}

export function createTeamTaskUpdateTool(
  controller: TeamToolController,
): ChiliToolDefinition<TeamTaskUpdateToolInput, TeamToolResult> {
  return {
    name: "team_task_update",
    aliases: ["update_team_task"],
    description: "Update status, owner, summary, or metadata for a team task.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["teamId", "taskId"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        taskId: { type: "string" },
        task_id: { type: "string" },
        status: { type: "string" },
        ownerPath: { type: "string" },
        owner_path: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        dependsOn: { type: "array", items: { type: "string" } },
        depends_on: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
        error: { type: "string" },
        metadata: { type: "object" },
      },
    },
    validate: validateTeamTaskUpdateInput,
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { teamId: input.teamId, team_id: input.teamId, taskId: input.taskId, task_id: input.taskId } });
      return teamTaskRecordToolResult("team_task_update", await controller.updateTask(input, context));
    },
  };
}

export function createTeamTaskDispatchTool(
  controller: TeamTaskDispatchToolController,
): ChiliToolDefinition<TeamTaskDispatchToolInput, TeamToolResult> {
  return {
    name: "team_task_dispatch",
    aliases: ["dispatch_team_task", "team_dispatch"],
    description: "Dispatch a persistent team task to its assigned local subagent.",
    risk: "execute",
    isConcurrencySafe(input) {
      return isBackgroundDispatchInput(input);
    },
    inputSchema: {
      type: "object",
      required: ["teamId", "taskId"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        taskId: { type: "string" },
        task_id: { type: "string" },
        ownerPath: { type: "string" },
        owner_path: { type: "string" },
        mode: { type: "string", enum: ["one_shot", "resumable", "background"] },
        prompt: { type: "string" },
      },
    },
    validate: validateTeamTaskDispatchInput,
    approval(input) {
      return {
        permission: "team_task_dispatch",
        patterns: [input.teamId, input.taskId, input.mode ?? "background"],
        metadata: {
          teamId: input.teamId,
          team_id: input.teamId,
          taskId: input.taskId,
          task_id: input.taskId,
          ownerPath: input.ownerPath,
          owner_path: input.ownerPath,
          mode: input.mode ?? "background",
          promptPreview: input.prompt ? preview(input.prompt) : undefined,
        },
      };
    },
    async execute(input, context) {
      await context.metadata({
        metadata: {
          teamId: input.teamId,
          team_id: input.teamId,
          taskId: input.taskId,
          task_id: input.taskId,
          ownerPath: input.ownerPath,
          owner_path: input.ownerPath,
          mode: input.mode ?? "background",
        },
      });
      return teamTaskDispatchToolResult(await controller.dispatchTask(input, context));
    },
  };
}

export function createTeamTaskDispatchBatchTool(
  controller: TeamTaskDispatchToolController,
): ChiliToolDefinition<TeamTaskDispatchBatchToolInput, TeamToolResult> {
  return {
    name: "team_task_dispatch_batch",
    aliases: ["dispatch_team_tasks", "team_dispatch_batch"],
    description: "Dispatch multiple persistent team tasks to background local subagents in parallel.",
    risk: "execute",
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      required: ["teamId"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        tasks: {
          type: "array",
          items: {
            type: "object",
            required: ["taskId"],
            properties: {
              taskId: { type: "string" },
              task_id: { type: "string" },
              id: { type: "string" },
              ownerPath: { type: "string" },
              owner_path: { type: "string" },
              prompt: { type: "string" },
              message: { type: "string" },
            },
          },
        },
        taskIds: { type: "array", items: { type: "string" } },
        task_ids: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["background"] },
        maxConcurrency: { type: "number" },
        max_concurrency: { type: "number" },
      },
    },
    validate: validateTeamTaskDispatchBatchInput,
    approval(input) {
      return {
        permission: "team_task_dispatch",
        patterns: [input.teamId, `count:${input.tasks.length}`, `concurrency:${input.maxConcurrency ?? DEFAULT_TEAM_DISPATCH_BATCH_CONCURRENCY}`, "background"],
        metadata: {
          teamId: input.teamId,
          team_id: input.teamId,
          taskIds: input.tasks.map((task) => task.taskId),
          task_ids: input.tasks.map((task) => task.taskId),
          mode: "background",
          count: input.tasks.length,
          maxConcurrency: input.maxConcurrency ?? DEFAULT_TEAM_DISPATCH_BATCH_CONCURRENCY,
          max_concurrency: input.maxConcurrency ?? DEFAULT_TEAM_DISPATCH_BATCH_CONCURRENCY,
        },
      };
    },
    async execute(input, context) {
      await context.metadata({
        metadata: {
          teamId: input.teamId,
          team_id: input.teamId,
          taskIds: input.tasks.map((task) => task.taskId),
          task_ids: input.tasks.map((task) => task.taskId),
          count: input.tasks.length,
          maxConcurrency: input.maxConcurrency ?? DEFAULT_TEAM_DISPATCH_BATCH_CONCURRENCY,
          max_concurrency: input.maxConcurrency ?? DEFAULT_TEAM_DISPATCH_BATCH_CONCURRENCY,
        },
      });
      const result = await runTeamTaskDispatchBatch(input, context, (task) =>
        controller.dispatchTask(
          {
            teamId: input.teamId,
            taskId: task.taskId,
            ...(task.ownerPath ? { ownerPath: task.ownerPath } : {}),
            mode: "background",
            ...(task.prompt ? { prompt: task.prompt } : {}),
          },
          context,
        )
      );
      return teamTaskDispatchBatchToolResult(result);
    },
  };
}

export function createTeamTaskSyncTool(
  controller: TeamTaskDispatchToolController,
): ChiliToolDefinition<TeamTaskSyncToolInput, TeamToolResult> {
  return {
    name: "team_task_sync",
    aliases: ["sync_team_task"],
    description: "Sync a dispatched team task from its bound local subagent result.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["teamId", "taskId"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        taskId: { type: "string" },
        task_id: { type: "string" },
      },
    },
    validate: validateTeamTaskSyncInput,
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { teamId: input.teamId, team_id: input.teamId, taskId: input.taskId, task_id: input.taskId } });
      return teamTaskSyncToolResult(await controller.syncTask(input, context));
    },
  };
}

export function createTeamTaskReconcileTool(
  controller: TeamTaskDispatchToolController,
): ChiliToolDefinition<TeamTaskReconcileToolInput, TeamToolResult> {
  return {
    name: "team_task_reconcile",
    aliases: ["reconcile_team_tasks", "team_reconcile"],
    description: "Reconcile dispatched in-progress team tasks with their local subagent task state.",
    risk: "write",
    isConcurrencySafe: false,
    inputSchema: {
      type: "object",
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        limit: { type: "number" },
      },
    },
    validate: validateTeamTaskReconcileInput,
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { teamId: input.teamId, team_id: input.teamId, limit: input.limit } });
      return teamTaskReconcileToolResult(await controller.reconcileTasks(input, context));
    },
  };
}

export function createTeamRunLoopTool(
  controller: TeamRunLoopToolController,
): ChiliToolDefinition<TeamRunLoopToolInput, TeamToolResult> {
  return {
    name: "team_run_loop",
    aliases: ["run_team", "team_run"],
    description:
      "Run the persistent team scheduler: reconcile running tasks, auto-assign scoped pending tasks, dispatch eligible tasks in parallel, and verify or merge completed work. Defaults to one scheduling cycle; set until_drained to run until stable.",
    risk: "execute",
    inputSchema: {
      type: "object",
      required: ["teamId"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        mode: { type: "string", enum: ["one_shot", "resumable", "background"] },
        once: { type: "boolean" },
        untilDrained: { type: "boolean" },
        until_drained: { type: "boolean" },
        maxCycles: { type: "number" },
        max_cycles: { type: "number" },
        timeoutMs: { type: "number" },
        timeout_ms: { type: "number" },
        pollIntervalMs: { type: "number" },
        poll_interval_ms: { type: "number" },
        maxConcurrentDispatches: { type: "number" },
        max_concurrent_dispatches: { type: "number" },
        maxConcurrentVerifications: { type: "number" },
        max_concurrent_verifications: { type: "number" },
      },
    },
    validate: validateTeamRunLoopInput,
    approval(input) {
      return {
        permission: "team_run_loop",
        patterns: [
          input.teamId,
          `once:${input.once ?? true}`,
          `drain:${input.untilDrained ?? input.once === false}`,
          `concurrency:${input.maxConcurrentDispatches ?? "default"}`,
          `verify:${input.maxConcurrentVerifications ?? "default"}`,
          input.mode ?? "background",
        ],
        metadata: {
          teamId: input.teamId,
          team_id: input.teamId,
          mode: input.mode ?? "background",
          once: input.once ?? true,
          untilDrained: input.untilDrained ?? input.once === false,
          until_drained: input.untilDrained ?? input.once === false,
          maxCycles: input.maxCycles,
          max_cycles: input.maxCycles,
          timeoutMs: input.timeoutMs,
          timeout_ms: input.timeoutMs,
          pollIntervalMs: input.pollIntervalMs,
          poll_interval_ms: input.pollIntervalMs,
          maxConcurrentDispatches: input.maxConcurrentDispatches,
          max_concurrent_dispatches: input.maxConcurrentDispatches,
          maxConcurrentVerifications: input.maxConcurrentVerifications,
          max_concurrent_verifications: input.maxConcurrentVerifications,
        },
      };
    },
    async execute(input, context) {
      await context.metadata({
        metadata: {
          teamId: input.teamId,
          team_id: input.teamId,
          mode: input.mode ?? "background",
          once: input.once ?? true,
          untilDrained: input.untilDrained ?? input.once === false,
          until_drained: input.untilDrained ?? input.once === false,
          maxConcurrentDispatches: input.maxConcurrentDispatches,
          max_concurrent_dispatches: input.maxConcurrentDispatches,
          maxConcurrentVerifications: input.maxConcurrentVerifications,
          max_concurrent_verifications: input.maxConcurrentVerifications,
        },
      });
      return teamRunLoopToolResult(await controller.runTeam(input, context));
    },
  };
}

export function createTeamMessageSendTool(
  controller: TeamToolController,
): ChiliToolDefinition<TeamMessageSendToolInput, TeamToolResult> {
  return {
    name: "team_message_send",
    aliases: ["send_team_message", "send_message"],
    description: "Send a durable message to a team member or broadcast to the team.",
    risk: "write",
    inputSchema: {
      type: "object",
      required: ["teamId", "from", "to", "content"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        messageId: { type: "string" },
        message_id: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        content: { type: "string" },
        text: { type: "string" },
        kind: { type: "string" },
        delivery: { type: "string", enum: ["queueOnly", "triggerTurn"] },
        messageDelivery: { type: "string", enum: ["queueOnly", "triggerTurn"] },
        message_delivery: { type: "string", enum: ["queueOnly", "triggerTurn"] },
        taskId: { type: "string" },
        task_id: { type: "string" },
        summary: { type: "string" },
        metadata: { type: "object" },
      },
    },
    validate: validateTeamMessageSendInput,
    approval: () => false,
    async execute(input, context) {
      await context.metadata({ metadata: { teamId: input.teamId, team_id: input.teamId, to: input.to, kind: input.kind ?? "text" } });
      return teamMessageRecordToolResult("team_message_send", await controller.sendMessage(input, context));
    },
  };
}

export function createTeamMessageListTool(
  controller: TeamToolController,
): ChiliToolDefinition<TeamMessageListToolInput, TeamToolResult> {
  return {
    name: "team_message_list",
    aliases: ["list_team_messages"],
    description: "List durable team messages for a team, member path, or task.",
    risk: "read",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object",
      required: ["teamId"],
      properties: {
        teamId: { type: "string" },
        team_id: { type: "string" },
        path: { type: "string" },
        taskId: { type: "string" },
        task_id: { type: "string" },
        limit: { type: "number" },
      },
    },
    validate: validateTeamMessageListInput,
    approval: () => false,
    async execute(input, context) {
      return teamMessageListToolResult(await controller.listMessages(input, context));
    },
  };
}

function validateTeamCreateInput(input: unknown): ValidationResult<TeamCreateToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const name = requiredString(input, ["name"], "name");
  if (!name.ok) return name;
  const leadPath = optionalPath(input, ["leadPath", "lead_path"], "leadPath");
  if (!leadPath.ok) return leadPath;
  const status = normalizeMemberStatus(input.leadStatus ?? input.lead_status);
  if (!status.ok) return status;
  const writeScope = optionalStringArray(input.leadWriteScope ?? input.lead_write_scope, "leadWriteScope");
  if (!writeScope.ok) return writeScope;

  const value: TeamCreateToolInput = { name: name.value, leadPath: leadPath.value ?? ROOT_AGENT_PATH };
  assignString(value, "teamId", pickString(input, ["teamId", "team_id"]));
  assignString(value, "description", pickString(input, ["description"]));
  assignString(value, "leadName", pickString(input, ["leadName", "lead_name"]));
  assignString(value, "leadRole", pickString(input, ["leadRole", "lead_role"]));
  if (status.value) value.leadStatus = status.value;
  if (writeScope.value) value.leadWriteScope = writeScope.value;
  return { ok: true, value };
}

function validateTeamListInput(input: unknown): ValidationResult<TeamListToolInput> {
  const record = optionalRecord(input);
  if (!record.ok) return record;
  const status = record.value.status;
  if (status !== undefined && status !== "active" && status !== "archived") {
    return { ok: false, message: "status must be active or archived" };
  }
  const limit = optionalPositiveInteger(record.value.limit, "limit");
  if (!limit.ok) return limit;
  const value: TeamListToolInput = {};
  if (status) value.status = status;
  if (limit.value !== undefined) value.limit = limit.value;
  return { ok: true, value };
}

function validateTeamSnapshotInput(input: unknown): ValidationResult<TeamSnapshotToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  return { ok: true, value: { teamId: teamId.value } };
}

function validateTeamMemberAddInput(input: unknown): ValidationResult<TeamMemberAddToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const path = requiredPath(input, ["path"], "path");
  if (!path.ok) return path;
  const name = requiredString(input, ["name"], "name");
  if (!name.ok) return name;
  const role = requiredString(input, ["role"], "role");
  if (!role.ok) return role;
  const status = normalizeMemberStatus(input.status);
  if (!status.ok) return status;
  const toolScope = optionalStringArray(input.toolScope ?? input.tool_scope, "toolScope");
  if (!toolScope.ok) return toolScope;
  const writeScope = optionalStringArray(input.writeScope ?? input.write_scope, "writeScope");
  if (!writeScope.ok) return writeScope;

  const value: TeamMemberAddToolInput = { teamId: teamId.value, path: path.value, name: name.value, role: role.value };
  if (status.value) value.status = status.value;
  assignString(value, "childSessionId", pickString(input, ["childSessionId", "child_session_id"]));
  assignString(value, "childThreadId", pickString(input, ["childThreadId", "child_thread_id"]));
  assignString(value, "model", pickString(input, ["model"]));
  if (toolScope.value) value.toolScope = toolScope.value;
  if (writeScope.value) value.writeScope = writeScope.value;
  return { ok: true, value };
}

function validateTeamMemberListInput(input: unknown): ValidationResult<TeamMemberListToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const status = normalizeMemberStatus(input.status);
  if (!status.ok) return status;
  const limit = optionalPositiveInteger(input.limit, "limit");
  if (!limit.ok) return limit;
  const value: TeamMemberListToolInput = { teamId: teamId.value };
  if (status.value) value.status = status.value;
  if (limit.value !== undefined) value.limit = limit.value;
  return { ok: true, value };
}

function validateTeamTaskCreateInput(input: unknown): ValidationResult<TeamTaskCreateToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const task = validateTeamTaskCreateFields(input, "task");
  if (!task.ok) return task;
  return { ok: true, value: { ...task.value, teamId: teamId.value } };
}

function validateTeamTaskCreateBatchInput(input: unknown): ValidationResult<TeamTaskCreateBatchToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const createdBy = optionalPath(input, ["createdBy", "created_by"], "createdBy");
  if (!createdBy.ok) return createdBy;
  if (!Array.isArray(input.tasks)) return { ok: false, message: "tasks must be an array" };
  if (input.tasks.length === 0) return { ok: false, message: "tasks must include at least one task" };
  if (input.tasks.length > MAX_TEAM_TASK_CREATE_BATCH_TASKS) {
    return { ok: false, message: `tasks cannot include more than ${MAX_TEAM_TASK_CREATE_BATCH_TASKS} tasks` };
  }

  const tasks: TeamTaskCreateBatchToolInput["tasks"] = [];
  for (let index = 0; index < input.tasks.length; index++) {
    const raw = input.tasks[index];
    if (!isRecord(raw)) return { ok: false, message: `tasks[${index}] must be an object` };
    const task = validateTeamTaskCreateFields(raw, `tasks[${index}]`);
    if (!task.ok) return task;
    tasks.push(createdBy.value && !task.value.createdBy ? { ...task.value, createdBy: createdBy.value } : task.value);
  }

  const value: TeamTaskCreateBatchToolInput = { teamId: teamId.value, tasks };
  if (createdBy.value) value.createdBy = createdBy.value;
  return { ok: true, value };
}

function validateTeamTaskCreateFields(
  input: Record<string, unknown>,
  name: string,
): ValidationResult<Omit<TeamTaskCreateToolInput, "teamId">> {
  const title = requiredString(input, ["title", "subject"], `${name}.title`);
  if (!title.ok) return title;
  const createdBy = optionalPath(input, ["createdBy", "created_by"], "createdBy");
  if (!createdBy.ok) return createdBy;
  const ownerPath = optionalPath(input, ["ownerPath", "owner_path"], "ownerPath");
  if (!ownerPath.ok) return ownerPath;
  const dependsOn = optionalStringArray(input.dependsOn ?? input.depends_on, "dependsOn");
  if (!dependsOn.ok) return dependsOn;
  const status = normalizeTeamTaskStatus(input.status);
  if (!status.ok) return status;
  const metadata = optionalPlainObject(input.metadata, "metadata");
  if (!metadata.ok) return metadata;
  const writeScope = optionalStringArray(input.writeScope ?? input.write_scope, "writeScope");
  if (!writeScope.ok) return writeScope;
  const executeScope = optionalStringArray(input.executeScope ?? input.execute_scope, "executeScope");
  if (!executeScope.ok) return executeScope;
  const requiredTools = optionalStringArray(input.requiredTools ?? input.required_tools, "requiredTools");
  if (!requiredTools.ok) return requiredTools;
  const suggestedTestCommands = optionalStringArray(
    input.suggestedTestCommands ?? input.suggested_test_commands,
    "suggestedTestCommands",
  );
  if (!suggestedTestCommands.ok) return suggestedTestCommands;

  const value: Omit<TeamTaskCreateToolInput, "teamId"> = { title: title.value };
  assignString(value, "taskId", pickString(input, ["taskId", "task_id"]));
  assignString(value, "description", pickString(input, ["description"]));
  if (createdBy.value) value.createdBy = createdBy.value;
  if (ownerPath.value) value.ownerPath = ownerPath.value;
  if (dependsOn.value) value.dependsOn = dependsOn.value;
  if (status.value) value.status = status.value;
  if (writeScope.value) value.writeScope = writeScope.value;
  if (executeScope.value) value.executeScope = executeScope.value;
  if (requiredTools.value) value.requiredTools = requiredTools.value;
  if (suggestedTestCommands.value) value.suggestedTestCommands = suggestedTestCommands.value;
  const scopedMetadata = taskMetadataWithScopes(metadata.value, value);
  if (scopedMetadata) value.metadata = scopedMetadata;
  return { ok: true, value };
}

function validateTeamTaskListInput(input: unknown): ValidationResult<TeamTaskListToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const status = normalizeTeamTaskStatus(input.status);
  if (!status.ok) return status;
  const ownerPath = optionalPath(input, ["ownerPath", "owner_path"], "ownerPath");
  if (!ownerPath.ok) return ownerPath;
  const limit = optionalPositiveInteger(input.limit, "limit");
  if (!limit.ok) return limit;
  const value: TeamTaskListToolInput = { teamId: teamId.value };
  if (status.value) value.status = status.value;
  if (ownerPath.value) value.ownerPath = ownerPath.value;
  if (limit.value !== undefined) value.limit = limit.value;
  return { ok: true, value };
}

function validateTeamTaskAssignInput(input: unknown): ValidationResult<TeamTaskAssignToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const base = validateTeamTaskOwnerInput(input);
  if (!base.ok) return base;
  const assignedBy = optionalPath(input, ["assignedBy", "assigned_by"], "assignedBy");
  if (!assignedBy.ok) return assignedBy;
  const delivery = normalizeMessageDelivery(input.messageDelivery ?? input.message_delivery ?? input.delivery);
  if (!delivery.ok) return delivery;
  const value: TeamTaskAssignToolInput = { ...base.value };
  if (assignedBy.value) value.assignedBy = assignedBy.value;
  assignString(value, "message", pickString(input, ["message", "content", "text"]));
  if (delivery.value) value.messageDelivery = delivery.value;
  assignString(value, "messageSummary", pickString(input, ["messageSummary", "message_summary", "summary"]));
  return { ok: true, value };
}

function validateTeamTaskClaimInput(input: unknown): ValidationResult<TeamTaskClaimToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const base = validateTeamTaskOwnerInput(input);
  if (!base.ok) return base;
  const claimedBy = optionalPath(input, ["claimedBy", "claimed_by"], "claimedBy");
  if (!claimedBy.ok) return claimedBy;
  const value: TeamTaskClaimToolInput = { ...base.value };
  if (claimedBy.value) value.claimedBy = claimedBy.value;
  return { ok: true, value };
}

function validateTeamTaskUpdateInput(input: unknown): ValidationResult<TeamTaskUpdateToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const taskId = requiredString(input, ["taskId", "task_id", "id"], "taskId");
  if (!taskId.ok) return taskId;
  const status = normalizeTeamTaskStatus(input.status);
  if (!status.ok) return status;
  const ownerPath = optionalPath(input, ["ownerPath", "owner_path"], "ownerPath");
  if (!ownerPath.ok) return ownerPath;
  const dependsOn = optionalStringArray(input.dependsOn ?? input.depends_on, "dependsOn");
  if (!dependsOn.ok) return dependsOn;
  const metadata = optionalPlainObject(input.metadata, "metadata");
  if (!metadata.ok) return metadata;
  const value: TeamTaskUpdateToolInput = { teamId: teamId.value, taskId: taskId.value };
  if (status.value) value.status = status.value;
  if (ownerPath.value) value.ownerPath = ownerPath.value;
  assignString(value, "title", pickString(input, ["title"]));
  assignString(value, "description", pickString(input, ["description"]));
  if (dependsOn.value) value.dependsOn = dependsOn.value;
  assignString(value, "summary", pickString(input, ["summary"]));
  assignString(value, "error", pickString(input, ["error"]));
  if (metadata.value) value.metadata = metadata.value;
  return { ok: true, value };
}

function validateTeamTaskDispatchInput(input: unknown): ValidationResult<TeamTaskDispatchToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const taskId = requiredString(input, ["taskId", "task_id", "id"], "taskId");
  if (!taskId.ok) return taskId;
  const ownerPath = optionalPath(input, ["ownerPath", "owner_path"], "ownerPath");
  if (!ownerPath.ok) return ownerPath;
  const mode = normalizeDispatchMode(input.mode);
  if (!mode.ok) return mode;
  const value: TeamTaskDispatchToolInput = { teamId: teamId.value, taskId: taskId.value };
  if (ownerPath.value) value.ownerPath = ownerPath.value;
  if (mode.value) value.mode = mode.value;
  assignString(value, "prompt", pickString(input, ["prompt", "message"]));
  return { ok: true, value };
}

function validateTeamTaskDispatchBatchInput(input: unknown): ValidationResult<TeamTaskDispatchBatchToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const mode = normalizeDispatchMode(input.mode);
  if (!mode.ok) return mode;
  if (mode.value && mode.value !== "background") {
    return { ok: false, message: "mode must be background for team_task_dispatch_batch" };
  }
  const tasks = normalizeDispatchBatchTasks(input.tasks ?? input.taskIds ?? input.task_ids);
  if (!tasks.ok) return tasks;
  if (tasks.value.length === 0) return { ok: false, message: "tasks must include at least one task" };
  if (tasks.value.length > MAX_TEAM_DISPATCH_BATCH_TASKS) {
    return { ok: false, message: `tasks cannot include more than ${MAX_TEAM_DISPATCH_BATCH_TASKS} tasks` };
  }
  const maxConcurrency = optionalPositiveInteger(input.maxConcurrency ?? input.max_concurrency, "maxConcurrency");
  if (!maxConcurrency.ok) return maxConcurrency;
  if (maxConcurrency.value !== undefined && maxConcurrency.value > MAX_TEAM_DISPATCH_BATCH_CONCURRENCY) {
    return { ok: false, message: `maxConcurrency cannot exceed ${MAX_TEAM_DISPATCH_BATCH_CONCURRENCY}` };
  }
  const value: TeamTaskDispatchBatchToolInput = {
    teamId: teamId.value,
    tasks: tasks.value,
    mode: "background",
  };
  if (maxConcurrency.value !== undefined) value.maxConcurrency = maxConcurrency.value;
  return { ok: true, value };
}

function validateTeamTaskSyncInput(input: unknown): ValidationResult<TeamTaskSyncToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const taskId = requiredString(input, ["taskId", "task_id", "id"], "taskId");
  if (!taskId.ok) return taskId;
  return { ok: true, value: { teamId: teamId.value, taskId: taskId.value } };
}

function validateTeamTaskReconcileInput(input: unknown): ValidationResult<TeamTaskReconcileToolInput> {
  const record = optionalRecord(input);
  if (!record.ok) return record;
  const limit = optionalPositiveInteger(record.value.limit, "limit");
  if (!limit.ok) return limit;
  const value: TeamTaskReconcileToolInput = {};
  assignString(value, "teamId", pickString(record.value, ["teamId", "team_id"]));
  if (limit.value !== undefined) value.limit = limit.value;
  return { ok: true, value };
}

function validateTeamRunLoopInput(input: unknown): ValidationResult<TeamRunLoopToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const mode = normalizeDispatchMode(input.mode);
  if (!mode.ok) return mode;
  const once = optionalBoolean(input.once, "once");
  if (!once.ok) return once;
  const untilDrained = optionalBoolean(input.untilDrained ?? input.until_drained, "untilDrained");
  if (!untilDrained.ok) return untilDrained;
  if (untilDrained.value === true && once.value === true) {
    return { ok: false, message: "untilDrained cannot be combined with once:true" };
  }
  const maxCycles = optionalPositiveInteger(input.maxCycles ?? input.max_cycles, "maxCycles");
  if (!maxCycles.ok) return maxCycles;
  const timeoutMs = optionalPositiveInteger(input.timeoutMs ?? input.timeout_ms, "timeoutMs");
  if (!timeoutMs.ok) return timeoutMs;
  const pollIntervalMs = optionalPositiveInteger(input.pollIntervalMs ?? input.poll_interval_ms, "pollIntervalMs");
  if (!pollIntervalMs.ok) return pollIntervalMs;
  const maxConcurrentDispatches = optionalPositiveInteger(
    input.maxConcurrentDispatches ?? input.max_concurrent_dispatches,
    "maxConcurrentDispatches",
  );
  if (!maxConcurrentDispatches.ok) return maxConcurrentDispatches;
  if (maxConcurrentDispatches.value !== undefined && maxConcurrentDispatches.value > MAX_TEAM_RUN_LOOP_CONCURRENCY) {
    return { ok: false, message: `maxConcurrentDispatches cannot exceed ${MAX_TEAM_RUN_LOOP_CONCURRENCY}` };
  }
  const maxConcurrentVerifications = optionalPositiveInteger(
    input.maxConcurrentVerifications ?? input.max_concurrent_verifications,
    "maxConcurrentVerifications",
  );
  if (!maxConcurrentVerifications.ok) return maxConcurrentVerifications;
  if (maxConcurrentVerifications.value !== undefined && maxConcurrentVerifications.value > MAX_TEAM_RUN_LOOP_VERIFICATIONS) {
    return { ok: false, message: `maxConcurrentVerifications cannot exceed ${MAX_TEAM_RUN_LOOP_VERIFICATIONS}` };
  }

  const value: TeamRunLoopToolInput = {
    teamId: teamId.value,
    once: untilDrained.value === true || once.value === false ? false : once.value ?? true,
  };
  if (untilDrained.value === true || once.value === false) value.untilDrained = true;
  if (mode.value) value.mode = mode.value;
  if (maxCycles.value !== undefined) value.maxCycles = maxCycles.value;
  if (timeoutMs.value !== undefined) value.timeoutMs = timeoutMs.value;
  if (pollIntervalMs.value !== undefined) value.pollIntervalMs = pollIntervalMs.value;
  if (maxConcurrentDispatches.value !== undefined) value.maxConcurrentDispatches = maxConcurrentDispatches.value;
  if (maxConcurrentVerifications.value !== undefined) value.maxConcurrentVerifications = maxConcurrentVerifications.value;
  return { ok: true, value };
}

function validateTeamMessageSendInput(input: unknown): ValidationResult<TeamMessageSendToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const from = requiredPath(input, ["from"], "from");
  if (!from.ok) return from;
  const to = requiredTeamMessageTarget(input, ["to"], "to");
  if (!to.ok) return to;
  const content = requiredString(input, ["content", "text", "message"], "content");
  if (!content.ok) return content;
  const kind = normalizeMessageKind(input.kind);
  if (!kind.ok) return kind;
  const delivery = normalizeMessageDelivery(input.delivery ?? input.messageDelivery ?? input.message_delivery);
  if (!delivery.ok) return delivery;
  const metadata = optionalPlainObject(input.metadata, "metadata");
  if (!metadata.ok) return metadata;
  const value: TeamMessageSendToolInput = { teamId: teamId.value, from: from.value, to: to.value, content: content.value };
  assignString(value, "messageId", pickString(input, ["messageId", "message_id"]));
  if (kind.value) value.kind = kind.value;
  if (delivery.value) value.delivery = delivery.value;
  assignString(value, "taskId", pickString(input, ["taskId", "task_id"]));
  assignString(value, "summary", pickString(input, ["summary"]));
  if (metadata.value) value.metadata = metadata.value;
  return { ok: true, value };
}

function validateTeamMessageListInput(input: unknown): ValidationResult<TeamMessageListToolInput> {
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const path = optionalPath(input, ["path"], "path");
  if (!path.ok) return path;
  const limit = optionalPositiveInteger(input.limit, "limit");
  if (!limit.ok) return limit;
  const value: TeamMessageListToolInput = { teamId: teamId.value };
  if (path.value) value.path = path.value;
  assignString(value, "taskId", pickString(input, ["taskId", "task_id"]));
  if (limit.value !== undefined) value.limit = limit.value;
  return { ok: true, value };
}

function validateTeamTaskOwnerInput(input: Record<string, unknown>): ValidationResult<TeamTaskAssignToolInput> {
  const teamId = requiredString(input, ["teamId", "team_id"], "teamId");
  if (!teamId.ok) return teamId;
  const taskId = requiredString(input, ["taskId", "task_id", "id"], "taskId");
  if (!taskId.ok) return taskId;
  const ownerPath = requiredPath(input, ["ownerPath", "owner_path"], "ownerPath");
  if (!ownerPath.ok) return ownerPath;
  return { ok: true, value: { teamId: teamId.value, taskId: taskId.value, ownerPath: ownerPath.value } };
}

function teamRecordToolResult(title: string, team: TeamRecord): TeamToolResult {
  return {
    title: `${title} ${team.teamId}`,
    output: JSON.stringify(teamRecordOutput(team)),
    metadata: { team_id: team.teamId, teamId: team.teamId, name: team.name },
  };
}

function teamListToolResult(teams: readonly TeamRecord[]): TeamToolResult {
  return {
    title: `team_list ${teams.length}`,
    output: JSON.stringify({ count: teams.length, teams: teams.map(teamRecordOutput) }),
    metadata: { count: teams.length },
  };
}

function teamSnapshotToolResult(snapshot: TeamSnapshotRecord): TeamToolResult {
  return {
    title: `team_snapshot ${snapshot.team.teamId}`,
    output: JSON.stringify(teamSnapshotRecordOutput(snapshot)),
    metadata: {
      team_id: snapshot.team.teamId,
      teamId: snapshot.team.teamId,
      members: snapshot.members.length,
      tasks: snapshot.tasks.length,
      messages: snapshot.messages.length,
      deliveries: snapshot.messageDeliveries.length,
      ready_tasks: snapshot.stats.readyTaskIds.length,
      readyTasks: snapshot.stats.readyTaskIds.length,
      blocked_tasks: snapshot.stats.blockedTaskIds.length,
      blockedTasks: snapshot.stats.blockedTaskIds.length,
    },
  };
}

function teamMemberRecordToolResult(title: string, member: TeamMemberRecord): TeamToolResult {
  return {
    title: `${title} ${member.path}`,
    output: JSON.stringify(teamMemberRecordOutput(member)),
    metadata: { team_id: member.teamId, teamId: member.teamId, path: member.path, status: member.status },
  };
}

function teamMemberListToolResult(members: readonly TeamMemberRecord[]): TeamToolResult {
  return {
    title: `team_member_list ${members.length}`,
    output: JSON.stringify({ count: members.length, members: members.map(teamMemberRecordOutput) }),
    metadata: { count: members.length },
  };
}

function teamTaskRecordToolResult(title: string, task: TeamTaskRecord): TeamToolResult {
  return {
    title: `${title} ${task.taskId}`,
    output: JSON.stringify(teamTaskRecordOutput(task)),
    metadata: { team_id: task.teamId, teamId: task.teamId, task_id: task.taskId, taskId: task.taskId, status: task.status },
  };
}

function teamTaskCreateBatchToolResult(result: TeamTaskCreateBatchRecord): TeamToolResult {
  return {
    title: `team_task_create_batch ${result.count}`,
    output: JSON.stringify({ count: result.count, tasks: result.tasks.map(teamTaskRecordOutput) }),
    metadata: {
      count: result.count,
      task_ids: result.tasks.map((task) => task.taskId),
      taskIds: result.tasks.map((task) => task.taskId),
    },
  };
}

function teamTaskListToolResult(tasks: readonly TeamTaskRecord[]): TeamToolResult {
  return {
    title: `team_task_list ${tasks.length}`,
    output: JSON.stringify({ count: tasks.length, tasks: tasks.map(teamTaskRecordOutput) }),
    metadata: { count: tasks.length },
  };
}

function teamTaskClaimToolResult(claim: TeamTaskClaimRecord): TeamToolResult {
  const output = pruneUndefined({
    applied: claim.applied,
    reason: claim.reason,
    task: claim.task ? teamTaskRecordOutput(claim.task) : undefined,
  });
  return {
    title: claim.applied ? `team_task_claim ${claim.task?.taskId ?? ""}` : `team_task_claim ${claim.reason ?? "failed"}`,
    output: JSON.stringify(output),
    metadata: {
      applied: claim.applied,
      reason: claim.reason ?? "",
      task_id: claim.task?.taskId ?? "",
      taskId: claim.task?.taskId ?? "",
    },
  };
}

function teamTaskDispatchToolResult(result: TeamTaskDispatchRecord): TeamToolResult {
  const output = teamTaskDispatchOutput(result);
  return {
    title: `team_task_dispatch ${result.teamTask.taskId} ${result.status}`,
    output: JSON.stringify(output),
    metadata: {
      team_id: result.teamTask.teamId,
      teamId: result.teamTask.teamId,
      task_id: result.teamTask.taskId,
      taskId: result.teamTask.taskId,
      status: result.status,
      reason: result.reason ?? "",
      agent_task_id: result.agentTask?.taskId ?? "",
      agentTaskId: result.agentTask?.taskId ?? "",
    },
  };
}

function teamTaskDispatchBatchToolResult(result: TeamTaskDispatchBatchRecord): TeamToolResult {
  const output = {
    count: result.count,
    dispatched: result.dispatched.map(teamTaskDispatchOutput),
    errors: result.errors.map((error) => pruneUndefined({
      task_id: error.taskId,
      taskId: error.taskId,
      owner_path: error.ownerPath,
      ownerPath: error.ownerPath,
      error: error.error,
    })),
  };
  return {
    title: `team_task_dispatch_batch dispatched=${result.dispatched.length} errors=${result.errors.length}`,
    output: JSON.stringify(output),
    metadata: {
      count: result.count,
      dispatched: result.dispatched.length,
      errors: result.errors.length,
      task_ids: result.dispatched.map((item) => item.teamTask.taskId),
      taskIds: result.dispatched.map((item) => item.teamTask.taskId),
    },
  };
}

function teamTaskSyncToolResult(result: TeamTaskSyncRecord): TeamToolResult {
  const output = teamTaskSyncOutput(result);
  return {
    title: result.applied ? `team_task_sync ${result.teamTask.taskId}` : `team_task_sync ${result.reason ?? "skipped"}`,
    output: JSON.stringify(output),
    metadata: {
      applied: result.applied,
      reason: result.reason ?? "",
      team_id: result.teamTask.teamId,
      teamId: result.teamTask.teamId,
      task_id: result.teamTask.taskId,
      taskId: result.teamTask.taskId,
      agent_task_id: result.agentTask?.taskId ?? "",
      agentTaskId: result.agentTask?.taskId ?? "",
    },
  };
}

function teamTaskReconcileToolResult(result: TeamTaskReconcileRecord): TeamToolResult {
  const output = {
    scanned: result.scanned,
    synced: result.synced.map(teamTaskSyncOutput),
    skipped: result.skipped.map(teamTaskSyncOutput),
    errors: result.errors.map((error) => ({
      team_id: error.teamId,
      teamId: error.teamId,
      task_id: error.taskId,
      taskId: error.taskId,
      error: error.error,
    })),
  };
  return {
    title: `team_task_reconcile scanned=${result.scanned} synced=${result.synced.length} skipped=${result.skipped.length} errors=${result.errors.length}`,
    output: JSON.stringify(output),
    metadata: {
      scanned: result.scanned,
      synced: result.synced.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
    },
  };
}

function teamRunLoopToolResult(result: TeamRunLoopRecord): TeamToolResult {
  const bottleneck = teamRunLoopBottleneck(result);
  return {
    title: `team_run_loop ${result.teamId} stop=${result.stopReason} bottleneck=${bottleneck} fanout=${result.maxConcurrentDispatches ?? "default"} verify=${result.maxConcurrentVerifications ?? "default"} dispatched=${result.dispatched.length} running=${result.stillRunning.length}`,
    output: JSON.stringify(teamRunLoopOutput(result)),
    metadata: {
      team_id: result.teamId,
      teamId: result.teamId,
      stop_reason: result.stopReason,
      stopReason: result.stopReason,
      bottleneck,
      cycles: result.cycles,
      max_concurrent_dispatches: result.maxConcurrentDispatches,
      maxConcurrentDispatches: result.maxConcurrentDispatches,
      max_concurrent_verifications: result.maxConcurrentVerifications,
      maxConcurrentVerifications: result.maxConcurrentVerifications,
      dispatched: result.dispatched.length,
      completed: result.completed.length,
      accepted: result.accepted.length,
      reopened: result.reopened.length,
      merged: result.merged.length,
      merge_failed: result.mergeFailed.length,
      mergeFailed: result.mergeFailed.length,
      merge_conflicted: result.mergeConflicted.length,
      mergeConflicted: result.mergeConflicted.length,
      merge_skipped: result.mergeSkipped.length,
      mergeSkipped: result.mergeSkipped.length,
      failed: result.failed.length,
      blocked: result.blocked.length,
      skipped: result.skipped.length,
      still_running: result.stillRunning.length,
      stillRunning: result.stillRunning.length,
      errors: result.errors.length,
    },
  };
}

function teamRunLoopBottleneck(result: TeamRunLoopRecord): string {
  if (result.errors.length > 0) return "errors";
  if (result.mergeConflicted.length > 0) return "merge-conflict";
  if (result.mergeFailed.length > 0) return "merge-failed";
  if (result.reopened.length > 0) return "verify-failed";
  if (result.blocked.some((item) => item.reason !== "dependency_incomplete")) return "blocked";
  if (
    result.maxConcurrentDispatches !== undefined &&
    result.maxConcurrentDispatches > 0 &&
    result.stillRunning.length >= result.maxConcurrentDispatches
  ) {
    return "fanout-full";
  }
  if (result.stillRunning.length > 0) return "workers-running";
  if (result.blocked.length > 0) return "waiting-dependencies";
  if (result.completed.length > 0 && result.accepted.length === 0 && result.merged.length === 0) return "verify-pending";
  if (result.stopReason === "timeout") return "timeout";
  if (result.stopReason === "max_cycles") return "max-cycles";
  if (result.stopReason === "drained") return "drained";
  if (result.stopReason === "once") return "one-cycle";
  return result.stopReason;
}

function teamMessageRecordToolResult(title: string, message: TeamMessageRecord): TeamToolResult {
  return {
    title: `${title} ${message.messageId}`,
    output: JSON.stringify(teamMessageRecordOutput(message)),
    metadata: { team_id: message.teamId, teamId: message.teamId, message_id: message.messageId, messageId: message.messageId },
  };
}

function teamMessageListToolResult(messages: readonly TeamMessageRecord[]): TeamToolResult {
  return {
    title: `team_message_list ${messages.length}`,
    output: JSON.stringify({ count: messages.length, messages: messages.map(teamMessageRecordOutput) }),
    metadata: { count: messages.length },
  };
}

async function runTeamTaskDispatchBatch(
  input: TeamTaskDispatchBatchToolInput,
  context: TeamToolContext,
  dispatch: (task: TeamTaskDispatchBatchToolInput["tasks"][number]) => Promise<TeamTaskDispatchRecord>,
): Promise<TeamTaskDispatchBatchRecord> {
  const maxConcurrency = input.maxConcurrency ?? DEFAULT_TEAM_DISPATCH_BATCH_CONCURRENCY;
  const dispatched = new Array<TeamTaskDispatchRecord | undefined>(input.tasks.length);
  const errors = new Array<TeamTaskDispatchBatchErrorRecord | undefined>(input.tasks.length);
  let next = 0;

  const workerCount = Math.min(maxConcurrency, input.tasks.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < input.tasks.length) {
      throwIfAborted(context.signal);
      const index = next++;
      const task = input.tasks[index];
      if (!task) continue;
      try {
        dispatched[index] = await dispatch(task);
      } catch (error) {
        if (isAbortError(error)) throw error;
        errors[index] = {
          taskId: task.taskId,
          ...(task.ownerPath ? { ownerPath: task.ownerPath } : {}),
          error: toErrorMessage(error),
        };
      }
    }
  }));

  return {
    count: input.tasks.length,
    dispatched: dispatched.filter((item): item is TeamTaskDispatchRecord => item !== undefined),
    errors: errors.filter((item): item is TeamTaskDispatchBatchErrorRecord => item !== undefined),
  };
}

function teamRecordOutput(team: TeamRecord): Record<string, unknown> {
  return pruneUndefined({
    team_id: team.teamId,
    teamId: team.teamId,
    name: team.name,
    lead_path: team.leadPath,
    leadPath: team.leadPath,
    status: team.status,
    session_id: team.sessionId,
    sessionId: team.sessionId,
    description: team.description,
    created_at: team.createdAt,
    createdAt: team.createdAt,
    updated_at: team.updatedAt,
    updatedAt: team.updatedAt,
  });
}

function teamSnapshotRecordOutput(snapshot: TeamSnapshotRecord): Record<string, unknown> {
  const messageDeliveries = snapshot.messageDeliveries.map(teamMessageDeliveryRecordOutput);
  return pruneUndefined({
    team: teamRecordOutput(snapshot.team),
    members: snapshot.members.map(teamSnapshotMemberRecordOutput),
    tasks: snapshot.tasks.map(teamSnapshotTaskRecordOutput),
    messages: snapshot.messages.map(teamSnapshotMessageRecordOutput),
    message_deliveries: messageDeliveries,
    messageDeliveries,
    stats: snapshot.stats,
    generated_at: snapshot.generatedAt,
    generatedAt: snapshot.generatedAt,
  });
}

function teamSnapshotMemberRecordOutput(member: TeamSnapshotRecord["members"][number]): Record<string, unknown> {
  return pruneUndefined({
    ...teamMemberRecordOutput(member),
    task_ids: member.taskIds,
    taskIds: member.taskIds,
    delivery_ids: member.deliveryIds,
    deliveryIds: member.deliveryIds,
    current_task: member.currentTask ? teamTaskRecordOutput(member.currentTask) : undefined,
    currentTask: member.currentTask ? teamTaskRecordOutput(member.currentTask) : undefined,
  });
}

function teamSnapshotTaskRecordOutput(task: TeamSnapshotRecord["tasks"][number]): Record<string, unknown> {
  return pruneUndefined({
    ...teamTaskRecordOutput(task),
    blocked_by: task.blockedBy,
    blockedBy: task.blockedBy,
    blocks: task.blocks,
    ready: task.ready,
    message_ids: task.messageIds,
    messageIds: task.messageIds,
    owner: task.owner ? teamMemberRecordOutput(task.owner) : undefined,
    dispatch: task.dispatch,
  });
}

function teamSnapshotMessageRecordOutput(message: TeamSnapshotRecord["messages"][number]): Record<string, unknown> {
  return pruneUndefined({
    ...teamMessageRecordOutput(message),
    deliveries: message.deliveries.map(teamMessageDeliveryRecordOutput),
  });
}

function teamMemberRecordOutput(member: TeamMemberRecord): Record<string, unknown> {
  return pruneUndefined({
    team_id: member.teamId,
    teamId: member.teamId,
    path: member.path,
    name: member.name,
    role: member.role,
    status: member.status,
    child_session_id: member.childSessionId,
    childSessionId: member.childSessionId,
    child_thread_id: member.childThreadId,
    childThreadId: member.childThreadId,
    model: member.model,
    tool_scope: member.toolScope,
    toolScope: member.toolScope,
    write_scope: member.writeScope,
    writeScope: member.writeScope,
    current_task_id: member.currentTaskId,
    currentTaskId: member.currentTaskId,
    created_at: member.createdAt,
    createdAt: member.createdAt,
    updated_at: member.updatedAt,
    updatedAt: member.updatedAt,
    closed_at: member.closedAt,
    closedAt: member.closedAt,
  });
}

function teamTaskRecordOutput(task: TeamTaskRecord): Record<string, unknown> {
  return pruneUndefined({
    task_id: task.taskId,
    taskId: task.taskId,
    team_id: task.teamId,
    teamId: task.teamId,
    title: task.title,
    description: task.description,
    status: task.status,
    owner_path: task.ownerPath,
    ownerPath: task.ownerPath,
    created_by: task.createdBy,
    createdBy: task.createdBy,
    depends_on: task.dependsOn,
    dependsOn: task.dependsOn,
    summary: task.summary,
    error: task.error,
    metadata: task.metadata,
    created_at: task.createdAt,
    createdAt: task.createdAt,
    updated_at: task.updatedAt,
    updatedAt: task.updatedAt,
    completed_at: task.completedAt,
    completedAt: task.completedAt,
  });
}

function teamTaskDispatchOutput(result: TeamTaskDispatchRecord): Record<string, unknown> {
  return pruneUndefined({
    status: result.status,
    reason: result.reason,
    team_task: teamTaskRecordOutput(result.teamTask),
    teamTask: teamTaskRecordOutput(result.teamTask),
    agent_task: result.agentTask ? agentTaskRecordOutput(result.agentTask) : undefined,
    agentTask: result.agentTask ? agentTaskRecordOutput(result.agentTask) : undefined,
  });
}

function teamTaskSyncOutput(result: TeamTaskSyncRecord): Record<string, unknown> {
  return pruneUndefined({
    applied: result.applied,
    reason: result.reason,
    team_task: teamTaskRecordOutput(result.teamTask),
    teamTask: teamTaskRecordOutput(result.teamTask),
    agent_task: result.agentTask ? agentTaskRecordOutput(result.agentTask) : undefined,
    agentTask: result.agentTask ? agentTaskRecordOutput(result.agentTask) : undefined,
  });
}

function teamRunLoopOutput(result: TeamRunLoopRecord): Record<string, unknown> {
  return {
    team_id: result.teamId,
    teamId: result.teamId,
    cycles: result.cycles,
    stop_reason: result.stopReason,
    stopReason: result.stopReason,
    bottleneck: teamRunLoopBottleneck(result),
    started_at: result.startedAt,
    startedAt: result.startedAt,
    ended_at: result.endedAt,
    endedAt: result.endedAt,
    max_concurrent_dispatches: result.maxConcurrentDispatches,
    maxConcurrentDispatches: result.maxConcurrentDispatches,
    max_concurrent_verifications: result.maxConcurrentVerifications,
    maxConcurrentVerifications: result.maxConcurrentVerifications,
    dispatched: result.dispatched.map(teamRunTaskOutput),
    completed: result.completed.map(teamRunTaskOutput),
    accepted: result.accepted.map(teamRunTaskOutput),
    reopened: result.reopened.map(teamRunTaskOutput),
    merged: result.merged.map(teamRunTaskOutput),
    merge_failed: result.mergeFailed.map(teamRunTaskOutput),
    mergeFailed: result.mergeFailed.map(teamRunTaskOutput),
    merge_conflicted: result.mergeConflicted.map(teamRunTaskOutput),
    mergeConflicted: result.mergeConflicted.map(teamRunTaskOutput),
    merge_skipped: result.mergeSkipped.map(teamRunTaskOutput),
    mergeSkipped: result.mergeSkipped.map(teamRunTaskOutput),
    failed: result.failed.map(teamRunTaskOutput),
    blocked: result.blocked.map(teamRunTaskOutput),
    skipped: result.skipped.map(teamRunTaskOutput),
    still_running: result.stillRunning.map(teamRunTaskOutput),
    stillRunning: result.stillRunning.map(teamRunTaskOutput),
    errors: result.errors.map(teamRunTaskOutput),
  };
}

function teamRunTaskOutput(task: object): Record<string, unknown> {
  const record = task as Record<string, unknown>;
  return pruneUndefined({
    ...record,
    team_id: record.teamId,
    teamId: record.teamId,
    task_id: record.taskId,
    taskId: record.taskId,
    owner_path: record.ownerPath,
    ownerPath: record.ownerPath,
    agent_task_id: record.agentTaskId,
    agentTaskId: record.agentTaskId,
    verifier_task_id: record.verifierTaskId,
    verifierTaskId: record.verifierTaskId,
    diff_summary: record.diffSummary,
    diffSummary: record.diffSummary,
    blocked_by: record.blockedBy,
    blockedBy: record.blockedBy,
  });
}

function agentTaskRecordOutput(task: NonNullable<TeamTaskDispatchRecord["agentTask"]>): Record<string, unknown> {
  return pruneUndefined({
    task_id: task.taskId,
    taskId: task.taskId,
    path: task.path,
    run_id: task.runId,
    runId: task.runId,
    child_session_id: task.childSessionId,
    childSessionId: task.childSessionId,
    child_thread_id: task.childThreadId,
    childThreadId: task.childThreadId,
    status: task.status,
    summary: task.summary,
    error: task.error,
  });
}

function teamMessageRecordOutput(message: TeamMessageRecord): Record<string, unknown> {
  return pruneUndefined({
    message_id: message.messageId,
    messageId: message.messageId,
    team_id: message.teamId,
    teamId: message.teamId,
    from_path: message.fromPath,
    fromPath: message.fromPath,
    to_path: message.toPath,
    toPath: message.toPath,
    content: message.content,
    kind: message.kind,
    delivery: message.delivery,
    delivery_status: message.deliveryStatus,
    deliveryStatus: message.deliveryStatus,
    delivery_error: message.deliveryError,
    deliveryError: message.deliveryError,
    delivery_updated_at: message.deliveryUpdatedAt,
    deliveryUpdatedAt: message.deliveryUpdatedAt,
    delivered_at: message.deliveredAt,
    deliveredAt: message.deliveredAt,
    task_id: message.taskId,
    taskId: message.taskId,
    summary: message.summary,
    metadata: message.metadata,
    created_at: message.createdAt,
    createdAt: message.createdAt,
  });
}

function teamMessageDeliveryRecordOutput(delivery: TeamSnapshotRecord["messageDeliveries"][number]): Record<string, unknown> {
  return pruneUndefined({
    mailbox_message_id: delivery.mailboxMessageId,
    mailboxMessageId: delivery.mailboxMessageId,
    team_id: delivery.teamId,
    teamId: delivery.teamId,
    team_message_id: delivery.teamMessageId,
    teamMessageId: delivery.teamMessageId,
    path: delivery.path,
    status: delivery.status,
    trigger_turn: delivery.triggerTurn,
    triggerTurn: delivery.triggerTurn,
    child_session_id: delivery.childSessionId,
    childSessionId: delivery.childSessionId,
    child_thread_id: delivery.childThreadId,
    childThreadId: delivery.childThreadId,
    error: delivery.error,
    queued_at: delivery.queuedAt,
    queuedAt: delivery.queuedAt,
    updated_at: delivery.updatedAt,
    updatedAt: delivery.updatedAt,
    delivered_at: delivery.deliveredAt,
    deliveredAt: delivery.deliveredAt,
  });
}

function requiredString(
  record: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): ValidationResult<string> {
  const value = pickString(record, keys);
  if (value === undefined) return { ok: false, message: `${name} must be a non-empty string` };
  return { ok: true, value };
}

function requiredPath(
  record: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): ValidationResult<string> {
  const value = pickString(record, keys);
  if (value === undefined) return { ok: false, message: `${name} must be a non-empty absolute agent path` };
  return normalizePath(value, name);
}

function optionalPath(
  record: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): ValidationResult<string | undefined> {
  const value = pickString(record, keys);
  if (value === undefined) return { ok: true, value: undefined };
  return normalizePath(value, name);
}

function requiredTeamMessageTarget(
  record: Record<string, unknown>,
  keys: readonly string[],
  name: string,
): ValidationResult<string | "*"> {
  const value = pickString(record, keys);
  if (value === undefined) return { ok: false, message: `${name} must be a non-empty agent path or *` };
  if (value === "*") return { ok: true, value };
  return normalizePath(value, name);
}

function normalizePath(value: string, name: string): ValidationResult<AgentPath> {
  try {
    return { ok: true, value: normalizeAgentPath(value) };
  } catch {
    return { ok: false, message: `${name} must be an absolute agent path` };
  }
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function assignString<T extends object, K extends keyof T>(target: T, key: K, value: string | undefined): void {
  if (value !== undefined) target[key] = value as T[K];
}

function normalizeMemberStatus(value: unknown): ValidationResult<TeamMemberStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "member status must be a string" };
  switch (value.trim().toLowerCase()) {
    case "idle":
    case "running":
    case "waiting":
    case "blocked":
    case "closed":
      return { ok: true, value: value.trim().toLowerCase() as TeamMemberStatus };
    default:
      return { ok: false, message: "member status must be idle, running, waiting, blocked, or closed" };
  }
}

function normalizeTeamTaskStatus(value: unknown): ValidationResult<TeamTaskStatus | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "task status must be a string" };
  switch (value.trim().toLowerCase()) {
    case "pending":
    case "in_progress":
    case "blocked":
    case "completed":
    case "failed":
    case "cancelled":
      return { ok: true, value: value.trim().toLowerCase() as TeamTaskStatus };
    case "in-progress":
    case "running":
      return { ok: true, value: "in_progress" };
    case "canceled":
      return { ok: true, value: "cancelled" };
    default:
      return { ok: false, message: "task status must be pending, in_progress, blocked, completed, failed, or cancelled" };
  }
}

function normalizeDispatchMode(value: unknown): ValidationResult<TeamTaskDispatchToolInput["mode"] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "mode must be a string" };
  switch (value.trim().toLowerCase()) {
    case "one_shot":
    case "resumable":
    case "background":
      return { ok: true, value: value.trim().toLowerCase() as TeamTaskDispatchToolInput["mode"] };
    case "one-shot":
      return { ok: true, value: "one_shot" };
    default:
      return { ok: false, message: "mode must be one_shot, resumable, or background" };
  }
}

function isBackgroundDispatchInput(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const mode = normalizeDispatchMode(input.mode);
  if (!mode.ok) return false;
  return (mode.value ?? "background") === "background";
}

function normalizeDispatchBatchTasks(value: unknown): ValidationResult<TeamTaskDispatchBatchToolInput["tasks"]> {
  if (!Array.isArray(value)) return { ok: false, message: "tasks must be an array" };
  const tasks: TeamTaskDispatchBatchToolInput["tasks"] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const taskId = item.trim();
      if (taskId.length === 0) return { ok: false, message: "tasks must include non-empty task ids" };
      tasks.push({ taskId });
      continue;
    }
    if (!isRecord(item)) return { ok: false, message: "tasks must contain task ids or objects" };
    const taskId = requiredString(item, ["taskId", "task_id", "id"], "taskId");
    if (!taskId.ok) return taskId;
    const ownerPath = optionalPath(item, ["ownerPath", "owner_path"], "ownerPath");
    if (!ownerPath.ok) return ownerPath;
    const task: TeamTaskDispatchBatchToolInput["tasks"][number] = { taskId: taskId.value };
    if (ownerPath.value) task.ownerPath = ownerPath.value;
    assignString(task, "prompt", pickString(item, ["prompt", "message"]));
    tasks.push(task);
  }
  return { ok: true, value: tasks };
}

function taskMetadataWithScopes(
  metadata: Record<string, unknown> | undefined,
  input: Pick<TeamTaskCreateToolInput, "writeScope" | "executeScope" | "requiredTools" | "suggestedTestCommands">,
): Record<string, unknown> | undefined {
  const output = metadata ? { ...metadata } : {};
  let changed = false;
  if (input.writeScope) {
    output.writeScope = input.writeScope;
    changed = true;
  }
  if (input.executeScope) {
    output.executeScope = input.executeScope;
    changed = true;
  }
  if (input.requiredTools) {
    output.requiredTools = input.requiredTools;
    changed = true;
  }
  if (input.suggestedTestCommands) {
    output.suggestedTestCommands = input.suggestedTestCommands;
    changed = true;
  }
  return changed || metadata ? output : undefined;
}

function normalizeMessageKind(value: unknown): ValidationResult<TeamMessageKind | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "message kind must be a string" };
  switch (value.trim().toLowerCase()) {
    case "text":
    case "task_assignment":
    case "system":
      return { ok: true, value: value.trim().toLowerCase() as TeamMessageKind };
    case "task-assignment":
    case "assignment":
      return { ok: true, value: "task_assignment" };
    default:
      return { ok: false, message: "message kind must be text, task_assignment, or system" };
  }
}

function normalizeMessageDelivery(value: unknown): ValidationResult<TeamMessageDelivery | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, message: "message delivery must be a string" };
  switch (value.trim().toLowerCase()) {
    case "queueonly":
    case "queue_only":
    case "queue-only":
    case "queue":
    case "mailbox":
    case "mailbox_only":
    case "mailbox-only":
      return { ok: true, value: "queueOnly" };
    case "triggerturn":
    case "trigger_turn":
    case "trigger-turn":
    case "wake":
    case "run":
    case "start_turn":
    case "start-turn":
      return { ok: true, value: "triggerTurn" };
    default:
      return { ok: false, message: "message delivery must be queueOnly or triggerTurn" };
  }
}

function optionalRecord(input: unknown): ValidationResult<Record<string, unknown>> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (!isRecord(input)) return { ok: false, message: "expected an object" };
  return { ok: true, value: input };
}

function optionalPositiveInteger(value: unknown, name: string): ValidationResult<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { ok: false, message: `${name} must be a positive integer` };
  }
  return { ok: true, value };
}

function optionalBoolean(value: unknown, name: string): ValidationResult<boolean | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "boolean") return { ok: false, message: `${name} must be a boolean` };
  return { ok: true, value };
}

function optionalStringArray(value: unknown, name: string): ValidationResult<string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    return { ok: false, message: `${name} must be an array of non-empty strings` };
  }
  return { ok: true, value: value.map((item) => item.trim()) };
}

function optionalPlainObject(value: unknown, name: string): ValidationResult<Record<string, unknown> | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value)) return { ok: false, message: `${name} must be an object` };
  return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pruneUndefined<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = item;
  }
  return output as T;
}

function preview(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError("Team task dispatch batch aborted");
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  const err = error instanceof Error ? error : new Error(String(error));
  return err.name === "AbortError" || err.message.toLowerCase().includes("aborted");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
