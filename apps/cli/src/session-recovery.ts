import type { SnapshotRecoveryService } from "@chili/core";
import type { SnapshotId } from "@chili/protocol";
import type { SnapshotRevertResult } from "@chili/tools";
import { resolveSession } from "./session.js";

export async function revertSessionSnapshot(input: {
  service: Parameters<typeof resolveSession>[0]["service"];
  store: Parameters<typeof resolveSession>[0]["store"];
  recovery: Pick<SnapshotRecoveryService, "revert">;
  cwd: string;
  resume: string;
  snapshotId: SnapshotId;
}): Promise<SnapshotRevertResult> {
  const session = await resolveSession({
    service: input.service,
    store: input.store,
    cwd: input.cwd,
    resume: input.resume,
  });
  return input.recovery.revert({
    sessionId: session.sessionId,
    snapshotId: input.snapshotId,
  });
}
