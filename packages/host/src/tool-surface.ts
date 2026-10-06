import type { SessionId } from "@chili/protocol";
import type { GoalProjectionStore, SubagentProjectionStore, TeamProjectionStore } from "@chili/store";
import { AGENT_CONTROL_TOOLS, DEFAULT_CODING_TOOLS, GOAL_CONTROL_TOOLS, TEAM_CONTROL_TOOLS } from "@chili/tools";

/** Recover control tools from durable domain state, including sessions predating tool discovery. */
export function createHostToolExposure(
  store: GoalProjectionStore & SubagentProjectionStore & TeamProjectionStore,
  role: "root" | "child",
) {
  return {
    eagerTools: role === "root" ? [...DEFAULT_CODING_TOOLS]
      : [...DEFAULT_CODING_TOOLS, "complete_task", "agent_send", "agent_list"],
    async requiredTools({ sessionId }: { sessionId: SessionId }): Promise<string[]> {
      const [goal, children, self, teams, memberships] = await Promise.all([
        store.sessionGoal(sessionId),
        store.agentTasks({ parentSessionId: sessionId, limit: 1 }),
        store.agentTasks({ childSessionId: sessionId, limit: 1 }),
        store.teams({ sessionId, status: "active", limit: 1 }),
        store.teamMembers({ childSessionId: sessionId, limit: 1 }),
      ]);
      const names: string[] = [];
      if (goal) names.push(...GOAL_CONTROL_TOOLS);
      // Completed agents still need inspection and resumable follow-up controls.
      if (children.length || self.length) names.push(...AGENT_CONTROL_TOOLS);
      if (teams.length || memberships.length) names.push(...TEAM_CONTROL_TOOLS);
      return names;
    },
  };
}
