import type {
  ChiliRuntimeView,
  RuntimeDelegatedAgent,
  RuntimeDelegationStatusView,
  RuntimeTaskView,
  RuntimeTeamMemberView,
  RuntimeTeamView,
} from "@chili/sdk";
import type { SessionId } from "@chili/protocol";
import type { TuiTheme } from "../theme/index.js";

export interface AgentsViewModel {
  parentExecution: string;
  capability: string;
  delegation: string;
  adHocSummary: string;
  persistentTeamSummary: string;
  activeAdHocAgents: number;
  adHocAgents: AgentDisplayRow[];
  teams: PersistentTeamDisplay[];
}

export interface AgentDisplayRow {
  id: string;
  title: string;
  status: string;
  detail?: string;
  error: boolean;
}

export interface PersistentTeamDisplay {
  id: string;
  title: string;
  status: string;
  members: AgentDisplayRow[];
}

export function agentsViewModel(input: {
  runtimeView: ChiliRuntimeView;
  status: RuntimeDelegationStatusView;
  sessionId?: SessionId;
  capabilitySupported?: boolean;
  parentExecution?: string;
}): AgentsViewModel {
  const teams = persistentTeamDisplays(input.runtimeView, input.sessionId);
  return {
    parentExecution: input.status.parent.status === "unknown" && input.parentExecution
      ? input.parentExecution
      : parentExecutionText(input.status),
    capability: agentCapabilityText(input.status, input.capabilitySupported),
    delegation: delegationPolicyText(input.status),
    adHocSummary: adHocAgentsText(input.status),
    persistentTeamSummary: persistentTeamsText(input.status),
    activeAdHocAgents: input.status.agents.counts.active,
    adHocAgents: input.status.agents.items.map(delegatedAgentDisplay),
    teams,
  };
}

export function parentExecutionText(status: RuntimeDelegationStatusView): string {
  return status.parent.status;
}

export function agentCapabilityText(
  status: RuntimeDelegationStatusView,
  modelSupported?: boolean,
): string {
  if (status.delegation.observed) return "available (used this session)";
  if (modelSupported === true || status.delegation.supported === true) {
    return modelSupported === false
      ? "available (model catalog reports tool calls unsupported)"
      : "available";
  }
  if (modelSupported === false) return "unknown (model catalog reports tool calls unsupported)";
  return "unknown until the session loads";
}

export function delegationPolicyText(status: RuntimeDelegationStatusView): string {
  const policy = status.delegation.policy;
  const source = status.delegation.source ? `; source ${status.delegation.source}` : "";
  if (policy === "off") return `off${source ? ` (${source.slice(2)})` : ""}`;
  if (policy === "explicit") return `on request (explicit${source})`;
  if (policy === "proactive") {
    return status.delegation.source === "reasoning_legacy"
      ? "proactive (source ultra reasoning)"
      : `proactive${source ? ` (${source.slice(2)})` : ""}`;
  }
  return "not configured";
}

export function adHocAgentsText(status: RuntimeDelegationStatusView): string {
  const counts = status.agents.counts;
  const batchOutcome = batchSpawnOutcomeText(status);
  if (counts.total === 0) {
    return batchOutcome ? `0 active; ${batchOutcome}` : "0 active, none spawned in this session";
  }
  const outcomes: string[] = [];
  appendCount(outcomes, counts.completed, "completed");
  appendCount(outcomes, counts.incomplete, "incomplete");
  appendCount(outcomes, counts.failed, "failed");
  appendCount(outcomes, counts.cancelled, "cancelled");
  const suffixes = [outcomes.join(", "), batchOutcome].filter((item): item is string => Boolean(item));
  return `${counts.active} active, ${counts.total} total${suffixes.length > 0 ? `; ${suffixes.join("; ")}` : ""}`;
}

function batchSpawnOutcomeText(status: RuntimeDelegationStatusView): string | undefined {
  const batch = status.lastBatch;
  const failed = batch?.spawnFailureCount ?? 0;
  if (!batch || failed <= 0) return undefined;
  const scope = batch.expected > 0 ? `${failed} of ${batch.expected}` : String(failed);
  const outcome = `${scope} agent ${failed === 1 ? "task" : "tasks"} failed to spawn`;
  return batch.spawnedCount === 0 && batch.status === "failed"
    ? `latest batch failed: ${outcome}`
    : `latest batch partial: ${outcome}`;
}

export function persistentTeamsText(status: RuntimeDelegationStatusView): string {
  const teams = status.team;
  if (teams.count === 0) return "none";
  return `${teams.count} total, ${teams.activeCount} active`;
}

export function AgentsView(props: { model: AgentsViewModel; theme: TuiTheme }) {
  const hasAdHocAgents = props.model.adHocAgents.length > 0;
  const hasTeams = props.model.teams.length > 0;
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{"Agents"}</text>
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>
        {`Capability ${props.model.capability} · delegation ${props.model.delegation} · parent ${props.model.parentExecution}`}
      </text>
      <box height={1} />
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{`Ad-hoc agents — ${props.model.adHocSummary}`}</text>
      {hasAdHocAgents ? props.model.adHocAgents.map((agent) => (
        <AgentRow key={agent.id} row={agent} theme={props.theme} />
      )) : (
        <>
          <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"No ad-hoc agents have been spawned for this session."}</text>
          <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{"Ask Chili to delegate a task, or use /agents proactive for automatic delegation."}</text>
        </>
      )}
      <box height={1} />
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{`Persistent teams — ${props.model.persistentTeamSummary}`}</text>
      {hasTeams ? props.model.teams.map((team) => (
        <box key={team.id} flexDirection="column">
          <text fg={props.theme.colors.accent.secondary} wrapMode="none" truncate>{`${team.title} · ${team.status}`}</text>
          {team.members.map((member) => <AgentRow key={member.id} row={member} theme={props.theme} indent />)}
        </box>
      )) : (
        <>
          <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{"No persistent team members in this session."}</text>
          <text fg={props.theme.colors.text.disabled} wrapMode="none" truncate>{"Teams are durable collaborators; they are separate from one-shot ad-hoc agents."}</text>
        </>
      )}
    </box>
  );
}

function AgentRow(props: { row: AgentDisplayRow; theme: TuiTheme; indent?: boolean }) {
  const prefix = props.indent ? "  " : "";
  const color = props.row.error
    ? props.theme.colors.status.error
    : isActiveStatus(props.row.status)
      ? props.theme.colors.status.info
      : props.row.status === "completed"
        ? props.theme.colors.status.success
        : props.theme.colors.text.secondary;
  return (
    <box flexDirection="column">
      <text fg={color} wrapMode="none" truncate>{`${prefix}${props.row.title} · ${props.row.status}`}</text>
      {props.row.detail ? (
        <text fg={props.row.error ? props.theme.colors.status.error : props.theme.colors.text.muted} wrapMode="none" truncate>
          {`${prefix}  ${props.row.detail}`}
        </text>
      ) : null}
    </box>
  );
}

function delegatedAgentDisplay(agent: RuntimeDelegatedAgent): AgentDisplayRow {
  const activity = agent.activity ? `${agent.activity.kind}: ${agent.activity.label} (${agent.activity.status})` : undefined;
  const detail = singleLine(agent.error) ?? singleLine(agent.summary) ?? singleLine(activity);
  return {
    id: agent.taskId,
    title: `${singleLine(agent.taskName) ?? "task"} · ${agent.path}`,
    status: agent.status,
    ...(detail ? { detail } : {}),
    error: agent.status === "failed" || agent.status === "incomplete" || agent.status === "cancelled",
  };
}

function persistentTeamDisplays(view: ChiliRuntimeView, sessionId: SessionId | undefined): PersistentTeamDisplay[] {
  return view.teamIds.flatMap((teamId) => {
    const team = view.teams[teamId];
    if (!team || !teamInSessionScope(view, team, sessionId)) return [];
    const members = team.memberIds.flatMap((memberId) => {
      const member = view.teamMembers[memberId];
      return member ? [persistentMemberDisplay(view, team, member)] : [];
    });
    return [{
      id: team.id,
      title: `${team.name || team.id} (${team.id})`,
      status: team.status,
      members,
    }];
  });
}

function persistentMemberDisplay(
  view: ChiliRuntimeView,
  team: RuntimeTeamView,
  member: RuntimeTeamMemberView,
): AgentDisplayRow {
  const task = memberTask(view, team, member);
  const taskLabel = task ? `${task.title ?? task.description ?? task.id} (${task.status})` : undefined;
  const detail = singleLine(task?.error) ?? singleLine(task?.summary) ?? singleLine(taskLabel);
  const isLead = member.path === team.leadPath;
  const error = member.status === "blocked" || task?.status === "failed" || task?.status === "blocked";
  return {
    id: member.id,
    title: `${isLead ? "lead" : "member"} ${member.name || member.path} · ${member.role}`,
    status: member.status,
    ...(detail ? { detail } : {}),
    error,
  };
}

function memberTask(
  view: ChiliRuntimeView,
  team: RuntimeTeamView,
  member: RuntimeTeamMemberView,
): RuntimeTaskView | undefined {
  if (member.currentTaskId) {
    const current = view.tasks[member.currentTaskId];
    if (current) return current;
  }
  return team.taskIds
    .flatMap((taskId) => {
      const task = view.tasks[taskId];
      return task && (task.ownerPath === member.path || task.path === member.path) ? [task] : [];
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function teamInSessionScope(
  view: ChiliRuntimeView,
  team: RuntimeTeamView,
  sessionId: SessionId | undefined,
): boolean {
  if (!sessionId || team.sessionId === sessionId) return true;
  if (team.memberIds.some((memberId) => view.teamMembers[memberId]?.childSessionId === sessionId)) return true;
  return team.taskIds.some((taskId) => {
    const task = view.tasks[taskId];
    return task?.sessionId === sessionId || task?.childSessionId === sessionId;
  });
}

function singleLine(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

function appendCount(parts: string[], count: number, label: string): void {
  if (count > 0) parts.push(`${count} ${label}`);
}

function isActiveStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "in_progress" || status === "waiting";
}
