import type {
  DelegationPolicy,
  DelegationPolicySource,
  ReasoningLevel,
  RuntimeDelegationConfig,
  SessionId,
} from "@chili/protocol";
import type { SubagentProjectionStore, TeamProjectionStore } from "@chili/store";

const MAX_DELEGATION_PARENT_DEPTH = 64;
const DELEGATION_PARENT_QUERY_LIMIT = 2;
const DELEGATION_TEAM_MEMBERSHIP_LIMIT = 10_000;

export interface ResolveDelegationConfigInput {
  sessionId: SessionId;
  sessionPolicy?: DelegationPolicy;
  defaultPolicy?: DelegationPolicy;
  reasoningLevel?: ReasoningLevel;
}

export interface DelegationPolicyGateOptions {
  store: SubagentProjectionStore & Partial<TeamProjectionStore>;
  getDelegationConfig(sessionId: SessionId): Promise<RuntimeDelegationConfig>;
}

export interface AssertDelegationEnabledInput {
  sessionId: SessionId;
  action: string;
}

/**
 * Raised at a side-effect boundary when the root session has disabled
 * delegation. The policy is resolved through the agent ancestry so child
 * workers cannot bypass a root-session override.
 */
export class DelegationPolicyOffError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly rootSessionId: SessionId,
    readonly action: string,
  ) {
    super(`Delegation policy is off for session ${rootSessionId}; blocked ${action}`);
    this.name = "DelegationPolicyOffError";
  }
}

/**
 * Resolves the session that owns delegation policy for a root/child agent
 * tree, then provides a single fail-closed check for delegation side effects.
 */
export class DelegationPolicyGate {
  constructor(private readonly options: DelegationPolicyGateOptions) {}

  async rootSessionId(sessionId: SessionId): Promise<SessionId> {
    const visited = new Set<SessionId>();
    let current = sessionId;

    for (let depth = 0; depth < MAX_DELEGATION_PARENT_DEPTH; depth += 1) {
      if (visited.has(current)) {
        throw new Error(`Cyclic delegation ancestry for session ${current}`);
      }
      visited.add(current);
      const parent = await this.parentSessionId(current);
      if (!parent) return current;
      if (parent === current) {
        throw new Error(`Cyclic delegation ancestry for session ${current}`);
      }
      current = parent;
    }

    throw new Error(`Delegation ancestry exceeds ${MAX_DELEGATION_PARENT_DEPTH} sessions for ${sessionId}`);
  }

  async configForSession(sessionId: SessionId): Promise<RuntimeDelegationConfig> {
    return this.options.getDelegationConfig(await this.rootSessionId(sessionId));
  }

  async isOff(sessionId: SessionId): Promise<boolean> {
    return (await this.configForSession(sessionId)).policy === "off";
  }

  async assertEnabled(input: AssertDelegationEnabledInput): Promise<void> {
    const rootSessionId = await this.rootSessionId(input.sessionId);
    if ((await this.options.getDelegationConfig(rootSessionId)).policy === "off") {
      throw new DelegationPolicyOffError(input.sessionId, rootSessionId, input.action);
    }
  }

  private async parentSessionId(sessionId: SessionId): Promise<SessionId | undefined> {
    const tasks = (await this.options.store.agentTasks({
      childSessionId: sessionId,
      limit: DELEGATION_PARENT_QUERY_LIMIT,
    })).filter((candidate) => candidate.childSessionId === sessionId);
    if (tasks.length > 1) {
      throw new Error(`Ambiguous delegation ancestry for agent task session ${sessionId}`);
    }
    const task = tasks[0];
    if (task?.parentSessionId) {
      if (task.parentSessionId === sessionId) {
        throw new Error(`Cyclic delegation ancestry for agent task session ${sessionId}`);
      }
      return task.parentSessionId;
    }

    const teamMembers = this.options.store.teamMembers;
    const teams = this.options.store.teams;
    if (!teamMembers || !teams) return undefined;
    const matchingMembers = (await teamMembers.call(this.options.store, {
      childSessionId: sessionId,
      limit: DELEGATION_TEAM_MEMBERSHIP_LIMIT,
    })).filter((candidate) => candidate.childSessionId === sessionId);
    const memberships = await Promise.all(matchingMembers.map(async (member) => ({
      member,
      team: (await teams.call(this.options.store, { teamId: member.teamId, limit: 1 }))[0],
    })));
    const parentSessionIds = [...new Set(memberships.flatMap(({ member, team }) => {
      if (!team?.sessionId) return [];
      if (team.sessionId === sessionId || member.path === team.leadPath) return [];
      return [team.sessionId];
    }))];
    if (parentSessionIds.length > 1) {
      throw new Error(`Ambiguous delegation ancestry for team member session ${sessionId}`);
    }
    return parentSessionIds[0];
  }
}

/**
 * Resolve policy separately from agent tool capability. The reasoning fallback
 * preserves Chili's legacy ultra behavior for callers that have not selected
 * an explicit delegation policy.
 */
export function resolveDelegationConfig(input: ResolveDelegationConfigInput): RuntimeDelegationConfig {
  if (input.sessionPolicy) {
    return delegationConfig(input.sessionId, input.sessionPolicy, "session");
  }
  if (input.defaultPolicy) {
    return delegationConfig(input.sessionId, input.defaultPolicy, "default");
  }
  if (input.reasoningLevel === "ultra") {
    return delegationConfig(input.sessionId, "proactive", "reasoning_legacy");
  }
  return delegationConfig(input.sessionId, "explicit", "default");
}

function delegationConfig(
  sessionId: SessionId,
  policy: DelegationPolicy,
  source: DelegationPolicySource,
): RuntimeDelegationConfig {
  return { sessionId, policy, source };
}
