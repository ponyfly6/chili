import type { SessionId } from "@chili/protocol";
import type { RuntimeService } from "@chili/core";
import type { EventStore } from "@chili/store";

export interface SessionRef {
  sessionId: SessionId;
  isNew: boolean;
}

export async function resolveSession(input: {
  service: RuntimeService;
  store: Pick<EventStore, "sessions">;
  cwd: string;
  resume?: string;
}): Promise<SessionRef> {
  if (input.resume) {
    const sessionId = input.resume as SessionId;
    const session = (await input.store.sessions()).find((candidate) => candidate.id === sessionId);
    if (session?.agent) {
      throw new Error(`Session ${sessionId} belongs to an agent; use agent-resume with its parent session.`);
    }
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status !== "active") throw new Error(`Session is not active: ${sessionId}`);
    return { sessionId, isNew: false };
  }

  const session = await input.service.createSession({ cwd: input.cwd });
  return { sessionId: session.sessionId, isNew: true };
}
