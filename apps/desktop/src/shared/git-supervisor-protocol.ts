export const GIT_SUPERVISOR_MODE = "--chili-git-supervisor-v1";
export const GIT_OWNER_FD = 3;
// One full-duplex socket: receiving the owner frame proves the result channel
// is connected before Git can finish. A second pipe can race startup in Bun.
export const GIT_RESULT_FD = GIT_OWNER_FD;
export const MAX_GIT_SUPERVISOR_FRAME_BYTES = 128;

export interface GitSupervisorResult {
  code: number | null;
  signal: string | null;
}

export function encodeGitOwnerFrame(parentPid: number, supervisorPid: number): string {
  requirePid(parentPid);
  requirePid(supervisorPid);
  return `chili.git.owner.v1:${parentPid}:${supervisorPid}\n`;
}

export function parseGitOwnerFrame(frame: Buffer): { parentPid: number; supervisorPid: number } {
  const match = /^chili\.git\.owner\.v1:([1-9][0-9]*):([1-9][0-9]*)\n$/u.exec(frame.toString("ascii"));
  if (!match || frame.length > MAX_GIT_SUPERVISOR_FRAME_BYTES) throw new Error("Invalid Git owner frame");
  const parentPid = Number(match[1]);
  const supervisorPid = Number(match[2]);
  if (!frame.equals(Buffer.from(encodeGitOwnerFrame(parentPid, supervisorPid), "ascii"))) {
    throw new Error("Invalid Git owner frame");
  }
  return { parentPid, supervisorPid };
}

export function encodeGitResultFrame(result: GitSupervisorResult): Buffer {
  const frame = Buffer.from(`chili.git.result.v1:${result.code ?? "-"}:${result.signal ?? "-"}\n`, "ascii");
  parseGitResultFrame(frame);
  return frame;
}

export function parseGitResultFrame(frame: Buffer): GitSupervisorResult {
  const match = /^chili\.git\.result\.v1:(-|0|[1-9][0-9]{0,2}):(-|SIG[A-Z0-9]{1,20})\n$/u.exec(frame.toString("ascii"));
  if (!match || frame.length > MAX_GIT_SUPERVISOR_FRAME_BYTES) throw new Error("Invalid Git result frame");
  const code = match[1] === "-" ? null : Number(match[1]);
  const signal = match[2] === "-" ? null : match[2]!;
  if ((code === null) === (signal === null) || (code !== null && code > 255)
    || !frame.equals(Buffer.from(`chili.git.result.v1:${code ?? "-"}:${signal ?? "-"}\n`, "ascii"))) {
    throw new Error("Invalid Git result frame");
  }
  return { code, signal };
}

function requirePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Git owner PID");
}
