import type {
  DelegationPolicy,
  DelegationPolicySource,
  ReasoningLevel,
  RuntimeDelegationConfig,
  SessionId,
} from "@chili/protocol";
import type { EventStore, SubagentProjectionStore, TeamProjectionStore } from "@chili/store";

const MAX_DELEGATION_PARENT_DEPTH = 64;
const DELEGATION_PARENT_QUERY_LIMIT = 2;
const DELEGATION_RUN_QUERY_LIMIT = 10_001;
const DELEGATION_TEAM_MEMBERSHIP_LIMIT = 10_000;

export interface ResolveDelegationConfigInput {
  sessionId: SessionId;
  sessionPolicy?: DelegationPolicy;
  defaultPolicy?: DelegationPolicy;
  reasoningLevel?: ReasoningLevel;
}

export interface DelegationPolicyGateOptions {
  store: SubagentProjectionStore
    & Partial<TeamProjectionStore>
    & Partial<Pick<EventStore, "sessions">>;
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
    const sessions = this.options.store.sessions
      ? await this.options.store.sessions.call(this.options.store)
      : undefined;
    const knownSessionsById = sessions
      ? new Map(sessions.map((session) => [session.id, session] as const))
      : undefined;
    const visited = new Set<SessionId>();
    let current = sessionId;

    for (let depth = 0; depth < MAX_DELEGATION_PARENT_DEPTH; depth += 1) {
      if (visited.has(current)) {
        throw new Error(`Cyclic delegation ancestry for session ${current}`);
      }
      visited.add(current);
      const parent = await this.parentSessionId(current);
      if (!parent) {
        if (knownSessionsById) {
          const rootSession = knownSessionsById.get(current);
          if (!rootSession) {
            throw new Error(`Delegation session not found: ${current}`);
          }
          if (rootSession.status !== "active") {
            throw new Error(`Delegation root session is not active: ${current} (${rootSession.status})`);
          }
          if (rootSession.source === "subagent") {
            throw new Error(`Delegation root session cannot be a subagent: ${current}`);
          }
        }
        return current;
      }
      if (parent === current) {
        throw new Error(`Cyclic delegation ancestry for session ${current}`);
      }
      if (knownSessionsById) {
        const parentSession = knownSessionsById.get(parent);
        if (!parentSession) {
          throw new Error(`Delegation parent session not found: ${parent} (child ${current})`);
        }
        if (parentSession.status !== "active") {
          throw new Error(`Delegation parent session is not active: ${parent} (${parentSession.status})`);
        }
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
    const [queriedTasks, queriedRuns] = await Promise.all([
      this.options.store.agentTasks({
        childSessionId: sessionId,
        limit: DELEGATION_PARENT_QUERY_LIMIT,
      }),
      this.options.store.agentRuns?.({
        childSessionId: sessionId,
        limit: DELEGATION_RUN_QUERY_LIMIT,
      }) ?? [],
    ]);
    const tasks = queriedTasks.filter((candidate) => candidate.childSessionId === sessionId);
    if (tasks.length > 1) {
      throw new Error(`Ambiguous delegation ancestry for agent task session ${sessionId}`);
    }
    const taskParentSessionId = tasks[0]?.parentSessionId;
    if (taskParentSessionId === sessionId) {
      throw new Error(`Cyclic delegation ancestry for agent task session ${sessionId}`);
    }

    const runs = queriedRuns.filter((candidate) => candidate.childSessionId === sessionId);
    if (runs.length >= DELEGATION_RUN_QUERY_LIMIT) {
      throw new Error(`Delegation agent run ancestry exceeds ${DELEGATION_RUN_QUERY_LIMIT - 1} rows for ${sessionId}`);
    }
    const runParentSessionIds = [...new Set(runs.flatMap((run) => (
      run.parentSessionId ? [run.parentSessionId] : []
    )))];
    if (runParentSessionIds.includes(sessionId)) {
      throw new Error(`Cyclic delegation ancestry for agent run session ${sessionId}`);
    }
    if (runParentSessionIds.length > 1) {
      throw new Error(`Ambiguous delegation ancestry for agent run session ${sessionId}`);
    }

    const teamMembers = this.options.store.teamMembers;
    const teams = this.options.store.teams;
    let teamParentSessionIds: SessionId[] = [];
    if (teamMembers && teams) {
      const matchingMembers = (await teamMembers.call(this.options.store, {
        childSessionId: sessionId,
        limit: DELEGATION_TEAM_MEMBERSHIP_LIMIT,
      })).filter((candidate) => candidate.childSessionId === sessionId);
      if (matchingMembers.length >= DELEGATION_TEAM_MEMBERSHIP_LIMIT) {
        throw new Error(`Delegation team ancestry exceeds ${DELEGATION_TEAM_MEMBERSHIP_LIMIT - 1} memberships for ${sessionId}`);
      }
      const memberships = await Promise.all(matchingMembers.map(async (member) => ({
        member,
        team: (await teams.call(this.options.store, { teamId: member.teamId, limit: 1 }))[0],
      })));
      const parents: SessionId[] = [];
      for (const { member, team } of memberships) {
        if (!team) {
          throw new Error(`Delegation team not found: ${member.teamId} (child ${sessionId})`);
        }
        if (member.path === team.leadPath) continue;
        if (!team.sessionId) {
          throw new Error(`Delegation team session not found: ${team.id} (child ${sessionId})`);
        }
        if (team.sessionId === sessionId) {
          throw new Error(`Cyclic delegation ancestry for team member session ${sessionId}`);
        }
        parents.push(team.sessionId);
      }
      teamParentSessionIds = [...new Set(parents)];
    }
    if (teamParentSessionIds.length > 1) {
      throw new Error(`Ambiguous delegation ancestry for team member session ${sessionId}`);
    }

    const parentSessionIds = [...new Set([
      ...(taskParentSessionId ? [taskParentSessionId] : []),
      ...runParentSessionIds,
      ...teamParentSessionIds,
    ])];
    if (parentSessionIds.length > 1) {
      throw new Error(`Conflicting delegation ancestry for session ${sessionId}`);
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
