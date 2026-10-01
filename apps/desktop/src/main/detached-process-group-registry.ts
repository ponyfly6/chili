import { processGroupExists, terminateProcessGroup } from "./process-groups.js";

interface ProcessGroupEntry {
  containment?: Promise<void>;
}

export interface DetachedProcessGroupRegistryOptions {
  termGraceMs?: number;
  killGraceMs?: number;
}

/**
 * Owns detached process groups created by the Electron main process. Closing
 * seals admission synchronously, aborts in-flight command owners, and retains
 * every group until its absence has been confirmed.
 */
export class DetachedProcessGroupRegistry {
  private readonly groups = new Map<number, ProcessGroupEntry>();
  private readonly abortController = new AbortController();
  private closePromise: Promise<void> | undefined;
  private sealed = false;

  constructor(private readonly options: DetachedProcessGroupRegistryOptions = {}) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  register(leaderPid: number): () => void {
    requireLeaderPid(leaderPid);
    if (this.groups.has(leaderPid)) throw new Error(`Process group ${leaderPid} is already registered`);
    this.groups.set(leaderPid, {});
    if (this.sealed) void this.contain(leaderPid).catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!processGroupExists(leaderPid)) this.groups.delete(leaderPid);
    };
  }

  activeProcessGroupIds(): readonly number[] {
    return [...this.groups.keys()];
  }

  contain(leaderPid: number): Promise<void> {
    const entry = this.groups.get(leaderPid);
    if (!entry) return Promise.resolve();
    entry.containment ??= terminateProcessGroup(leaderPid, this.options).then(() => {
      if (processGroupExists(leaderPid)) {
        throw new Error(`Process group ${leaderPid} remained present after containment`);
      }
      this.groups.delete(leaderPid);
    });
    return entry.containment;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.seal();
    this.closePromise = this.drainUntilEmpty();
    return this.closePromise;
  }

  forceKillAll(): void {
    this.seal();
    for (const leaderPid of this.groups.keys()) {
      try {
        signalProcessGroup(leaderPid, "SIGKILL");
      } catch {
        // Forced native exit cannot wait or stop after one failed signal. The
        // IDs remain registered for diagnostics and any still-running close.
      }
    }
  }

  private seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    this.abortController.abort(new Error("Desktop main process containment started"));
  }

  private async drainUntilEmpty(): Promise<void> {
    while (true) {
      const leaderPids = [...this.groups.keys()];
      if (leaderPids.length === 0) {
        // A command that has already returned from spawn must register in the
        // same JavaScript turn. One quiet microtask makes that race part of
        // this close without opening admission again.
        await Promise.resolve();
        if (this.groups.size === 0) return;
        continue;
      }
      await Promise.all(leaderPids.map((leaderPid) => this.contain(leaderPid)));
    }
  }
}

function requireLeaderPid(leaderPid: number): void {
  if (!Number.isSafeInteger(leaderPid) || leaderPid <= 0) {
    throw new RangeError("Detached process group leader PID must be a positive safe integer");
  }
}

function signalProcessGroup(leaderPid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? leaderPid : -leaderPid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
}
