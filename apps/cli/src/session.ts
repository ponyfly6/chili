import type { SessionId } from "@chili/protocol";
import { RuntimeSubagentSessionAccessError, type RuntimeService } from "@chili/core";
import type { EventStore, SubagentProjectionStore, TeamProjectionStore } from "@chili/store";

export interface SessionRef {
  sessionId: SessionId;
  isNew: boolean;
}

export async function resolveSession(input: {
  service: RuntimeService;
  store: Pick<EventStore, "sessions">
    & Pick<SubagentProjectionStore, "agentTasks" | "agentRuns">
    & Pick<TeamProjectionStore, "teamMembers" | "teams">;
  cwd: string;
  resume?: string;
}): Promise<SessionRef> {
  if (input.resume) {
    const sessionId = input.resume as SessionId;
    const [sessions, childTasks, childRuns, childMembers] = await Promise.all([
      input.store.sessions(),
      input.store.agentTasks({ childSessionId: sessionId, limit: 1 }),
      input.store.agentRuns({ childSessionId: sessionId, limit: 1 }),
      input.store.teamMembers({ childSessionId: sessionId, limit: 500 }),
    ]);
    const memberTeamIds = [...new Set(childMembers.map((member) => member.teamId))];
    const memberTeams = (await Promise.all(memberTeamIds.map((teamId) => (
      input.store.teams({ teamId, limit: 1 })
    )))).flat();
    const leadPaths = new Map(memberTeams.map((team) => [team.id, team.leadPath]));
    const workerMemberOwnsSession = childMembers.some((member) => (
      member.childSessionId === sessionId && leadPaths.get(member.teamId) !== member.path
    ));
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (
      session?.source === "subagent" ||
      childTasks.length > 0 ||
      childRuns.length > 0 ||
      workerMemberOwnsSession
    ) {
      throw new RuntimeSubagentSessionAccessError(sessionId);
    }
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status !== "active") throw new Error(`Session is not active: ${sessionId}`);
    return { sessionId, isNew: false };
  }

  const session = await input.service.createSession({ cwd: input.cwd });
  return { sessionId: session.sessionId, isNew: true };
}
