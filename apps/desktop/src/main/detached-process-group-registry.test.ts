import { spawn } from "node:child_process";
import { expect, test } from "bun:test";
import { DetachedProcessGroupRegistry } from "./detached-process-group-registry.js";
import { processGroupExists } from "./process-groups.js";

test("close seals admission, contains registered groups, and is idempotent", async () => {
  if (process.platform === "win32") return;
  const registry = new DetachedProcessGroupRegistry({ termGraceMs: 100, killGraceMs: 500 });
  const child = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], {
    detached: true,
    stdio: "ignore",
  });
  const leaderPid = child.pid;
  if (!leaderPid) throw new Error("Fixture process did not receive a PID");
  registry.register(leaderPid);

  const firstClose = registry.close();
  expect(registry.signal.aborted).toBe(true);
  expect(registry.close()).toBe(firstClose);
  const lateChild = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], {
    detached: true,
    stdio: "ignore",
  });
  const lateLeaderPid = lateChild.pid;
  if (!lateLeaderPid) throw new Error("Late fixture process did not receive a PID");
  registry.register(lateLeaderPid);
  expect(registry.activeProcessGroupIds()).toContain(lateLeaderPid);
  await firstClose;

  expect(processGroupExists(leaderPid)).toBe(false);
  expect(processGroupExists(lateLeaderPid)).toBe(false);
  expect(registry.activeProcessGroupIds()).toEqual([]);
});

test("forceKillAll synchronously seals and signals every registered group", async () => {
  if (process.platform === "win32") return;
  const registry = new DetachedProcessGroupRegistry({ termGraceMs: 100, killGraceMs: 500 });
  const child = spawn("/bin/sh", ["-c", "while :; do sleep 1; done"], {
    detached: true,
    stdio: "ignore",
  });
  const leaderPid = child.pid;
  if (!leaderPid) throw new Error("Fixture process did not receive a PID");
  registry.register(leaderPid);

  registry.forceKillAll();
  expect(registry.signal.aborted).toBe(true);
  await registry.close();

  expect(processGroupExists(leaderPid)).toBe(false);
});
