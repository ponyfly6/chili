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

/** Registers one Host; session ownership is acquired independently on writes. */
export class HostOwnerClaim {
  readonly token = randomUUID();
  private readonly db: Database;
  private released = false;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec("pragma busy_timeout = 10000");
      this.db.exec("pragma synchronous = FULL");
      this.db.transaction(() => {
        this.db.exec(`create table if not exists host_guardians (
          token text not null, pid integer not null, primary key(token, pid)
        )`);
        const columns = this.db.query<{ name: string }, []>("pragma table_info(host_owner)").all();
        if (columns.some((column) => column.name === "singleton")) {
          const legacy = this.db.query<OwnerRow, []>("select token, pid, hostname from host_owner").all();
          for (const owner of legacy) {
            const blocker = hostOwnerBlockingPid(this.db, owner.token);
            if (blocker !== undefined) throw new HostOwnerConflictError(blocker, "Close the previous Host before upgrading its ownership store");
          }
          const guardian = this.db.query<{ pid: number }, []>("select pid from host_guardians").all().find((row) => guardianMayBeAlive(row.pid));
          if (guardian) throw new HostOwnerConflictError(guardian.pid, "The previous Host's guardian is still cleaning up");
          // Dropping singleton also makes old constructors fail before their
          // unscoped guardian deletion, even when this registry is empty.
          this.db.exec("drop table host_owner");
          this.db.exec("delete from host_guardians");
        }
        this.db.exec(`create table if not exists host_owner (
          token text primary key, pid integer not null, hostname text not null, started_at integer not null
        )`);
        this.db.query("insert into host_owner values (?, ?, ?, ?)")
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
      const owner = this.db.query<{ token: string }, [string]>("select token from host_owner where token = ?").get(this.token);
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
        if (this.db.query<{ found: number }, []>("select 1 as found from sqlite_master where type = 'table' and name = 'session_host_owners'").get()) {
          this.db.query("delete from session_host_owners where owner_token = ?").run(this.token);
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

/** Undefined means this Host and all its registered process groups have stopped. */
export function hostOwnerBlockingPid(db: Database, token: string): number | undefined {
  const owner = db.query<OwnerRow, [string]>("select token, pid, hostname from host_owner where token = ?").get(token);
  if (owner && (owner.hostname !== hostname() || processMayBeAlive(owner.pid))) return owner.pid;
  const guardians = db.query<{ pid: number }, [string]>("select pid from host_guardians where token = ?").all(token);
  return guardians.find((guardian) => guardianMayBeAlive(guardian.pid))?.pid;
}
