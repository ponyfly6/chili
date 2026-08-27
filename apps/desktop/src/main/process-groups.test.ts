import { spawn } from "node:child_process";
import { expect, test } from "bun:test";
import { processGroupExists, terminateProcessGroup } from "./process-groups.js";

test("terminates a detached tool group after its leader exits with a descendant alive", async () => {
  if (process.platform === "win32") return;
  const leader = spawn("bash", ["-lc", "sleep 30 >/dev/null 2>&1 & echo $!; exit 0"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const leaderPid = leader.pid;
  if (!leaderPid) throw new Error("fixture leader did not receive a PID");
  const exited = leader.exitCode !== null || leader.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolvePromise) => leader.once("exit", () => resolvePromise()));
  const descendantPid = Number.parseInt((await readAll(leader.stdout)).trim(), 10);
  await exited;

  expect(processGroupExists(leaderPid)).toBe(true);
  expect(pidExists(descendantPid)).toBe(true);
  await terminateProcessGroup(leaderPid, { termGraceMs: 200, killGraceMs: 500 });
  expect(processGroupExists(leaderPid)).toBe(false);
  await waitFor(() => !pidExists(descendantPid));
});

async function readAll(stream: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs}ms`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
