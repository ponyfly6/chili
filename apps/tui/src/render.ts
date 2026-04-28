import type {
  RuntimeTeamRunView,
  TeamLiveActivityItem,
  TeamLiveCockpitView,
  TeamLiveMemberRow,
  TeamLiveMetadataEntry,
  TeamLiveTaskRow,
  TeamLiveToolCount,
} from "@chili/sdk";
import type { TeamId, TeamRunSummaryCounts } from "@chili/protocol";

export interface TeamLiveRenderOptions {
  width?: number;
  height?: number;
  selectedTeamIndex?: number;
  detailOpen?: boolean;
  message?: string;
  error?: string;
}

export function selectedTeamId(view: TeamLiveCockpitView, selectedTeamIndex = 0): TeamId | undefined {
  const index = clamp(selectedTeamIndex, 0, Math.max(0, view.teams.length - 1));
  return view.teams[index]?.id;
}

export function renderTeamLiveCockpit(view: TeamLiveCockpitView, options: TeamLiveRenderOptions = {}): string {
  const width = Math.max(40, options.width ?? 100);
  const height = Math.max(12, options.height ?? 32);
  const selectedIndex = clamp(options.selectedTeamIndex ?? 0, 0, Math.max(0, view.teams.length - 1));
  const lines: string[] = [];

  lines.push(padRight("Chili Team Live Cockpit", width, "="));
  if (options.error) lines.push(truncate(`error: ${options.error}`, width));
  else if (options.message) lines.push(truncate(options.message, width));

  if (view.teams.length === 0) {
    lines.push("Teams");
    lines.push("  No teams projected yet.");
    return fitLines(lines, width, height);
  }

  lines.push(...renderTeamList(view, width, selectedIndex));
  lines.push(separator(width));
  lines.push(...renderRunPanel(view.activeRun, view.pendingApprovals.length, view.toolCounts, width));
  lines.push(separator(width));
  lines.push(...renderMembers(view.members, width));
  lines.push(separator(width));
  lines.push(...renderTaskBoard(view.tasks, width));
  lines.push(separator(width));
  lines.push(...renderMetadata(view.metadata.worktrees, view.metadata.verifications, view.metadata.merges, width));
  lines.push(separator(width));
  lines.push(...renderApprovals(view, width));
  lines.push(separator(width));
  lines.push(...renderActivity(view.recentActivity, width));

  if (options.detailOpen) {
    lines.push(separator(width));
    lines.push(...renderDetail(view, width));
  }

  return fitLines(lines, width, height);
}

function renderTeamList(view: TeamLiveCockpitView, width: number, selectedIndex: number): string[] {
  const lines = ["Teams"];
  const teamWidth = Math.max(24, Math.floor(width * 0.32));
  for (const [index, team] of view.teams.entries()) {
    const marker = index === selectedIndex ? ">" : " ";
    const run = team.activeRunId ? ` run:${team.activeRunId}` : "";
    const summary = `${team.status} members:${team.memberCount} tasks:${team.taskCount} pending:${team.pendingTaskCount}${run}`;
    lines.push(truncate(`${marker} ${padRight(team.name || team.id, teamWidth)} ${summary}`, width));
  }
  return lines;
}

function renderRunPanel(
  run: RuntimeTeamRunView | undefined,
  pendingApprovals: number,
  toolCounts: readonly TeamLiveToolCount[],
  width: number,
): string[] {
  const lines = ["Run / Counts"];
  if (!run) {
    lines.push(truncate(`  run: none  approvals:${pendingApprovals}  tools:${toolCountsCompact(toolCounts)}`, width));
    return lines;
  }

  const phase = run.phase ?? run.status;
  const stop = run.stopReason ? ` stop:${run.stopReason}` : "";
  lines.push(truncate(`  ${run.id}  ${phase}  cycle:${run.cycle}${stop}`, width));
  lines.push(truncate(`  counts: ${countsCompact(run.counts)}  approvals:${pendingApprovals}`, width));
  lines.push(truncate(`  tools: ${toolCountsCompact(toolCounts)}`, width));
  return lines;
}

function renderMembers(members: readonly TeamLiveMemberRow[], width: number): string[] {
  const lines = ["Lead / Members"];
  if (members.length === 0) return [...lines, "  none"];
  for (const member of members) {
    const branch = member.isLead ? "+-" : `${"  ".repeat(Math.min(member.depth, 4))}|-`;
    const current = member.currentTaskTitle ? ` task:${member.currentTaskTitle}` : "";
    const scope = member.writeScope?.length ? ` write:${member.writeScope.join(",")}` : "";
    lines.push(truncate(`  ${branch} ${member.name || member.path} [${member.role}] ${member.status}${current}${scope}`, width));
  }
  return lines;
}

function renderTaskBoard(tasks: readonly TeamLiveTaskRow[], width: number): string[] {
  const lines = ["Task Board"];
  if (tasks.length === 0) return [...lines, "  none"];
  for (const task of tasks.slice(0, 10)) {
    const owner = task.ownerName ?? task.ownerPath ?? "unassigned";
    const metadata = metadataBadges(task);
    const suffix = task.error ? ` error:${task.error}` : task.summary ? ` summary:${task.summary}` : "";
    lines.push(truncate(`  [${task.status}] ${task.title} @ ${owner}${metadata}${suffix}`, width));
  }
  if (tasks.length > 10) lines.push(`  +${tasks.length - 10} more tasks`);
  return lines;
}

function renderMetadata(
  worktrees: readonly TeamLiveMetadataEntry[],
  verifications: readonly TeamLiveMetadataEntry[],
  merges: readonly TeamLiveMetadataEntry[],
  width: number,
): string[] {
  const lines = ["Verifier / Merge / Worktree"];
  if (worktrees.length === 0 && verifications.length === 0 && merges.length === 0) return [...lines, "  none"];
  for (const entry of worktrees.slice(0, 3)) {
    lines.push(truncate(`  worktree ${entry.taskId}: ${stringField(entry.value, "path") ?? stringField(entry.value, "status") ?? "present"}`, width));
  }
  for (const entry of verifications.slice(0, 3)) {
    lines.push(truncate(`  verifier ${entry.taskId}: ${stringField(entry.value, "status") ?? "present"}`, width));
  }
  for (const entry of merges.slice(0, 3)) {
    lines.push(truncate(`  merge ${entry.taskId}: ${stringField(entry.value, "status") ?? "present"}`, width));
  }
  return lines;
}

function renderApprovals(view: TeamLiveCockpitView, width: number): string[] {
  const lines = ["Pending Approvals"];
  if (view.pendingApprovals.length === 0) return [...lines, "  none"];
  for (const approval of view.pendingApprovals.slice(0, 5)) {
    lines.push(truncate(`  ${approval.permission} ${approval.patterns.join(", ")}`, width));
  }
  if (view.pendingApprovals.length > 5) lines.push(`  +${view.pendingApprovals.length - 5} more approvals`);
  return lines;
}

function renderActivity(activity: readonly TeamLiveActivityItem[], width: number): string[] {
  const lines = ["Recent Activity"];
  if (activity.length === 0) return [...lines, "  none"];
  for (const item of activity.slice(0, 8)) {
    const status = item.status ? ` [${item.status}]` : "";
    const detail = item.detail ? ` - ${item.detail}` : "";
    lines.push(truncate(`  ${item.kind}${status}: ${item.label}${detail}`, width));
  }
  return lines;
}

function renderDetail(view: TeamLiveCockpitView, width: number): string[] {
  const lines = ["Detail"];
  if (!view.team) return [...lines, "  no selected team"];
  lines.push(truncate(`  team: ${view.team.name} (${view.team.id}) lead:${view.team.leadPath}`, width));
  if (view.activeRun) {
    lines.push(truncate(`  run: ${view.activeRun.id} ${view.activeRun.phase ?? view.activeRun.status} ${countsCompact(view.activeRun.counts)}`, width));
  }
  const task = view.tasks[0];
  if (task) {
    lines.push(truncate(`  selected task: ${task.title} [${task.status}]`, width));
    const metadata = compactJson(task.metadata);
    if (metadata !== "{}") lines.push(truncate(`  task metadata: ${metadata}`, width));
  }
  const mailbox = view.mailbox[0];
  if (mailbox) lines.push(truncate(`  mailbox: ${mailbox.id} ${mailbox.status} ${mailbox.from} -> ${mailbox.path}`, width));
  return lines;
}

function metadataBadges(task: TeamLiveTaskRow): string {
  const badges: string[] = [];
  if (task.metadata.worktree) badges.push("worktree");
  if (task.metadata.verification) badges.push("verifier");
  if (task.metadata.merge) badges.push("merge");
  if (task.metadata.dispatch) badges.push("dispatch");
  return badges.length > 0 ? ` {${badges.join(",")}}` : "";
}

function countsCompact(counts: TeamRunSummaryCounts): string {
  const items = Object.entries(counts).filter(([, value]) => typeof value === "number" && value > 0);
  if (items.length === 0) return "none";
  return items.slice(0, 8).map(([key, value]) => `${key}:${value}`).join(" ");
}

function toolCountsCompact(counts: readonly TeamLiveToolCount[]): string {
  if (counts.length === 0) return "none";
  return counts.slice(0, 4).map((item) => `${item.toolName}:${item.total}`).join(" ");
}

function compactJson(value: unknown): string {
  return JSON.stringify(value).replace(/\s+/g, " ");
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function separator(width: number): string {
  return "-".repeat(width);
}

function fitLines(lines: readonly string[], width: number, height: number): string {
  const visible = lines.slice(0, height).map((line) => truncate(line, width));
  while (visible.length < height) visible.push("");
  return visible.join("\n");
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}~`;
}

function padRight(value: string, width: number, fill = " "): string {
  if (value.length >= width) return value;
  return `${value}${fill.repeat(width - value.length)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
