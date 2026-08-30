export interface SmokeProcess {
  pid: number;
  parentPid: number;
  processGroupPid: number;
  startedAt: string;
  command: string;
  line: string;
}

/**
 * Ownership starts at a child returned by this runner's spawn call. Executable
 * paths, argv and user-data paths are classification data, never ownership.
 * Keep start identities so a stale PID or PGID cannot claim a later process.
 */
export class DesktopSmokeOwnership {
  private readonly identities = new Map<number, string>();
  private readonly groups = new Set<number>();
  private rows: SmokeProcess[] = [];

  registerSpawn(pid: number): void {
    const rows = readSmokeProcesses();
    const row = rows.find((entry) => entry.pid === pid);
    // Fast inspection tools may already have exited. They need no cleanup;
    // their PID must not be retroactively registered if it is reused.
    if (!row) return;
    if (row.parentPid !== process.pid) throw new Error(`Spawned PID ${pid} is not a child of this smoke run`);
    this.identities.set(pid, row.startedAt);
    if (row.processGroupPid === pid) this.groups.add(pid);
    this.observe(rows);
  }

  scan(): SmokeProcess[] {
    return this.observe(readSmokeProcesses());
  }

  /** Only live identities and their observed children can expand ownership. */
  private observe(rows: SmokeProcess[]): SmokeProcess[] {
    this.rows = rows;
    const live = new Map(rows.map((row) => [row.pid, row]));
    for (const [pid, startedAt] of this.identities) {
      if (live.get(pid)?.startedAt !== startedAt) this.identities.delete(pid);
    }
    for (const group of this.groups) {
      if (!rows.some((row) => row.processGroupPid === group && this.owns(row))) this.groups.delete(group);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (this.owns(row) || row.pid === process.pid) continue;
        const parent = live.get(row.parentPid);
        const parentOwned = parent && this.owns(parent);
        // A detached group remains ours after its leader exits only while a
        // previously observed member with the same start identity survives.
        const inheritedGroup = this.groups.has(row.processGroupPid);
        if (!parentOwned && !inheritedGroup) continue;
        this.identities.set(row.pid, row.startedAt);
        if (row.pid === row.processGroupPid) this.groups.add(row.pid);
        changed = true;
      }
    }
    return rows.filter((row) => this.owns(row));
  }

  private owns(row: SmokeProcess): boolean {
    return this.identities.get(row.pid) === row.startedAt;
  }

  isOwnedGroup(processGroupPid: number): boolean {
    const members = this.rows.filter((row) => row.processGroupPid === processGroupPid);
    const ownGroup = this.rows.find((row) => row.pid === process.pid)?.processGroupPid;
    return processGroupPid > 1
      && processGroupPid !== ownGroup
      && this.groups.has(processGroupPid)
      && members.length > 0
      && members.every((row) => this.owns(row));
  }

  signalPid(pid: number, signal: NodeJS.Signals): void {
    this.scan();
    const row = this.rows.find((entry) => entry.pid === pid);
    if (!row) return;
    if (pid <= 1 || pid === process.pid || !this.owns(row)) {
      throw new Error(`Refusing to signal PID ${pid} without current-run launch ownership`);
    }
    signalIfPresent(pid, signal);
  }

  signalGroup(processGroupPid: number, signal: NodeJS.Signals): void {
    this.scan();
    if (!this.rows.some((row) => row.processGroupPid === processGroupPid)) return;
    if (!this.isOwnedGroup(processGroupPid)) {
      throw new Error(`Refusing to signal process group ${processGroupPid} without current-run launch ownership`);
    }
    signalIfPresent(-processGroupPid, signal);
  }
}

export function readSmokeProcesses(): SmokeProcess[] {
  const result = Bun.spawnSync({
    cmd: ["/bin/ps", "-axo", "pid=,ppid=,pgid=,lstart=,command="],
    env: { ...process.env, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.exitCode !== 0) throw new Error("Unable to inspect smoke process launch identities");
  return result.stdout.toString().split(/\r?\n/u).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/u);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroupPid: Number(match[3]),
      startedAt: match[4]!.replace(/\s+/gu, " "),
      command: match[5]!,
      line,
    }];
  });
}

function signalIfPresent(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) throw error;
  }
}
