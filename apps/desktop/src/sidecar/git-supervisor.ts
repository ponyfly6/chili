import { spawn, spawnSync } from "node:child_process";
import { fstatSync, read, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { gitEnvironment } from "../shared/git-environment.js";
import {
  encodeGitResultFrame,
  GIT_OWNER_FD,
  GIT_RESULT_FD,
  MAX_GIT_SUPERVISOR_FRAME_BYTES,
  parseGitOwnerFrame,
} from "../shared/git-supervisor-protocol.js";

const OPERATIONS = new Set([
  "ls-files\0--cached\0--stage\0-z",
  "ls-files\0--others\0--exclude-standard\0-z",
  "cat-file\0-e\0HEAD^{tree}",
  "ls-tree\0-r\0-l\0-z\0--full-tree\0HEAD",
  "cat-file\0--batch-check",
  "cat-file\0--batch",
]);

/** A process-group owner that remains alive when Electron is killed. */
export async function runGitSupervisor(args: readonly string[]): Promise<void> {
  let ownsGroup = false;
  let ownerGone = false;
  const contain = (): never => {
    if (ownsGroup) {
      try { process.kill(-process.pid, "SIGKILL"); } catch { /* Exit if the group is already gone. */ }
    }
    process.exit(1);
  };
  const ownerLost = (): void => {
    ownerGone = true;
    if (ownsGroup) contain();
  };
  process.on("SIGTERM", ownerLost);
  process.on("SIGINT", ownerLost);
  process.on("uncaughtException", contain);
  process.on("unhandledRejection", contain);

  try {
    if (process.platform === "win32") throw new Error("Git supervisor requires POSIX process groups");
    if (!fstatSync(GIT_OWNER_FD).isSocket()) throw new Error("Git supervisor requires a private duplex socket");
    validateGitArgs(args);
    let completeFrame = false;
    let frame = Buffer.alloc(0);
    let acceptOwner: (parentPid: number) => void = () => undefined;
    const ownerReady = new Promise<number>((resolve) => { acceptOwner = resolve; });
    const onOwnershipData = (bytes: Buffer): void => {
      if (completeFrame || frame.length + bytes.length > MAX_GIT_SUPERVISOR_FRAME_BYTES) return ownerLost();
      frame = Buffer.concat([frame, bytes]);
      if (!frame.includes(0x0a)) return;
      try {
        const owner = parseGitOwnerFrame(frame);
        if (owner.supervisorPid !== process.pid) return ownerLost();
        completeFrame = true;
        acceptOwner(owner.parentPid);
      } catch {
        ownerLost();
      }
    };
    // Node and Bun inherit differently flagged pipes. Async read supports
    // blocking descriptors; retry EAGAIN on nonblocking macOS socketpairs
    // instead of interpreting temporary unavailability as parent death.
    const readBuffer = Buffer.alloc(MAX_GIT_SUPERVISOR_FRAME_BYTES + 1);
    const readOwner = (): void => {
      read(GIT_OWNER_FD, readBuffer, 0, readBuffer.length, null, (error, bytesRead) => {
        if (error) {
          if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK" || error.code === "EINTR") {
            setTimeout(readOwner, 10);
          } else ownerLost();
          return;
        }
        if (bytesRead === 0) return ownerLost();
        onOwnershipData(readBuffer.subarray(0, bytesRead));
        if (!ownerGone) readOwner();
      });
    };
    readOwner();

    // Never signal -pid until the OS confirms this helper is the group leader.
    // The fixed ps command neither reads repository config nor inherits fd 3.
    const group = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "pgid="], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      encoding: "utf8", timeout: 1_000, maxBuffer: 128,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (group.status !== 0 || group.stdout.trim() !== String(process.pid)) contain();
    ownsGroup = true;
    if (ownerGone) contain();
    const startupDeadline = setTimeout(contain, 2_000);
    const parentPid = await ownerReady;
    clearTimeout(startupDeadline);
    if (ownerGone || process.ppid !== parentPid) contain();

    const git = spawn("/usr/bin/git", [...args], {
      cwd: args[3]!.slice("--work-tree=".length), env: gitEnvironment(), detached: false,
      // Git gets only its data streams, never the owner/result capabilities.
      stdio: [0, 1, 2],
    });
    git.once("error", contain);
    git.once("exit", (code, signal) => {
      try {
        const result = encodeGitResultFrame({ code, signal });
        let offset = 0;
        while (offset < result.length) {
          const written = writeSync(GIT_RESULT_FD, result, offset, result.length - offset);
          if (written <= 0) break;
          offset += written;
        }
      } finally {
        // Kill the entire group even after Git exits: descendants may still
        // own output handles. The terminal frame carries Git's actual result.
        contain();
      }
    });
  } catch {
    contain();
  }
}

function validateGitArgs(args: readonly string[]): void {
  if (args.length > 16 || args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 128 * 1024
    || args.some((arg) => arg.includes("\0"))
    || args[0] !== "--no-pager" || args[1] !== "--no-replace-objects"
    || !args[2]?.startsWith("--git-dir=") || !isAbsolute(args[2].slice("--git-dir=".length))
    || !args[3]?.startsWith("--work-tree=") || !isAbsolute(args[3].slice("--work-tree=".length))
    || args[4] !== "-c" || args[5] !== "core.fsmonitor=false"
    || !OPERATIONS.has(args.slice(6).join("\0"))) {
    throw new Error("Invalid Git supervisor command");
  }
}
