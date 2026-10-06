import type { SessionId } from "@chili/protocol";
import type { EventStore, GoalProjectionStore } from "@chili/store";
import { AGENT_CONTROL_TOOLS, DEFAULT_CODING_TOOLS, GOAL_CONTROL_TOOLS } from "@chili/tools";

export function createHostToolExposure(
  store: GoalProjectionStore & Pick<EventStore, "sessions">,
  _role?: "root" | "child",
) {
  return {
    eagerTools: [...DEFAULT_CODING_TOOLS],
    async requiredTools({ sessionId }: { sessionId: SessionId }): Promise<string[]> {
      const [goal, sessions] = await Promise.all([store.sessionGoal(sessionId), store.sessions()]);
      const names: string[] = [];
      if (goal) names.push(...GOAL_CONTROL_TOOLS);
      if (sessions.some((session) => session.agent && (session.id === sessionId || session.agent.parentSessionId === sessionId))) {
        names.push(...AGENT_CONTROL_TOOLS);
      }
      return names;
    },
  };
}
