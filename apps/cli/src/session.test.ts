import { expect, test } from "bun:test";
import type { RuntimeService } from "@chili/core";
import type { SessionId, TaskId } from "@chili/protocol";
import type { EventStore, SubagentProjectionStore, TeamProjectionStore } from "@chili/store";
import { resolveSession } from "./session.js";

test("CLI resume accepts only an existing active interactive session without creating events", async () => {
  const activeSessionId = "session_resume_active" as SessionId;
  const archivedSessionId = "session_resume_archived" as SessionId;
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
          source: "interactive" as const,
          status: "active" as const,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: archivedSessionId,
          cwd: "/repo",
          source: "interactive" as const,
          status: "archived" as const,
          createdAt: 1,
          updatedAt: 1,
        },
      ];
    },
    async agentTasks(query: { childSessionId?: SessionId }) {
      return query.childSessionId === childSessionId
        ? [{
            id: "task_resume_child" as TaskId,
            childSessionId,
          }]
        : [];
    },
    async agentRuns() {
      return [];
    },
    async teamMembers() {
      return [];
    },
    async teams() {
      return [];
    },
  } as unknown as Pick<EventStore, "sessions">
    & Pick<SubagentProjectionStore, "agentTasks" | "agentRuns">
    & Pick<TeamProjectionStore, "teamMembers" | "teams">;
  const input = { service, store, cwd: "/repo" };

  await expect(resolveSession({
    ...input,
    resume: "session_resume_missing",
  })).rejects.toThrow("Session not found: session_resume_missing");
  await expect(resolveSession({
    ...input,
    resume: childSessionId,
  })).rejects.toThrow("belongs to a subagent");
  await expect(resolveSession({
    ...input,
    resume: archivedSessionId,
  })).rejects.toThrow("Session is not active: session_resume_archived");
  await expect(resolveSession({
    ...input,
    resume: activeSessionId,
  })).resolves.toEqual({ sessionId: activeSessionId, isNew: false });
  expect(createCalls).toBe(0);
});
