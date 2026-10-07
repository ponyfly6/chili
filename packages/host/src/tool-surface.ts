import type { SessionId } from "@chili/protocol";
import type { EventStore } from "@chili/store";
import { AGENT_CONTROL_TOOLS, DEFAULT_CODING_TOOLS } from "@chili/tools";

export function createHostToolExposure(
  store: Pick<EventStore, "sessions">,
  _role?: "root" | "child",
) {
  return {
    eagerTools: [...DEFAULT_CODING_TOOLS],
    async requiredTools({ sessionId }: { sessionId: SessionId }): Promise<string[]> {
      const sessions = await store.sessions();
      const names: string[] = [];
      if (sessions.some((session) => session.agent && (session.id === sessionId || session.agent.parentSessionId === sessionId))) {
        names.push(...AGENT_CONTROL_TOOLS);
      }
      return names;
    },
  };
}
