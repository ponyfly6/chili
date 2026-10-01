import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DesktopSmokeOwnership } from "./desktop-smoke-ownership.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sharedRelease = join(repositoryRoot, "apps/desktop/release");
const describeMac = process.platform === "darwin" ? describe : describe.skip;

describeMac("desktop smoke run isolation", () => {
  test("never claims or signals a sibling with the same executable and argv", async () => {
    const sentinel = spawnSentinel();
    const owned = spawnSentinel();
    const ownership = new DesktopSmokeOwnership();
    try {
      ownership.registerSpawn(owned.pid);
      const rows = ownership.scan();
      expect(rows.some((row) => row.pid === owned.pid)).toBe(true);
      expect(rows.some((row) => row.pid === sentinel.pid)).toBe(false);
      expect(() => ownership.signalPid(sentinel.pid, "SIGTERM")).toThrow("without current-run launch ownership");
      expect(() => ownership.signalGroup(sentinel.pid, "SIGTERM")).toThrow("without current-run launch ownership");
      ownership.signalGroup(owned.pid, "SIGTERM");
      await withTimeout(owned.exited, 5_000);
      expect(isAlive(sentinel.pid)).toBe(true);
    } finally {
      await stopSpawned(owned);
      await stopSpawned(sentinel);
    }
  });

  test("retains observed inherited and detached descendants after their parent exits", async () => {
    const sentinel = spawnSentinel();
    const parent = Bun.spawn({
      cmd: [process.execPath, "-e", `
        const inherited = Bun.spawn({ cmd: ["/bin/sleep", "60"], stdout: "ignore", stderr: "ignore" });
        const detached = Bun.spawn({ cmd: ["/bin/sleep", "60"], detached: true, stdout: "ignore", stderr: "ignore" });
        process.stdout.write(JSON.stringify({ inherited: inherited.pid, detached: detached.pid }) + "\\n");
        setInterval(() => {}, 1000);
      `],
      detached: true,
      stdout: "pipe",
      stderr: "ignore",
    });
    const ownership = new DesktopSmokeOwnership();
    let descendantGroup: number | undefined;
    try {
      ownership.registerSpawn(parent.pid);
      const reader = parent.stdout.getReader();
      const chunk = await withTimeout(reader.read(), 5_000);
      reader.releaseLock();
      if (chunk.done) throw new Error("Ownership fixture exited before reporting children");
      const descendants = JSON.parse(new TextDecoder().decode(chunk.value)) as { inherited: number; detached: number };
      descendantGroup = descendants.detached;
      const rows = ownership.scan();
      expect(rows.some((row) => row.pid === descendants.inherited)).toBe(true);
      expect(rows.some((row) => row.pid === descendants.detached)).toBe(true);
      ownership.signalPid(parent.pid, "SIGKILL");
      await withTimeout(parent.exited, 5_000);
      expect(isAlive(descendants.inherited)).toBe(true);
      expect(isAlive(descendants.detached)).toBe(true);
      const orphans = ownership.scan();
      expect(orphans.some((row) => row.pid === descendants.inherited)).toBe(true);
      expect(orphans.some((row) => row.pid === descendants.detached)).toBe(true);
      ownership.signalGroup(parent.pid, "SIGTERM");
      ownership.signalGroup(descendants.detached, "SIGTERM");
      await waitUntilGone(descendants.inherited);
      await waitUntilGone(descendants.detached);
      expect(isAlive(sentinel.pid)).toBe(true);
    } finally {
      ownership.signalGroup(parent.pid, "SIGKILL");
      if (descendantGroup) ownership.signalGroup(descendantGroup, "SIGKILL");
      await stopSpawned(parent);
      await stopSpawned(sentinel);
    }
  });

  for (const mode of ["success", "failure", "SIGINT", "SIGTERM"] as const) {
    test(`${mode}: cleans only its processes and temp artifacts, preserving shared release and an existing process`, async () => {
      const releaseExisted = await exists(sharedRelease);
      await mkdir(sharedRelease, { recursive: true });
      const marker = join(sharedRelease, `.isolation-sentinel-${randomBytes(12).toString("hex")}`);
      await writeFile(marker, randomBytes(32), { flag: "wx" });
      const before = await fingerprint(sharedRelease);
      const sentinel = spawnSentinel();
      const run = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dirname, "smoke-desktop.ts"), `--isolation-fixture=${mode.startsWith("SIG") ? "hold" : mode}`],
        cwd: repositoryRoot,
        detached: true,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new Response(run.stderr).text();
      let ready: Ready | undefined;
      try {
        ready = await readReady(run.stdout);
        expect(ready.releaseRoot).toBe(join(ready.temporaryRoot, "release"));
        expect(ready.buildRoot).toBe(join(ready.temporaryRoot, "build"));
        expect(ready.releaseRoot).not.toBe(sharedRelease);
        if (mode === "SIGINT" || mode === "SIGTERM") run.kill(mode);
        const exitCode = await withTimeout(run.exited, 15_000);
        const diagnostic = await stderr;
        expect(exitCode, diagnostic).toBe(mode === "success" ? 0 : mode === "failure" ? 1 : mode === "SIGINT" ? 130 : 143);
        expect(isAlive(ready.childPid)).toBe(false);
        expect(isAlive(ready.descendantPid)).toBe(false);
        expect(await exists(ready.temporaryRoot)).toBe(false);
        expect(isAlive(sentinel.pid)).toBe(true);
        expect(await fingerprint(sharedRelease)).toEqual(before);
      } finally {
        await stopSpawned(run);
        await stopSpawned(sentinel);
        await rm(marker, { force: true });
        // Never recursively remove shared release, including in test failure.
        if (!releaseExisted) await rmdir(sharedRelease).catch(() => undefined);
      }
    }, 20_000);
  }

  test("concurrent smoke runs have independent build and release roots", async () => {
    const runs = [0, 1].map(() => Bun.spawn({
      cmd: [process.execPath, join(import.meta.dirname, "smoke-desktop.ts"), "--isolation-fixture=hold"],
      cwd: repositoryRoot,
      detached: true,
      stdout: "pipe",
      stderr: "ignore",
    }));
    try {
      const ready = await Promise.all(runs.map((run) => readReady(run.stdout)));
      expect(ready[0]!.temporaryRoot).not.toBe(ready[1]!.temporaryRoot);
      expect(ready[0]!.releaseRoot).not.toBe(ready[1]!.releaseRoot);
      expect(ready[0]!.buildRoot).not.toBe(ready[1]!.buildRoot);
      runs[0]!.kill("SIGTERM");
      await withTimeout(runs[0]!.exited, 15_000);
      expect(isAlive(ready[1]!.childPid)).toBe(true);
      expect(isAlive(ready[1]!.descendantPid)).toBe(true);
      expect(await exists(join(ready[1]!.releaseRoot, "owned-artifact"))).toBe(true);
      runs[1]!.kill("SIGTERM");
      await withTimeout(runs[1]!.exited, 15_000);
      expect(ready.every((value) => !isAlive(value.childPid))).toBe(true);
      expect(ready.every((value) => !isAlive(value.descendantPid))).toBe(true);
    } finally {
      await Promise.all(runs.map((run) => stopSpawned(run)));
    }
  }, 30_000);
});

interface Ready {
  temporaryRoot: string;
  releaseRoot: string;
  buildRoot: string;
  childPid: number;
  descendantPid: number;
}

function spawnSentinel() {
  return Bun.spawn({
    cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function readReady(stream: ReadableStream<Uint8Array>): Promise<Ready> {
  const reader = stream.getReader();
  let output = "";
  try {
    while (!output.includes("\n")) {
      const chunk = await withTimeout(reader.read(), 5_000);
      if (chunk.done) throw new Error(`Smoke fixture exited before readiness: ${output}`);
      output += new TextDecoder().decode(chunk.value);
      if (output.length > 16_384) throw new Error("Oversized smoke fixture readiness");
    }
    const line = output.split("\n").find((value) => value.startsWith("CHILI_DESKTOP_ISOLATION_READY "));
    if (!line) throw new Error(`Missing smoke fixture readiness: ${output}`);
    return JSON.parse(line.slice("CHILI_DESKTOP_ISOLATION_READY ".length)) as Ready;
  } finally {
    reader.releaseLock();
  }
}

async function fingerprint(root: string): Promise<string[]> {
  const rows: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory)).sort()) {
      const path = join(directory, entry);
      const metadata = await lstat(path);
      const label = path.slice(root.length);
      if (metadata.isDirectory()) {
        rows.push(`${label}:directory:${metadata.mode}`);
        await visit(path);
      } else if (metadata.isSymbolicLink()) {
        rows.push(`${label}:symlink:${await readlink(path)}`);
      } else {
        const hash = createHash("sha256").update(await readFile(path)).digest("hex");
        rows.push(`${label}:file:${metadata.mode}:${metadata.mtimeMs}:${hash}`);
      }
    }
  };
  await visit(root);
  return rows;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function stopSpawned(child: { pid: number; exitCode: number | null; exited: Promise<number>; kill(signal: NodeJS.Signals): void }): Promise<void> {
  // These are direct spawn handles owned by this test, never discovered PIDs.
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await withTimeout(child.exited, 15_000).catch(async () => {
    child.kill("SIGKILL");
    await withTimeout(child.exited, 5_000);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Isolation fixture timed out")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(20);
  expect(isAlive(pid)).toBe(false);
}
