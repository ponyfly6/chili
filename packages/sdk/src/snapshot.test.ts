import { expect, test } from "bun:test";
import type { RuntimeStateSnapshot, SessionId, TimestampMs } from "@chili/protocol";
import { restoreRuntimeSnapshot } from "./snapshot.js";

test("snapshot restoration keeps synthetic seed IDs separate from the durable watermark", () => {
  const sessionId = "session_snapshot" as SessionId;
  const snapshot: RuntimeStateSnapshot = {
    version: 1,
    events: [{
      id: "synthetic_seed_session",
      type: "session.created",
      time: 1 as TimestampMs,
      sessionId,
      payload: { sessionId, cwd: "/repo/chili" },
    }],
    coveredSessionIds: [sessionId],
    truncated: false,
    temporaryOutput: "not-replayed",
  };
  const emptyCursor = restoreRuntimeSnapshot(snapshot);
  expect(emptyCursor.lastEventId).toBeUndefined();
  expect(emptyCursor.sessionIds).toEqual([sessionId]);
  expect(restoreRuntimeSnapshot({ ...snapshot, afterEventId: "durable_watermark" }).lastEventId).toBe("durable_watermark");
});
