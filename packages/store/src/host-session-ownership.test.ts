import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import type { SessionId, TimestampMs } from "@chili/protocol";
import { HostOwnerClaim, HostOwnerConflictError } from "./host-owner.js";
import { HostSessionOwnerConflictError, SqliteEventStore } from "./sqlite-event-store.js";
import { ObservableEventStore } from "./observable-event-store.js";

const time = () => Date.now() as TimestampMs;
const sid = (id: string) => id as SessionId;
const created = (id: SessionId, cwd: string) => ({ id: crypto.randomUUID(), type: "session.created" as const, sessionId: id, time: time(), payload: { sessionId: id, cwd } });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "chili-host-sessions-"));
  const path = join(cwd, "events.sqlite");
  const a = new HostOwnerClaim(path);
  const b = new HostOwnerClaim(path);
  const first = new SqliteEventStore(path, { hostOwnerToken: a.token });
  const second = new SqliteEventStore(path, { hostOwnerToken: b.token });
  const db = new Database(path);
  return { cwd, path, a, b, first, second, db, async close() {
    await Promise.all([first.flushInputMirrors(), second.flushInputMirrors()]);
    first.close(); second.close(); a.release(); b.release(); db.close();
    await rm(cwd, { recursive: true, force: true });
  } };
}

const accept = (sessionId: SessionId, id: string) => ({ kind: "accept" as const, sessionId, submissionId: id, inputId: id, mode: "queue" as const, payload: "{}", text: "task", source: "local" });

test("different Hosts own different root sessions; reads do not acquire and idle ownership lasts until close", async () => {
  const f = await fixture();
  try {
    const a = sid("root_a"), b = sid("root_b");
    await f.first.append(created(a, f.cwd)); await f.second.append(created(b, f.cwd));
    expect((await f.second.sessions()).map((row) => row.id).sort()).toEqual([a, b]);
    expect(await f.second.messages(a)).toEqual([]);
    expect(f.second.canRecoverSession(a)).toBe(false);
    expect(() => f.second.acquireSessionOwnership(a)).toThrow(HostSessionOwnerConflictError);
    expect(() => f.second.mutateSessionInputs(accept(a, "foreign"))).toThrow(HostSessionOwnerConflictError);
    await expect(f.second.append({ id: crypto.randomUUID(), type: "session.renamed", sessionId: a, time: time(), payload: { sessionId: a, title: "foreign" } })).rejects.toThrow(HostSessionOwnerConflictError);
    f.first.mutateSessionInputs(accept(a, "owned"));
    expect(f.first.sessionInputQueue(a).pendingCount).toBe(1);
    f.a.release();
    const wrapped = new ObservableEventStore(f.second);
    expect(wrapped.acquireSessionOwnership!(a)).toBe(true);
    expect(wrapped.acquireSessionOwnership!(a)).toBe(false);
    expect(wrapped.canRecoverSession!(a)).toBe(true);
    expect(() => f.first.mutateSessionInputs(accept(a, "released"))).toThrow("registration has been released");
    expect(f.db.query<{ count: number }, []>("select count(*) as count from host_owner").get()?.count).toBe(1);
  } finally { await f.close(); }
});

test("expired leases and pending recovery cannot steal an idle live Host's root", async () => {
  const f = await fixture();
  try {
    const root = sid("root_expired"); await f.first.append(created(root, f.cwd));
    f.first.mutateSessionInputs(accept(root, "pending"));
    const now = Date.now();
    expect(f.first.claimSessionRun({ sessionId: root, claimId: "run", time: now, leaseDurationMs: 1000 }).status).toBe("claimed");
    f.db.query("update session_run_claims set lease_expires_at = 0 where session_id = ?").run(root);
    expect(() => f.second.claimSessionRun({ sessionId: root, claimId: "foreign_run", time: now + 2000, leaseDurationMs: 1000 })).toThrow(HostSessionOwnerConflictError);
    expect(() => f.second.mutateSessionInputs({ kind: "recover", sessionId: root })).toThrow(HostSessionOwnerConflictError);
    expect(f.first.sessionInputQueue(root).pendingCount).toBe(1);
    await f.second.reconcileStaleTurns({ now, staleBefore: now, createId: () => crypto.randomUUID() });
    expect(f.second.canRecoverSession(root)).toBe(false);
  } finally { await f.close(); }
});

test("child creation and its initial input inherit the parent's Host ownership", async () => {
  const f = await fixture();
  try {
    const root = sid("root_parent"), child = sid("child"); await f.first.append(created(root, f.cwd));
    f.first.claimSessionRun({ sessionId: root, claimId: "parent_run", time: Date.now(), leaseDurationMs: 60000 });
    await f.first.createChildSession({ sessionId: child, parentSessionId: root, name: "child", cwd: f.cwd, policy: {}, runClaim: { sessionId: root, claimId: "parent_run" }, initialInput: { ...accept(child, "initial"), mode: "queue" } });
    expect(f.first.sessionInputQueue(child).pendingCount).toBe(1);
    expect(() => f.second.acquireSessionOwnership(child)).toThrow(HostSessionOwnerConflictError);
    expect(() => f.second.mutateSessionInputs({ kind: "recover", sessionId: child }, { sessionAccess: "child" })).toThrow(HostSessionOwnerConflictError);
    expect(f.db.query<{ root_session_id: string }, []>("select root_session_id from session_host_owners").all()).toEqual([{ root_session_id: root }]);
    f.first.releaseSessionRun({ sessionId: root, claimId: "parent_run" });
  } finally { await f.close(); }
});

test("dead owner cannot be replaced while a registered guardian is alive; other roots remain available", async () => {
  const f = await fixture();
  try {
    const root = sid("root_guarded"); await f.first.append(created(root, f.cwd));
    const exited = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" }); await exited.exited;
    f.first.claimSessionRun({ sessionId: root, claimId: "dead_run", time: Date.now(), leaseDurationMs: 60000 });
    f.a.registerGuardian(process.pid);
    f.db.query("update host_owner set pid = ? where token = ?").run(exited.pid, f.a.token);
    expect(() => f.second.acquireSessionOwnership(root)).toThrow(HostSessionOwnerConflictError);
    expect(f.second.sessionRunClaim(root)?.claimId).toBe("dead_run");
    await f.second.append(created(sid("other_root"), f.cwd));
    f.a.unregisterGuardian(process.pid);
    f.second.acquireSessionOwnership(root);
    expect(f.second.sessionRunClaim(root)).toBeUndefined();
    expect(f.second.claimSessionRun({ sessionId: root, claimId: "replacement", time: Date.now(), leaseDurationMs: 60000 }).status).toBe("claimed");
    f.second.releaseSessionRun({ sessionId: root, claimId: "replacement" });
    expect(f.second.canRecoverSession(root)).toBe(true);
  } finally { await f.close(); }
});

test("legacy ownership migration refuses live Hosts and prevents old constructors deleting new guardians", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chili-owner-upgrade-"));
  const path = join(cwd, "legacy.sqlite"); const db = new Database(path);
  let owner: HostOwnerClaim | undefined;
  try {
    db.exec("create table host_owner(singleton integer primary key, token text, pid integer, hostname text, started_at integer)");
    db.exec("create table host_guardians(token text, pid integer, primary key(token,pid))");
    db.query("insert into host_owner values(1,'legacy',?,?,0)").run(process.pid, hostname());
    expect(() => new HostOwnerClaim(path)).toThrow(HostOwnerConflictError);
    const exited = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" }); await exited.exited;
    db.query("update host_owner set pid = ?").run(exited.pid);
    db.query("insert into host_guardians values('legacy',?)").run(process.pid);
    expect(() => new HostOwnerClaim(path)).toThrow(HostOwnerConflictError);
    db.exec("delete from host_guardians"); owner = new HostOwnerClaim(path); owner.registerGuardian(process.pid);
    expect(() => db.transaction(() => {
      db.query("select token,pid,hostname from host_owner where singleton = 1").get();
      db.exec("delete from host_guardians");
    }).immediate()).toThrow("singleton");
    expect(db.query<{ count: number }, []>("select count(*) as count from host_guardians").get()?.count).toBe(1);
    owner.unregisterGuardian(process.pid);
  } finally { owner?.release(); db.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("taking over a stopped Host recovers its whole Agent tree without waiting for old leases", async () => {
  const f = await fixture();
  try {
    const root = sid("root_orphan"), child = sid("child_orphan");
    await f.first.append(created(root, f.cwd));
    f.first.claimSessionRun({ sessionId: root, claimId: "parent_run", time: Date.now(), leaseDurationMs: 60000 });
    await f.first.createChildSession({ sessionId: child, parentSessionId: root, name: "child", cwd: f.cwd, policy: {}, runClaim: { sessionId: root, claimId: "parent_run" }, initialInput: { ...accept(child, "child_pending"), mode: "queue" } });
    f.first.mutateSessionInputs({ kind: "claim", sessionId: child, claimId: "child_run", executionRef: "child_execution", leaseDurationMs: 60000 }, { sessionAccess: "child" });
    const exited = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" }); await exited.exited;
    f.db.query("update host_owner set pid = ? where token = ?").run(exited.pid, f.a.token);
    expect(f.second.acquireSessionOwnership(child)).toBe(true);
    expect(f.second.sessionRunClaim(root)).toBeUndefined();
    expect(f.second.sessionRunClaim(child)).toBeUndefined();
    f.second.mutateSessionInputs({ kind: "recover", sessionId: child }, { sessionAccess: "child" });
    expect(f.second.sessionInputQueue(child).paused).toBe(true);
    expect(f.second.sessionInput(child, "child_pending")?.outcome).toBe("interrupted");
    expect(() => f.first.mutateSessionInputs(accept(root, "stale_write"))).toThrow(HostSessionOwnerConflictError);
  } finally { await f.close(); }
});

test("failed admission rolls back ownership acquisition and preserves read-only availability", async () => {
  const f = await fixture();
  const legacy = new SqliteEventStore(f.path);
  try {
    const root = sid("unowned_legacy"); await legacy.append(created(root, f.cwd));
    expect(() => f.first.mutateSessionInputs(accept(root, "wrong_role"), { sessionAccess: "child" })).toThrow("runtime access");
    expect(f.second.acquireSessionOwnership(root)).toBe(true);
    expect(f.second.sessionInputQueue(root).pendingCount).toBe(0);
  } finally { legacy.close(); await f.close(); }
});

test("claim admission preserves missing, inactive and role errors without acquiring ownership", async () => {
  const f = await fixture();
  const legacy = new SqliteEventStore(f.path);
  try {
    const missing = sid("missing"), inactive = sid("inactive"), root = sid("unowned_root");
    await legacy.append(created(inactive, f.cwd)); await legacy.append(created(root, f.cwd));
    await legacy.append({ id: crypto.randomUUID(), type: "session.archived", sessionId: inactive, time: time(), payload: { sessionId: inactive } });
    const claim = (sessionId: SessionId) => ({ sessionId, claimId: crypto.randomUUID(), time: Date.now(), leaseDurationMs: 60000 });
    expect(() => f.first.assertSessionOwnership(missing)).not.toThrow();
    expect(f.first.claimSessionRun(claim(missing))).toEqual({ status: "not_found" });
    expect(f.first.claimSessionRun(claim(inactive))).toEqual({ status: "inactive", sessionStatus: "archived" });
    expect(f.first.claimSessionRun({ ...claim(root), sessionAccess: "child" })).toEqual({ status: "forbidden" });
    expect(f.first.claimSessionCreation({ ...claim(root), cwd: f.cwd })).toEqual({ status: "already_exists" });
    expect(f.db.query<{ count: number }, []>("select count(*) as count from session_host_owners").get()?.count).toBe(0);
    expect(f.second.acquireSessionOwnership(root)).toBe(true);
    // Duplicate creation retains its old return value even when another Host owns it.
    expect(f.first.claimSessionCreation({ ...claim(root), cwd: f.cwd })).toEqual({ status: "already_exists" });
    expect(() => f.first.mutateSessionInputs(accept(missing, "missing_input"))).toThrow("does not exist");
  } finally { legacy.close(); await f.close(); }
});

test("maintenance leaves unopened legacy roots unowned until each Host explicitly acquires its own root", async () => {
  const f = await fixture();
  const legacy = new SqliteEventStore(f.path);
  try {
    const roots = [sid("legacy_maintenance_a"), sid("legacy_maintenance_b")];
    for (const root of roots) {
      await legacy.append(created(root, f.cwd));
      legacy.mutateSessionInputs(accept(root, `pending_${root}`));
      await legacy.append({ id: crypto.randomUUID(), type: "turn.started", sessionId: root, time: 1 as TimestampMs, payload: { turnId: `turn_${root}` as never } });
    }
    const reconcile = (store: SqliteEventStore) => store.reconcileStaleTurns({ staleBefore: Date.now(), now: Date.now(), createId: () => crypto.randomUUID() });
    expect(f.first.canRecoverSession(sid("missing"))).toBe(false);
    expect(legacy.canRecoverSession(roots[0]!)).toBe(true);
    expect(await reconcile(f.first)).toEqual([]);
    expect(await reconcile(f.second)).toEqual([]);
    expect(f.db.query<{ count: number }, []>("select count(*) as count from session_host_owners").get()?.count).toBe(0);
    for (const root of roots) {
      expect(f.first.canRecoverSession(root)).toBe(false);
      expect(f.second.canRecoverSession(root)).toBe(false);
      expect(legacy.sessionInputQueue(root).pendingCount).toBe(1);
    }
    f.first.acquireSessionOwnership(roots[0]!);
    f.second.acquireSessionOwnership(roots[1]!);
    expect(f.first.canRecoverSession(roots[0]!)).toBe(true);
    expect(f.first.canRecoverSession(roots[1]!)).toBe(false);
    const firstEvents = await reconcile(f.first);
    const secondEvents = await reconcile(f.second);
    expect(firstEvents.length).toBeGreaterThan(0);
    expect(secondEvents.length).toBeGreaterThan(0);
    expect(new Set(firstEvents.map((event) => event.sessionId))).toEqual(new Set([roots[0]]));
    expect(new Set(secondEvents.map((event) => event.sessionId))).toEqual(new Set([roots[1]]));
    f.first.mutateSessionInputs({ kind: "recover", sessionId: roots[0]! });
    f.second.mutateSessionInputs({ kind: "recover", sessionId: roots[1]! });
    expect(f.first.sessionInputQueue(roots[0]!).paused).toBe(true);
    expect(f.second.sessionInputQueue(roots[1]!).paused).toBe(true);
  } finally { legacy.close(); await f.close(); }
});
