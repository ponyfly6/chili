const DEFAULT_TERM_GRACE_MS = 1_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

export interface TerminateProcessGroupOptions {
  termGraceMs?: number;
  killGraceMs?: number;
}

export async function terminateProcessGroup(
  leaderPid: number,
  options: TerminateProcessGroupOptions = {},
): Promise<void> {
  if (!Number.isSafeInteger(leaderPid) || leaderPid <= 0) return;
  if (process.platform === "win32") {
    sendPidSignal(leaderPid, "SIGTERM");
    await waitForPidExit(leaderPid, options.termGraceMs ?? DEFAULT_TERM_GRACE_MS);
    if (pidExists(leaderPid)) sendPidSignal(leaderPid, "SIGKILL");
    if (!await waitForPidExit(leaderPid, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS)) {
      throw new Error(`Process ${leaderPid} survived SIGKILL`);
    }
    return;
  }

  sendGroupSignal(leaderPid, "SIGTERM");
  if (await waitForGroupExit(leaderPid, options.termGraceMs ?? DEFAULT_TERM_GRACE_MS)) return;
  sendGroupSignal(leaderPid, "SIGKILL");
  if (!await waitForGroupExit(leaderPid, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS)) {
    throw new Error(`Process group ${leaderPid} survived SIGKILL`);
  }
}

export function processGroupExists(leaderPid: number): boolean {
  if (!Number.isSafeInteger(leaderPid) || leaderPid <= 0) return false;
  if (process.platform === "win32") return pidExists(leaderPid);
  try {
    process.kill(-leaderPid, 0);
    return true;
  } catch (error) {
    return isPermissionError(error);
  }
}

async function waitForGroupExit(leaderPid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processGroupExists(leaderPid)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (pidExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(20);
  }
  return true;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionError(error);
  }
}

function sendGroupSignal(leaderPid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-leaderPid, signal);
  } catch {
    // The group may have disappeared after the preceding existence check.
  }
}

function sendPidSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have disappeared after the preceding existence check.
  }
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
