import type { ChiliToolDefinition } from "./types.js";

/** The interactive coding surface. Registration and execution permissions are separate. */
export const DEFAULT_CODING_TOOLS = [
  "read", "glob", "grep", "edit", "write", "apply_patch", "bash", "process",
  "git_status", "git_diff", "code_mode", "tool_search", "activate_skill", "request_user_input",
] as const;

export const AGENT_CONTROL_TOOLS = [
  "agent_spawn", "agent_list", "agent_send", "agent_wait", "agent_stop", "agent_resume",
] as const;

export const GOAL_CONTROL_TOOLS = ["create_goal", "get_goal", "update_goal"] as const;

export const TEAM_CONTROL_TOOLS = [
  "team_create", "team_list", "team_snapshot", "team_member_add", "team_member_list",
  "team_task_create", "team_task_create_batch", "team_task_list", "team_task_assign",
  "team_task_claim", "team_task_update", "team_task_dispatch", "team_task_dispatch_batch",
  "team_task_sync", "team_task_reconcile", "team_run_loop", "team_message_send", "team_message_list",
] as const;

export const CODING_TOOL_GROUPS: readonly (readonly string[])[] = [
  AGENT_CONTROL_TOOLS, GOAL_CONTROL_TOOLS, TEAM_CONTROL_TOOLS,
  ["delegation_status", "delegation_set"],
];

export function expandToolGroups(
  selected: readonly ChiliToolDefinition[],
  available: readonly ChiliToolDefinition[],
  groups: readonly (readonly string[])[],
): string[] {
  const names = new Set(selected.map((tool) => tool.name));
  for (const group of groups) {
    if (group.some((name) => names.has(name))) for (const name of group) names.add(name);
  }
  return available.filter((tool) => names.has(tool.name)).map((tool) => tool.name).sort();
}
