export interface ParentLossWatchdog {
  arm(): void;
  disarm(): void;
}

export const SIDECAR_GRACEFUL_SHUTDOWN_FRAME = "chili.sidecar.shutdown\n";

export interface OwnedProcessControl {
  platform: NodeJS.Platform;
  kill(pid: number, signal: NodeJS.Signals): void;
  exit(code: number): never;
  writeError(message: string): void;
}

export function createParentLossWatchdog(options: {
  deadlineMs: number;
  onDeadline(): void;
}): ParentLossWatchdog {
  if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new TypeError("Parent-loss watchdog deadline must be a positive integer");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    arm() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        options.onDeadline();
      }, options.deadlineMs);
      // Deliberately keep this timer referenced. It is the last-resort owner
      // boundary when Electron is gone and runtime shutdown never settles.
    },
    disarm() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function forceKillOwnedProcessGroups(
  toolProcessGroups: ReadonlySet<number>,
  ownPid = process.pid,
  control: OwnedProcessControl = defaultOwnedProcessControl(),
): never {
  for (const pid of toolProcessGroups) killOwnedProcess(pid, true, control);
  if (control.platform !== "win32") {
    // The desktop supervisor always launches the sidecar detached, making its
    // PID the PGID inherited by MCP and other non-detached descendants.
    killOwnedProcess(ownPid, true, control);
  }
  // The current packaged MVP is macOS. On Windows the registered tool leaders
  // were killed directly above before terminating the sidecar itself.
  control.exit(1);
}

function killOwnedProcess(pid: number, group: boolean, control: OwnedProcessControl): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    control.kill(group && control.platform !== "win32" ? -pid : pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try {
        control.writeError(`[sidecar] failed to kill owned process ${pid}\n`);
      } catch {
        // The parent may have closed all inherited output handles.
      }
    }
  }
}

function defaultOwnedProcessControl(): OwnedProcessControl {
  return {
    platform: process.platform,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    exit: (code) => process.exit(code),
    writeError: (message) => {
      process.stderr.write(message);
    },
  };
}
