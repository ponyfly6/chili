import { expect, test } from "bun:test";
import type { RuntimeService } from "@chili/core";
import type { SessionId, SnapshotId } from "@chili/protocol";
import { revertSessionSnapshot } from "./session-recovery.js";

test("direct CLI revert resolves an active root session before invoking recovery", async () => {
  const activeSessionId = "session_revert_active" as SessionId;
  const archivedSessionId = "session_revert_archived" as SessionId;
  const historySessionId = "session_revert_history" as SessionId;
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
    .rejects.toThrow("belongs to an agent");
  await expect(revertSessionSnapshot({ ...baseInput, resume: historySessionId })).rejects.toThrow("read-only history");
  expect(recoveryCalls).toEqual([]);

  await expect(revertSessionSnapshot({ ...baseInput, resume: activeSessionId }))
    .resolves.toMatchObject({ snapshotId });
  expect(recoveryCalls).toEqual([{ sessionId: activeSessionId, snapshotId }]);
});
