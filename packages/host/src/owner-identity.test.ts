import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { HostOwnerConflictError } from "@chili/store";
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

test("Host rejects a second execution owner and releases ownership after close", async () => {
  const options = await workspace();
  const first = await createChiliHost(options);
  try {
    await expect(createChiliHost(options)).rejects.toBeInstanceOf(HostOwnerConflictError);
    const session = await first.service.createSession();
    const created = (await first.store.events({ sessionId: session.sessionId })).find((event) => event.type === "session.created");
    expect(created?.payload).toMatchObject({ identity: first.identity });
  } finally { await first.close(); }
  const next = await createChiliHost(options); await next.close();
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

test("hard-killed Host cannot be replaced until its external process group has stopped", async () => {
  if (process.platform === "win32") return;
  const { readFile } = await import("node:fs/promises");
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
    await expect(createChiliHost(options)).rejects.toBeInstanceOf(HostOwnerConflictError);
    child.kill("SIGKILL"); await child.exited;
    await until(async () => {
      try { replacement = await createChiliHost(options); return true; } catch (error) {
        if (error instanceof HostOwnerConflictError) return false;
        throw error;
      }
    });
    expect(alive(commandPid)).toBe(false);
  } finally {
    child.kill("SIGKILL"); await child.exited;
    await replacement?.close();
    if (alive(commandPid)) process.kill(commandPid, "SIGKILL");
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
