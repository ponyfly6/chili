import type { AgentPath, SessionId, TaskId, TeamId } from "@chili/protocol";
import type { ToolAccessPolicy } from "@chili/tools";

export interface WorkerToolPolicy extends ToolAccessPolicy {
  teamId?: TeamId;
  taskId?: TaskId;
  memberPath?: AgentPath;
  parentSessionId?: SessionId;
  childSessionId?: SessionId;
}

export type WorkerToolPolicyTemplate = Omit<WorkerToolPolicy, "childSessionId">;

export const SCOPED_WORKER_BASE_TOOLS = [
  "read",
  "glob",
  "grep",
  "git_diff",
  "code_mode",
  "tool_search",
  "activate_skill",
  "complete_task",
  "agent_send",
  "agent_list",
  "team_snapshot",
  "team_task_list",
  "team_task_update",
  "team_message_send",
  "team_message_list",
] as const;

export const SCOPED_WORKER_WRITE_TOOLS = ["edit", "write", "apply_patch"] as const;
export const SCOPED_WORKER_EXECUTE_TOOLS = ["bash"] as const;

export function defaultScopedWorkerPolicy(): WorkerToolPolicy {
  return {
    allowedTools: [...SCOPED_WORKER_BASE_TOOLS],
    writeScope: [],
    executeScope: [],
  };
}

export function completeWorkerToolPolicy(
  template: WorkerToolPolicyTemplate,
  childSessionId: SessionId,
): WorkerToolPolicy {
  return {
    ...template,
    // Composition is a baseline capability; nested calls still use this policy.
    ...(template.allowedTools ? { allowedTools: [...new Set([...normalizeWorkerMessagingTools(template.allowedTools), "code_mode"])] } : {}),
    ...(template.deniedTools ? { deniedTools: normalizeWorkerMessagingTools(template.deniedTools) } : {}),
    childSessionId,
  };
}

function normalizeWorkerMessagingTools(tools: readonly string[]): string[] {
  return [...new Set(tools.map((tool) => {
    if (tool === "agent_message_send") return "agent_send";
    if (tool === "agent_message_list") return "agent_list";
    return tool;
  }))];
}

export function workerPolicySystemSummary(policy: WorkerToolPolicy): string {
  const lines = [
    "Scoped worker runtime policy:",
    `Allowed tools: ${formatList(policy.allowedTools)}`,
    `Write scope: ${formatList(policy.writeScope)}`,
    `Execute scope: ${formatList(policy.executeScope)}`,
    "Do not attempt tools or paths outside this policy; the runtime will reject them.",
  ];
  if (policy.teamId && policy.taskId) lines.splice(1, 0, `Team task: ${policy.teamId}/${policy.taskId}`);
  if (policy.memberPath) lines.splice(policy.teamId && policy.taskId ? 2 : 1, 0, `Member path: ${policy.memberPath}`);
  return lines.join("\n");
}

function formatList(items: readonly string[] | undefined): string {
  return items && items.length > 0 ? items.join(", ") : "(none)";
}
