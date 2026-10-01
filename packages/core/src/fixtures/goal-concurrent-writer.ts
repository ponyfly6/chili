import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionId, TurnId } from "@chili/protocol";
import { SqliteEventStore } from "@chili/store";
import { GoalService } from "../goal.js";

const [databasePath, directory, scenario, workerId, sessionPrefix, roundsText] = process.argv.slice(2);
if (!databasePath || !directory || !sessionPrefix || !roundsText
  || (scenario !== "distinct" && scenario !== "duplicate" && scenario !== "pause")
  || (workerId !== "alpha" && workerId !== "beta")) {
  throw new Error("Expected database, barriers directory, scenario, worker, session prefix, and round count");
}
const rounds = Number(roundsText);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("Invalid Goal worker round count");

const store = new SqliteEventStore(databasePath);
let eventIndex = 0;
const service = new GoalService({
  store,
  createId: (prefix) => `${prefix}_${sessionPrefix}_${workerId}_${eventIndex++}`,
});
let accounted = 0;
try {
  for (let index = 0; index < rounds; index += 1) {
    const sessionId = (scenario === "pause" ? `${sessionPrefix}_${index}` : sessionPrefix) as SessionId;
    // Both processes capture the still-active ledger before either operation
    // starts. A pause must retain the other process's in-flight usage scope.
    const scope = await service.captureUsage({ sessionId });
    await writeFile(join(directory, `${workerId}.${index}.ready`), String(process.pid), "utf8");
    await waitForFile(join(directory, `${index}.start`));
    if (scenario === "pause" && workerId === "alpha") {
      await service.pauseActiveGoal({ sessionId });
    } else {
      const tokens = scenario === "duplicate" ? 11 : scenario === "pause" ? 5 : workerId === "alpha" ? 3 : 7;
      const result = await service.accountUsage({
        sessionId,
        turnId: `${sessionPrefix}_${scenario === "duplicate" ? "shared" : workerId}_${index}` as TurnId,
        usage: { totalTokens: tokens },
        timeSeconds: scenario === "distinct" && workerId === "beta" ? 2 : 1,
        scope,
      });
      if (result.usageDelta) accounted += 1;
    }
  }
  console.log(JSON.stringify({ pid: process.pid, workerId, rounds, accounted }));
} finally {
  store.close();
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await access(path).then(() => true, () => false)) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for Goal process barrier: ${path}`);
}
