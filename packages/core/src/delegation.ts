import type {
  DelegationPolicy,
  DelegationPolicySource,
  ReasoningLevel,
  RuntimeDelegationConfig,
  SessionId,
} from "@chili/protocol";
import type { EventStore } from "@chili/store";

const MAX_DELEGATION_PARENT_DEPTH = 64;

export interface ResolveDelegationConfigInput {
  sessionId: SessionId;
  sessionPolicy?: DelegationPolicy;
  defaultPolicy?: DelegationPolicy;
  reasoningLevel?: ReasoningLevel;
}

export interface DelegationPolicyGateOptions {
  store: Pick<EventStore, "sessions">;
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
    return (await this.options.store.sessions()).find((session) => session.id === sessionId)?.agent?.parentSessionId;
  }
}

/** Reasoning effort never grants delegation authority. */
export function resolveDelegationConfig(input: ResolveDelegationConfigInput): RuntimeDelegationConfig {
  if (input.sessionPolicy) {
    return delegationConfig(input.sessionId, input.sessionPolicy, "session");
  }
  if (input.defaultPolicy) {
    return delegationConfig(input.sessionId, input.defaultPolicy, "default");
  }
  return delegationConfig(input.sessionId, "proactive", "default");
}

function delegationConfig(
  sessionId: SessionId,
  policy: DelegationPolicy,
  source: DelegationPolicySource,
): RuntimeDelegationConfig {
  return { sessionId, policy, source };
}
