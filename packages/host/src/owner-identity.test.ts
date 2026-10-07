import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { SessionId } from "@chili/protocol";
import type { ModelStreamInput } from "@chili/core";
import { HostSessionOwnerConflictError, SqliteEventStore } from "@chili/store";
import { runProcess } from "@chili/tools";
import { createChiliHost, type ChiliHost } from "./host.js";
import { resolveHostExecutionIdentity } from "./identity.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "chili-owner-identity-")); dirs.push(dir);
  const cwd = join(dir, "workspace"); await mkdir(cwd);
  return { cwd, chiliHome: join(dir, "profile"), model: "fake", mcpConnectMode: "manual" as const, staleTurnRecoveryIntervalMs: false as const };
}

test("same-project Hosts own different sessions and release only their own session", async () => {
  const options = await workspace();
  const first = await createChiliHost(options);
  const second = await createChiliHost(options);
  let next: ChiliHost | undefined;
  try {
    const a = await first.service.createSession();
    const b = await second.service.createSession();
    const created = (await first.store.events({ sessionId: a.sessionId })).find((event) => event.type === "session.created");
    expect(created?.payload).toMatchObject({ identity: first.identity });
    await expect(second.service.acquireSession(a.sessionId)).rejects.toBeInstanceOf(HostSessionOwnerConflictError);
    expect((await Promise.all([
      first.service.submitPrompt({ sessionId: a.sessionId, text: "first" }),
      second.service.submitPrompt({ sessionId: b.sessionId, text: "second" }),
    ])).map((result) => result.status)).toEqual(["completed", "completed"]);
    await second.close();
    next = await createChiliHost(options);
    await expect(next.service.acquireSession(a.sessionId)).rejects.toBeInstanceOf(HostSessionOwnerConflictError);
    await next.service.acquireSession(b.sessionId);
    expect((await first.service.submitPrompt({ sessionId: a.sessionId, text: "still owned" })).status).toBe("completed");
  } finally { await next?.close(); await second.close(); await first.close(); }
});

test("starting a second Host does not pause pending input owned by the first Host", async () => {
  const options = await workspace();
  const first = await createChiliHost(options);
  let second: ChiliHost | undefined;
  try {
    const { sessionId } = await first.service.createSession();
    first.store.mutateSessionInputs({ kind: "accept", sessionId, submissionId: "pending_before_dispatch",
      inputId: "input_pending_before_dispatch", mode: "queue", source: "local", text: "queued work",
      payload: JSON.stringify({ sessionId, text: "queued work" }),
    });
    expect(first.store.sessionInputQueue(sessionId)).toMatchObject({ paused: false, pendingCount: 1 });
    second = await createChiliHost(options);
    expect(first.store.sessionInputQueue(sessionId)).toMatchObject({ paused: false, pendingCount: 1 });
    await second.close(); second = undefined;
    expect(first.store.sessionInputQueue(sessionId)).toMatchObject({ paused: false, pendingCount: 1 });
    await first.service.resumeInputs(sessionId);
    await first.service.waitForIdle();
    expect(first.store.sessionInput(sessionId, "pending_before_dispatch")).toMatchObject({ state: "settled", outcome: "completed" });
  } finally { await second?.close(); await first.close(); }
});

test("a previewing Host uses current model settings on first mutation and for new sessions", async () => {
  const options = await workspace();
  const requests: ModelStreamInput[] = [];
  const first = await createChiliHost(options);
  const second = await createChiliHost({ ...options, modelRouter: {
    async *stream(input) {
      requests.push(input);
      yield { type: "text_delta", text: "Current model fixture." };
      yield { type: "finish", reason: "stop" };
    },
  } });
  try {
    const { sessionId } = await first.service.createSession();
    const oldModel = { provider: "fixture", model: "old-preview" };
    const latestModel = { provider: "fixture", model: "latest-owner-selection" };
    await first.service.setModel({ sessionId, modelSelection: oldModel });
    expect((await second.service.getModelConfig(sessionId)).modelSelection).toEqual(oldModel);
    await first.service.setModel({ sessionId, modelSelection: latestModel });
    await first.close();

    // A new session must not inherit the global defaults cached by preview.
    const next = await second.service.createSession();
    expect((await second.service.getModelConfig(next.sessionId)).modelSelection).toEqual(latestModel);
    expect((await second.service.submitPrompt({ sessionId: next.sessionId, text: "new session uses current defaults" })).status).toBe("completed");
    expect(requests.at(-1)?.modelSelection).toEqual(latestModel);
    // First mutation acquires ownership without an explicit open/cache reset.
    expect((await second.service.setServiceTier({ sessionId, serviceTier: "standard" })).modelSelection).toEqual(latestModel);
    expect((await second.service.submitPrompt({ sessionId, text: "continue with current settings" })).status).toBe("completed");
    expect(requests.at(-1)?.modelSelection).toEqual(latestModel);
  } finally { await second.close(); await first.close(); }
});

test("Host startup leaves dead owners untouched until each session is explicitly acquired", async () => {
  if (process.platform === "win32") return;
  const options = await workspace();
  const fixture = join(options.cwd, "durable-owner-crash.ts");
  await writeFile(fixture, `
    import { writeFile } from "node:fs/promises";
    import { join } from "node:path";
    import { runProcess } from ${JSON.stringify(new URL("../../tools/src/index.ts", import.meta.url).pathname)};
    import { createChiliHost } from ${JSON.stringify(new URL("./host.ts", import.meta.url).pathname)};
    const cwd = ${JSON.stringify(options.cwd)};
    const host = await createChiliHost({ cwd, chiliHome: ${JSON.stringify(options.chiliHome)},
      mcpConnectMode: "manual", staleTurnRecoveryIntervalMs: false, sessionClaimLeaseMs: 60_000,
      modelRouter: { async *stream() {
        await runProcess("/bin/sh", ["-c", "trap '' TERM; echo $$ > durable-child.pid; sleep 60"], { cwd });
        yield { type: "finish", reason: "stop" };
      } },
    });
    const { sessionId } = await host.service.createSession();
    await writeFile(join(cwd, "durable-session.id"), sessionId);
    await host.service.submitPromptAsync({ sessionId, submissionId: "crash_submission", text: "durable input" });
    await host.service.waitForIdle();
  `);
  const peer = Bun.spawn([process.execPath, fixture], { cwd: options.cwd, stdout: "ignore", stderr: "pipe" });
  let childPid = 0;
  let restored: ChiliHost | undefined;
  try {
    await until(async () => {
      try { childPid = Number(await readFile(join(options.cwd, "durable-child.pid"), "utf8")); return childPid > 0; } catch { return false; }
    });
    const sessionId = (await readFile(join(options.cwd, "durable-session.id"), "utf8")) as SessionId;
    peer.kill("SIGKILL"); await peer.exited;
    await until(async () => !alive(childPid));
    const persisted = new SqliteEventStore(join(options.cwd, ".chili", "chili.sqlite"));
    try {
      expect(persisted.sessionRunClaim(sessionId)!.leaseExpiresAt).toBeGreaterThan(Date.now());
      expect(persisted.sessionInput(sessionId, "crash_submission")?.state).toBe("claimed");
    } finally { persisted.close(); }
    // Startup must not reserve every historical root before a user opens it.
    restored = await createChiliHost(options);
    expect(restored.store.sessionInput(sessionId, "crash_submission")?.state).toBe("claimed");
    expect(restored.store.sessionRunClaim(sessionId)!.leaseExpiresAt).toBeGreaterThan(Date.now());
    await restored.service.acquireSession(sessionId);
    expect(restored.store.sessionInput(sessionId, "crash_submission")).toMatchObject({ state: "settled", outcome: "interrupted" });
    expect(restored.store.sessionInputQueue(sessionId).paused).toBe(true);
    await restored.service.resumeInputs(sessionId);
    await restored.service.waitForIdle();
    expect(restored.store.sessionInput(sessionId, "crash_submission")).toMatchObject({ state: "settled", outcome: "completed" });
    expect((await restored.store.sessions()).map((session) => session.id)).toEqual([sessionId]);
  } finally {
    peer.kill("SIGKILL"); await peer.exited;
    await restored?.close();
    if (alive(childPid)) process.kill(childPid, "SIGKILL");
  }
}, 15_000);

test("startup does not reserve closed roots that different Hosts later open independently", async () => {
  const options = await workspace();
  const original = await createChiliHost(options);
  const a = await original.service.createSession();
  const b = await original.service.createSession();
  await original.close();
  const first = await createChiliHost(options);
  const second = await createChiliHost(options);
  try {
    // If either startup eagerly owned history, the other acquisition would fail.
    await first.service.acquireSession(a.sessionId);
    await second.service.acquireSession(b.sessionId);
    await expect(first.service.acquireSession(b.sessionId)).rejects.toBeInstanceOf(HostSessionOwnerConflictError);
    await expect(second.service.acquireSession(a.sessionId)).rejects.toBeInstanceOf(HostSessionOwnerConflictError);
    expect((await Promise.all([
      first.service.submitPrompt({ sessionId: a.sessionId, text: "continue root a" }),
      second.service.submitPrompt({ sessionId: b.sessionId, text: "continue root b" }),
    ])).map((result) => result.status)).toEqual(["completed", "completed"]);
    expect((await first.store.sessions()).map((session) => session.id).sort()).toEqual([a.sessionId, b.sessionId].sort());
  } finally { await second.close(); await first.close(); }
});

test("failed Host initialization releases its execution owner", async () => {
  const options = await workspace();
  await expect(createChiliHost({ ...options, mcpRuntimeFactory: async () => { throw new Error("fixture initialization failure"); } })).rejects.toThrow("fixture initialization failure");
  const next = await createChiliHost(options); await next.close();
});

test("profile and workspace aliases resolve stable identities without mixing profiles", async () => {
  const options = await workspace();
  const first = await resolveHostExecutionIdentity(options);
  const alias = await resolveHostExecutionIdentity({ ...options, cwd: join(options.cwd, "."), chiliHome: join(options.chiliHome, ".") });
  expect(alias).toEqual(first);
  const other = await resolveHostExecutionIdentity({ ...options, chiliHome: `${options.chiliHome}-other` });
  expect(other.profileId).not.toBe(first.profileId);
  expect(other.workspaceId).toBe(first.workspaceId);
});

test("closing another workspace Host does not release or inherit a live process", async () => {
  const left = await workspace(); const right = await workspace();
  let first: ChiliHost | undefined = await createChiliHost(left);
  const second = await createChiliHost(right);
  let release!: () => void;
  const controller = new AbortController();
  const started = new Promise<void>((resolve) => { release = resolve; });
  const session = await second.service.createSession();
  const operation = second.service.withSessionOperation(session.sessionId, async () => {
    await runProcess("/bin/sh", ["-c", "printf ready; sleep 30"], { cwd: right.cwd, signal: controller.signal, onRawOutput: () => release() });
  });
  try {
    await started;
    await first.close(); first = undefined;
    const reopened = await createChiliHost(left); await reopened.close();
  } finally {
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await first?.close(); await second.close();
  }
}, 15_000);

test("legacy auth-file configuration is preserved unless an explicit profile is selected", async () => {
  const options = await workspace();
  const previous = process.env.CHILI_AUTH_FILE;
  process.env.CHILI_AUTH_FILE = join(options.cwd, "legacy-auth.json");
  try {
    const implicit = await resolveHostExecutionIdentity({ cwd: options.cwd });
    expect(implicit.authPath).toBe(process.env.CHILI_AUTH_FILE);
    const explicit = await resolveHostExecutionIdentity(options);
    expect(explicit.authPath).toBe(join(explicit.profilePath, "auth.json"));
  } finally {
    if (previous === undefined) delete process.env.CHILI_AUTH_FILE;
    else process.env.CHILI_AUTH_FILE = previous;
  }
});

test("hard-killed Host session cannot be acquired until its external process group has stopped", async () => {
  if (process.platform === "win32") return;
  const options = await workspace();
  const child = Bun.spawn([process.execPath, new URL("./fixtures/owner-crash.ts", import.meta.url).pathname, options.cwd, options.chiliHome], {
    cwd: options.cwd, stdout: "ignore", stderr: "pipe",
  });
  let commandPid = 0;
  let replacement: ChiliHost | undefined;
  try {
    await until(async () => {
      try { commandPid = Number(await readFile(join(options.cwd, "owned-child.pid"), "utf8")); return commandPid > 0; } catch { return false; }
    });
    const sessionId = (await readFile(join(options.cwd, "owned-session.id"), "utf8")) as SessionId;
    replacement = await createChiliHost(options);
    await expect(replacement.service.acquireSession(sessionId)).rejects.toBeInstanceOf(HostSessionOwnerConflictError);
    child.kill("SIGKILL"); await child.exited;
    if (alive(commandPid)) {
      await expect(replacement.service.acquireSession(sessionId)).rejects.toBeInstanceOf(HostSessionOwnerConflictError);
    }
    await until(async () => {
      try { await replacement!.service.acquireSession(sessionId); return true; } catch (error) {
        if (error instanceof HostSessionOwnerConflictError) return false;
        throw error;
      }
    });
    expect(alive(commandPid)).toBe(false);
    expect((await replacement.service.submitPrompt({ sessionId, text: "resume after guardian cleanup" })).status).toBe("completed");
    expect((await replacement.store.sessions()).map((session) => session.id)).toEqual([sessionId]);
  } finally {
    child.kill("SIGKILL"); await child.exited;
    await replacement?.close();
    if (alive(commandPid)) process.kill(commandPid, "SIGKILL");
  }
}, 15_000);

test("independent processes run different project sessions and one Host close leaves its peer running", async () => {
  const options = await workspace();
  const peer = Bun.spawn([process.execPath, new URL("./fixtures/multiple-hosts.ts", import.meta.url).pathname, options.cwd, options.chiliHome], {
    cwd: options.cwd, stdout: "ignore", stderr: "pipe",
  });
  let local: ChiliHost | undefined;
  let reopened: ChiliHost | undefined;
  try {
    await until(async () => readFile(join(options.cwd, "peer-running"), "utf8").then(() => true, () => false));
    const peerSession = (await readFile(join(options.cwd, "peer-session.id"), "utf8")) as SessionId;
    local = await createChiliHost(options);
    await expect(local.service.acquireSession(peerSession)).rejects.toBeInstanceOf(HostSessionOwnerConflictError);
    const own = await local.service.createSession();
    expect((await local.service.submitPrompt({ sessionId: own.sessionId, text: "independent local work" })).status).toBe("completed");
    await local.close(); local = undefined;
    expect(peer.exitCode).toBeNull();
    reopened = await createChiliHost(options);
    await expect(reopened.service.acquireSession(peerSession)).rejects.toBeInstanceOf(HostSessionOwnerConflictError);
    await writeFile(join(options.cwd, "peer-release"), "release");
    expect(await peer.exited).toBe(0);
    expect(await readFile(join(options.cwd, "peer-completed"), "utf8")).toBe("completed");
    await reopened.service.acquireSession(peerSession);
    expect((await reopened.store.sessions()).map((session) => session.id).sort()).toEqual([own.sessionId, peerSession].sort());
  } finally {
    await writeFile(join(options.cwd, "peer-release"), "release");
    peer.kill("SIGKILL"); await peer.exited;
    await reopened?.close(); await local?.close();
  }
}, 15_000);

function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Owned process did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
