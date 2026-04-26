import type { SessionId, ThreadId } from "@chili/protocol";
import type { SqliteEventStore } from "@chili/store";
import type { RuntimeService } from "@chili/core";
import { latestThreadId, newThreadId } from "./harness.js";

export interface SessionRef {
  sessionId: SessionId;
  threadId: ThreadId;
  isNew: boolean;
}

export async function resolveSession(input: {
  service: RuntimeService;
  store: SqliteEventStore;
  cwd: string;
  resume?: string;
}): Promise<SessionRef> {
  if (input.resume) {
    const sessionId = input.resume as SessionId;
    const threadId = (await latestThreadId(input.store, sessionId)) ?? newThreadId();
    return { sessionId, threadId, isNew: false };
  }

  const threadId = newThreadId();
  const session = await input.service.createSession({ threadId, cwd: input.cwd });
  return { sessionId: session.sessionId, threadId: session.threadId, isNew: true };
}
