import { expect, test } from "bun:test";
import type { RuntimeService } from "@chili/core";
import type { SessionId, SnapshotId, TaskId } from "@chili/protocol";
import { revertSessionSnapshot } from "./session-recovery.js";

test("direct CLI revert resolves an active root session before invoking recovery", async () => {
  const activeSessionId = "session_revert_active" as SessionId;
  const archivedSessionId = "session_revert_archived" as SessionId;
  const childSessionId = "session_revert_child" as SessionId;
  const snapshotId = "snapshot_cli_revert" as SnapshotId;
  const service = {
    async createSession() {
      throw new Error("direct revert must not create a session");
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
        ? [{ id: "task_revert_child" as TaskId, childSessionId }]
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
  } as unknown as Parameters<typeof revertSessionSnapshot>[0]["store"];
  const recoveryCalls: Array<{ sessionId: SessionId; snapshotId: SnapshotId }> = [];
  const recovery = {
    async revert(input: { sessionId: SessionId; snapshotId: SnapshotId }) {
      recoveryCalls.push(input);
      return {
        snapshotId: input.snapshotId,
        paths: ["src/file.ts"],
        restored: ["src/file.ts"],
        removed: [],
      };
    },
  };
  const baseInput = { service, store, recovery, cwd: "/repo", snapshotId };

  await expect(revertSessionSnapshot({ ...baseInput, resume: "session_revert_missing" }))
    .rejects.toThrow("Session not found: session_revert_missing");
  await expect(revertSessionSnapshot({ ...baseInput, resume: archivedSessionId }))
    .rejects.toThrow(`Session is not active: ${archivedSessionId}`);
  await expect(revertSessionSnapshot({ ...baseInput, resume: childSessionId }))
    .rejects.toThrow("belongs to a subagent");
  expect(recoveryCalls).toEqual([]);

  await expect(revertSessionSnapshot({ ...baseInput, resume: activeSessionId }))
    .resolves.toMatchObject({ snapshotId });
  expect(recoveryCalls).toEqual([{ sessionId: activeSessionId, snapshotId }]);
});
