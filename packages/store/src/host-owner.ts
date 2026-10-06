import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export class HostOwnerConflictError extends Error {
  override readonly name = "HostOwnerConflictError";
  constructor(readonly ownerPid: number, detail = "The store already has a live execution owner") {
    super(`${detail} (PID ${ownerPid}). Cross-process attach is not supported; use the owning Host or close it first.`);
  }
}

interface OwnerRow { token: string; pid: number; hostname: string }

/** Liveness is deliberately separate from session lease expiry. */
export class HostOwnerClaim {
  readonly token = randomUUID();
  private readonly db: Database;
  private released = false;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec("pragma busy_timeout = 10000");
      this.db.exec("pragma synchronous = FULL");
      this.db.exec(`create table if not exists host_owner (
        singleton integer primary key check(singleton = 1), token text not null,
        pid integer not null, hostname text not null, started_at integer not null
      )`);
      this.db.exec(`create table if not exists host_guardians (
        token text not null, pid integer not null, primary key(token, pid)
      )`);
      this.db.transaction(() => {
        const owner = this.db.query<OwnerRow, []>("select token, pid, hostname from host_owner where singleton = 1").get();
        if (owner) {
          if (owner.hostname !== hostname() || processMayBeAlive(owner.pid)) {
            throw new HostOwnerConflictError(owner.pid);
          }
          const guardians = this.db.query<{ pid: number }, [string]>("select pid from host_guardians where token = ?").all(owner.token);
          for (const guardian of guardians) {
            if (guardianMayBeAlive(guardian.pid)) {
              throw new HostOwnerConflictError(guardian.pid, "The previous owner's process guardian is still cleaning up");
            }
          }
        }
        this.db.exec("delete from host_guardians");
        this.db.query("insert or replace into host_owner values (1, ?, ?, ?, ?)")
          .run(this.token, process.pid, hostname(), Date.now());
      }).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  registerGuardian(pid: number): void {
    if (this.released) throw new Error("Host ownership has been released");
    this.db.transaction(() => {
      const owner = this.db.query<{ token: string }, []>("select token from host_owner where singleton = 1").get();
      if (owner?.token !== this.token) throw new Error("Host ownership changed before process launch");
      this.db.query("insert or ignore into host_guardians (token, pid) values (?, ?)").run(this.token, pid);
    }).immediate();
  }

  unregisterGuardian(pid: number): void {
    if (this.released) return;
    this.db.query("delete from host_guardians where token = ? and pid = ?").run(this.token, pid);
  }

  release(): void {
    if (this.released) return;
    try {
      this.db.transaction(() => {
        const guardians = this.db.query<{ pid: number }, [string]>("select pid from host_guardians where token = ?").all(this.token);
        if (guardians.some((guardian) => guardianMayBeAlive(guardian.pid))) {
          throw new Error("Cannot release Host ownership while a registered process guardian is alive");
        }
        this.db.query("delete from host_guardians where token = ?").run(this.token);
        this.db.query("delete from host_owner where token = ?").run(this.token);
      }).immediate();
    } finally {
      this.released = true;
      this.db.close();
    }
  }
}

function processMayBeAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) {
    // EPERM and unknown errors must not grant a competing execution owner.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function guardianMayBeAlive(pid: number): boolean {
  if (processMayBeAlive(pid)) return true;
  if (process.platform === "win32") return false;
  try { process.kill(-pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
