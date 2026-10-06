import { expect, test } from "bun:test";
import type { RuntimeService } from "@chili/core";
import type { SessionId } from "@chili/protocol";
import type { EventStore } from "@chili/store";
import { resolveSession } from "./session.js";

test("CLI resume accepts only an existing active root session without creating events", async () => {
  const activeSessionId = "session_resume_active" as SessionId;
  const archivedSessionId = "session_resume_archived" as SessionId;
  const historySessionId = "session_resume_history" as SessionId;
  const childSessionId = "session_resume_child" as SessionId;
  let createCalls = 0;
  const service = {
    async createSession() {
      createCalls += 1;
      return { sessionId: "session_created" as SessionId };
    },
  } as unknown as RuntimeService;
  const store = {
    async sessions() {
      return [
        {
          id: activeSessionId,
          cwd: "/repo",
          status: "active" as const,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: archivedSessionId,
          cwd: "/repo",
          status: "archived" as const,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: childSessionId,
          cwd: "/repo",
          agent: { parentSessionId: activeSessionId, name: "child", path: "/root/child", policy: {} },
          status: "active" as const,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: historySessionId,
          cwd: "/repo",
          readOnly: true,
          status: "active" as const,
          createdAt: 1,
          updatedAt: 1,
        },
      ];
    },
  } as unknown as Pick<EventStore, "sessions">
;
  const input = { service, store, cwd: "/repo" };

  await expect(resolveSession({
    ...input,
    resume: "session_resume_missing",
  })).rejects.toThrow("Session not found: session_resume_missing");
  await expect(resolveSession({
    ...input,
    resume: childSessionId,
  })).rejects.toThrow("belongs to an agent");
  await expect(resolveSession({
    ...input,
    resume: archivedSessionId,
  })).rejects.toThrow("Session is not active: session_resume_archived");
  await expect(resolveSession({
    ...input,
    resume: activeSessionId,
  })).resolves.toEqual({ sessionId: activeSessionId, isNew: false });
  await expect(resolveSession({ ...input, resume: historySessionId })).rejects.toThrow("read-only history");
  expect(createCalls).toBe(0);
});
