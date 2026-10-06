import { ROOT_AGENT_PATH, type AgentPath, type SessionId } from "@chili/protocol";
import type { EventStore } from "@chili/store";

export interface AgentAncestry {
  path: AgentPath;
  depth: number;
  rootSessionId: SessionId;
}

/** Paths describe identity; authority comes from the persisted parent sessions. */
export async function resolveAgentAncestry(
  store: Pick<EventStore, "sessions">,
  sessionId: SessionId,
): Promise<AgentAncestry> {
  const sessions = new Map((await store.sessions()).map((session) => [session.id, session]));
  const visited = new Set<SessionId>();
  let current = sessionId;
  let depth = 0;
  while (true) {
    if (visited.has(current)) throw new Error(`Agent ancestry contains a cycle: ${current}`);
    visited.add(current);
    const session = sessions.get(current);
    if (!session || session.status !== "active") throw new Error(`Agent session is not active: ${current}`);
    if (session.readOnly) throw new Error(`Agent session is read-only: ${current}`);
    if (!session.agent) {
      return { path: sessions.get(sessionId)?.agent?.path ?? ROOT_AGENT_PATH, depth, rootSessionId: current };
    }
    current = session.agent.parentSessionId;
    depth++;
  }
}
