export interface ToolCatalogEntry {
  name: string;
  aliases: string[];
  source: "opencode" | "gemini-cli" | "claude-code" | "codex" | "chili";
  phase: "p0" | "p1" | "p2" | "p3" | "later";
  status: "implemented" | "planned";
}

export const CHILI_TOOL_CATALOG: ToolCatalogEntry[] = [
  { name: "read", aliases: ["read_file"], source: "opencode", phase: "p0", status: "implemented" },
  { name: "edit", aliases: ["replace"], source: "opencode", phase: "p0", status: "implemented" },
  { name: "bash", aliases: ["run_shell_command"], source: "opencode", phase: "p0", status: "implemented" },
  { name: "apply_patch", aliases: [], source: "codex", phase: "p0", status: "implemented" },
  { name: "git_diff", aliases: [], source: "chili", phase: "p0", status: "implemented" },
  { name: "write", aliases: ["write_file"], source: "opencode", phase: "p0", status: "implemented" },
  { name: "glob", aliases: ["file_glob"], source: "opencode", phase: "p1", status: "implemented" },
  { name: "grep", aliases: ["grep_search"], source: "opencode", phase: "p1", status: "implemented" },
  { name: "tool_search", aliases: ["toolsearch"], source: "claude-code", phase: "p1", status: "implemented" },
  { name: "todowrite", aliases: ["write_todos"], source: "opencode", phase: "p1", status: "planned" },
  { name: "task", aliases: ["agent"], source: "opencode", phase: "p2", status: "implemented" },
  { name: "complete_task", aliases: [], source: "gemini-cli", phase: "p2", status: "implemented" },
  { name: "task_list", aliases: ["list_tasks", "agent_list"], source: "chili", phase: "p3", status: "implemented" },
  { name: "task_wait", aliases: ["wait_task", "agent_wait"], source: "chili", phase: "p3", status: "implemented" },
  { name: "task_followup", aliases: ["followup_task", "agent_followup"], source: "chili", phase: "p3", status: "implemented" },
  { name: "task_close", aliases: ["close_task", "agent_close"], source: "chili", phase: "p3", status: "implemented" },
  { name: "mailbox_list", aliases: ["list_mailbox", "agent_mailbox"], source: "chili", phase: "p3", status: "implemented" },
  { name: "mailbox_consume", aliases: ["consume_mailbox", "agent_mailbox_consume"], source: "chili", phase: "p3", status: "implemented" },
  { name: "team_create", aliases: ["create_team"], source: "claude-code", phase: "p3", status: "implemented" },
  { name: "team_list", aliases: ["list_teams"], source: "chili", phase: "p3", status: "implemented" },
  { name: "team_member_add", aliases: ["add_team_member"], source: "claude-code", phase: "p3", status: "implemented" },
  { name: "team_member_list", aliases: ["list_team_members"], source: "chili", phase: "p3", status: "implemented" },
  { name: "team_task_create", aliases: ["create_team_task"], source: "claude-code", phase: "p3", status: "implemented" },
  { name: "team_task_list", aliases: ["list_team_tasks", "team_tasks"], source: "claude-code", phase: "p3", status: "implemented" },
  { name: "team_task_assign", aliases: ["assign_team_task"], source: "claude-code", phase: "p3", status: "implemented" },
  { name: "team_task_claim", aliases: ["claim_team_task"], source: "claude-code", phase: "p3", status: "implemented" },
  { name: "team_task_update", aliases: ["update_team_task"], source: "claude-code", phase: "p3", status: "implemented" },
  { name: "team_task_dispatch", aliases: ["dispatch_team_task", "team_dispatch"], source: "chili", phase: "p3", status: "implemented" },
  { name: "team_task_sync", aliases: ["sync_team_task"], source: "chili", phase: "p3", status: "implemented" },
  { name: "team_task_reconcile", aliases: ["reconcile_team_tasks", "team_reconcile"], source: "chili", phase: "p3", status: "implemented" },
  { name: "team_message_send", aliases: ["send_team_message", "send_message"], source: "claude-code", phase: "p3", status: "implemented" },
  { name: "team_message_list", aliases: ["list_team_messages"], source: "chili", phase: "p3", status: "implemented" },
  { name: "webfetch", aliases: ["web_fetch"], source: "opencode", phase: "later", status: "planned" },
  { name: "websearch", aliases: ["web_search"], source: "opencode", phase: "later", status: "planned" },
];
