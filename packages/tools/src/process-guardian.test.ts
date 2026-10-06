import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { observeProcessGuardianLifecycle, runProcess, withProcessOwner } from "./process.js";

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("guardian registration is durable before the first command side effect", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-guardian-register-"));
  let guardianPid: number | undefined;
  const unsubscribe = observeProcessGuardianLifecycle((event) => {
    if (event.type === "started") {
      guardianPid = event.pid;
      throw new Error("owner registry is unavailable");
    }
  });
  try {
    await expect(runProcess("/bin/bash", ["-c", "printf unsafe > effect"], { cwd: workspace }))
      .rejects.toThrow("owner registry is unavailable");
    await waitUntil(() => !exists(guardianPid));
    await expect(readFile(join(workspace, "effect"))).rejects.toThrow();
  } finally {
    unsubscribe();
    if (exists(guardianPid)) process.kill(guardianPid!, "SIGKILL");
    await rm(workspace, { recursive: true, force: true });
  }
});

posixTest("owner SIGKILL cleans actual TERM-resistant children and grandchildren", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-guardian-crash-"));
  const ownerPath = join(workspace, "owner.ts");
  const processModule = fileURLToPath(new URL("./process.ts", import.meta.url));
  const command = "trap '' TERM; echo $$ > child.pid; /bin/bash -c 'trap '\"'\"''\"'\"' TERM; echo $$ > grandchild.pid; sleep 30 & echo $! > sleep.pid; wait' & wait";
  await writeFile(ownerPath, `
    import { writeFileSync } from "node:fs";
    import { runProcess, observeProcessGuardianLifecycle } from ${JSON.stringify(processModule)};
    observeProcessGuardianLifecycle(event => {
      if (event.type === "started") writeFileSync("guardian.pid", String(event.pid));
    });
    await runProcess("/bin/bash", ["-c", ${JSON.stringify(command)}], { cwd: ${JSON.stringify(workspace)}, killGraceMs: 80 });
  `);
  const owner = spawn(process.execPath, [ownerPath], { cwd: workspace, stdio: "ignore" });
  const events = owner as typeof owner & Pick<EventEmitter<{ exit: [code: number | null, signal: NodeJS.Signals | null] }>, "once">;
  const exited = new Promise<void>((resolve) => events.once("exit", () => resolve()));
  const pids: number[] = [];
  try {
    for (const name of ["guardian", "child", "grandchild", "sleep"]) {
      let pid = 0;
      await waitUntil(async () => {
        try { pid = Number(await readFile(join(workspace, `${name}.pid`), "utf8")); return pid > 0; } catch { return false; }
      });
      pids.push(pid);
      expect(exists(pid)).toBe(true);
    }
    owner.kill("SIGKILL");
    await exited;
    await waitUntil(() => pids.every((pid) => !exists(pid)));
    expect(pids.every((pid) => !exists(pid))).toBe(true);
  } finally {
    owner.kill("SIGKILL");
    await exited;
    for (const pid of pids) {
      if (exists(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

posixTest("guardian ownership follows async execution and is released before runProcess returns", async () => {
  const owners: { ownerId?: string; type: string }[] = [];
  const unsubscribe = observeProcessGuardianLifecycle((event) => owners.push(event));
  try {
    await Promise.all(["owner-a", "owner-b"].map((owner) => withProcessOwner(owner, async () => {
      await Promise.resolve();
      await runProcess("/bin/sleep", ["0.02"], { cwd: tmpdir() });
      expect(owners.filter((event) => event.ownerId === owner).map((event) => event.type)).toEqual(["started", "finished"]);
    })));
  } finally { unsubscribe(); }
});

posixTest("cancellation during guardian startup drains the group before returning", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-guardian-start-cancel-"));
  const controller = new AbortController();
  let pid: number | undefined;
  const unsubscribe = observeProcessGuardianLifecycle((event) => {
    if (event.type === "started") {
      pid = event.pid;
      queueMicrotask(() => controller.abort());
    }
  });
  try {
    await expect(runProcess("/bin/sh", ["-c", "printf unsafe > effect"], { cwd: workspace, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(exists(pid)).toBe(false);
    await expect(readFile(join(workspace, "effect"))).rejects.toThrow();
  } finally {
    unsubscribe();
    await rm(workspace, { recursive: true, force: true });
  }
});

posixTest("cancellation interrupts the final authority check without permitting a late launch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-guardian-authority-cancel-"));
  const controller = new AbortController();
  let allow!: () => void;
  let checking!: () => void;
  const reached = new Promise<void>((resolve) => { checking = resolve; });
  const authority = new Promise<void>((resolve) => { allow = resolve; });
  try {
    const run = runProcess("/bin/sh", ["-c", "printf unsafe > effect"], {
      cwd: workspace,
      signal: controller.signal,
      beforeSpawn: async () => { checking(); await authority; },
    });
    await reached;
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    allow();
    await Promise.resolve();
    await expect(readFile(join(workspace, "effect"))).rejects.toThrow();
  } finally { allow?.(); await rm(workspace, { recursive: true, force: true }); }
});

posixTest("guardian startup ignores tool runtime preload settings and project config", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-guardian-preload-"));
  try {
    const marker = join(workspace, "unsafe");
    const preload = join(workspace, "preload.js");
    await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe");`);
    await writeFile(join(workspace, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
    expect((await runProcess("/bin/sh", ["-c", "exit 0"], {
      cwd: workspace,
      env: { NODE_OPTIONS: `--require ${preload}` },
    })).exitCode).toBe(0);
    await expect(readFile(marker)).rejects.toThrow();
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

posixTest("compiled application executable can run its own process guardian entry", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chili-guardian-compiled-"));
  try {
    const entry = join(workspace, "entry.ts");
    const binary = join(workspace, "fixture");
    await writeFile(entry, `
      import { PROCESS_GUARDIAN_MODE, runProcessGuardianEntrypoint, runProcess } from ${JSON.stringify(fileURLToPath(new URL("./process.ts", import.meta.url)))};
      if (process.argv[2] === PROCESS_GUARDIAN_MODE) runProcessGuardianEntrypoint();
      else {
        const result = await runProcess("/bin/echo", ["compiled-ok"], { cwd: ${JSON.stringify(workspace)} });
        process.stdout.write(result.stdout);
      }
    `);
    const build = Bun.spawn([process.execPath, "build", "--compile", `--outfile=${binary}`, entry], { stdout: "ignore", stderr: "pipe" });
    const errors = await new Response(build.stderr).text();
    if (await build.exited !== 0) throw new Error(errors);
    const app = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" });
    expect(await new Response(app.stdout).text()).toBe("compiled-ok\n");
    expect(await app.exited).toBe(0);
  } finally { await rm(workspace, { recursive: true, force: true }); }
}, 15_000);

function exists(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Process state did not settle before deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
