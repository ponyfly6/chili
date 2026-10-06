import { runtimeSessionAgents, type ChiliRuntimeView } from "@chili/sdk";
import type { RuntimeDelegationConfig, SessionId } from "@chili/protocol";
import type { TuiTheme } from "../theme/index.js";

export interface AgentsViewModel {
  parentExecution: string;
  capability: string;
  delegation: string;
  summary: string;
  activeAgents: number;
  agents: AgentDisplayRow[];
}

export interface AgentDisplayRow {
  id: string;
  name: string;
  path: string;
  status: string;
}

export function agentsViewModel(input: {
  runtimeView: ChiliRuntimeView;
  sessionId?: SessionId;
  delegationConfig?: RuntimeDelegationConfig;
  capabilitySupported?: boolean;
  parentExecution?: string;
}): AgentsViewModel {
  const agents: AgentDisplayRow[] = [];
  const pending = input.sessionId ? [input.sessionId] : [];
  const seen = new Set<SessionId>(pending);
  while (pending.length > 0) {
    for (const agent of runtimeSessionAgents(input.runtimeView, pending.shift()!)) {
      if (seen.has(agent.agentId) || agent.lifecycle === "archived") continue;
      seen.add(agent.agentId);
      pending.push(agent.agentId);
      agents.push({ id: agent.agentId, name: agent.name, path: agent.path, status: agent.state });
    }
  }
  agents.sort((left, right) => left.path.localeCompare(right.path));
  const activeAgents = agents.filter((agent) => agent.status === "running").length;
  return {
    parentExecution: input.parentExecution ?? "unknown",
    capability: input.capabilitySupported === false ? "unavailable for the selected model" : "available",
    delegation: delegationPolicyText(input.delegationConfig),
    summary: `${activeAgents} active, ${agents.length} total`,
    activeAgents,
    agents,
  };
}

export function delegationPolicyText(config: RuntimeDelegationConfig | undefined): string {
  if (!config) return "not configured";
  const policy = config.policy === "explicit" ? "on request" : config.policy;
  return config.source ? `${policy} (source ${config.source})` : policy;
}

export function AgentsView(props: { model: AgentsViewModel; theme: TuiTheme }) {
  return (
    <box width="100%" height="100%" flexDirection="column">
      <text fg={props.theme.colors.text.primary} wrapMode="none" truncate>{`Agents · ${props.model.summary}`}</text>
      <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{`Delegation ${props.model.delegation}`}</text>
      <box height={1} />
      {props.model.agents.length === 0 ? (
        <text fg={props.theme.colors.text.muted} wrapMode="word">{"No agents in this session. Ask Chili to create agents and describe their work."}</text>
      ) : props.model.agents.map((agent) => (
        <box key={agent.id} flexDirection="column">
          <text fg={agent.status === "running" ? props.theme.colors.status.info : props.theme.colors.text.primary} wrapMode="none" truncate>
            {`${agent.name} · ${agent.status}`}
          </text>
          <text fg={props.theme.colors.text.muted} wrapMode="none" truncate>{`${agent.id} · ${agent.path}`}</text>
        </box>
      ))}
    </box>
  );
}
