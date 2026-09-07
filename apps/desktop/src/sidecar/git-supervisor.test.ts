import { afterEach, expect, test } from "bun:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gitSupervisorLaunch, type GitSupervisorLaunch } from "../main/git-supervisor-launch.js";
import { processGroupExists, terminateProcessGroup } from "../main/process-groups.js";
import { gitEnvironment } from "../shared/git-environment.js";
import { parseGitResultFrame } from "../shared/git-supervisor-protocol.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const groups = new Set<number>();
const parents = new Set<ChildProcess>();
const posixTest = process.platform === "win32" ? test.skip : test;
const nodeExecutable = Bun.which("node");

// Electron uses Node's child_process. Bun 1.3.14's emulation intermittently
// fails to connect extra stdio sockets, so exercise the real Node parent.
const parentSource = `
  import { spawn } from "node:child_process";
  import { writeFileSync } from "node:fs";
  const config = JSON.parse(process.argv[1]);
  const child = spawn(config.executable, config.args, { cwd: "/", env: config.env,
    detached: config.detached, stdio: [0, 1, 2, "pipe"] });
  const frames = [];
  const channel = child.stdio[3];
  channel.on("data", (chunk) => frames.push(chunk));
  const drained = new Promise((resolve) => {
    channel.once("end", resolve); channel.once("close", resolve); channel.once("error", resolve);
  });
  channel.on("error", () => undefined);
  if (config.incompleteOwner) channel.end("chili.git.owner.v1:");
  else channel.write("chili.git.owner.v1:" + process.pid + ":" + child.pid + "\\n");
  child.once("close", async (code, signal) => {
    await drained;
    writeFileSync(config.resultPath, JSON.stringify({ pid: child.pid, code, signal,
      frame: Buffer.concat(frames).toString("base64") }));
  });
`;

afterEach(async () => {
  for (const parent of parents) if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
  parents.clear();
  await Promise.all([...groups].map((pid) => terminateProcessGroup(pid, { termGraceMs: 100, killGraceMs: 500 })));
  groups.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

posixTest("Git supervisor preserves a large binary batch across delayed output reads and real exit codes", async () => {
  const workspace = await repository();
  const data = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < data.length; index++) data[index] = index % 256;
  await writeFile(join(workspace, "binary.dat"), data);
  await git(workspace, ["add", "binary.dat"]);
  const { stdout } = await git(workspace, ["rev-parse", ":binary.dat"]);
  const oid = stdout.trim();
  const result = await runHelper(workspace, ["cat-file", "--batch"], { input: Buffer.from(`${oid}\n`), pauseOutputMs: 120 });
  expect(parseGitResultFrame(result.frame)).toEqual({ code: 0, signal: null });
  expect(result.stdout).toEqual(Buffer.concat([Buffer.from(`${oid} blob ${data.length}\n`), data, Buffer.from("\n")]));
  expect(result.stderr.length).toBe(0);
  const missingHead = await runHelper(workspace, ["cat-file", "-e", "HEAD^{tree}"]);
  expect(parseGitResultFrame(missingHead.frame)).toEqual({ code: 128, signal: null });
  expect(missingHead.stderr.toString()).toContain("HEAD");
});

posixTest("Git supervisor requires its own group and rejects incomplete owner handshakes", async () => {
  const workspace = await repository();
  const direct = await runHelper(workspace, ["ls-files", "--cached", "--stage", "-z"], { detached: false });
  expect(direct.code).toBe(1);
  expect(direct.frame.length).toBe(0);
  const incomplete = await runHelper(workspace, ["ls-files", "--cached", "--stage", "-z"], { incompleteOwner: true });
  expect(incomplete.frame.length).toBe(0);
});

posixTest("a killed Node owner leaves neither its blocked Git nor its supervisor group alive", async () => {
  const workspace = await repository();
  const fifo = join(workspace, ".git", "include-fifo");
  await execFileAsync("/usr/bin/mkfifo", [fifo]);
  await appendFile(join(workspace, ".git", "config"), `\n[include]\n\tpath = ${fifo}\n`);
  const launch = await gitSupervisorLaunch();
  const source = `
    import { spawn } from "node:child_process";
    const config = JSON.parse(process.argv[1]);
    const child = spawn(config.executable, config.args, {cwd: "/", env: config.env,
      detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"]});
    child.stdio[3].on("error", () => undefined);
    child.stdio[3].resume();
    child.stdio[3].write("chili.git.owner.v1:" + process.pid + ":" + child.pid + "\\n");
    process.stdout.write(String(child.pid) + "\\n");
    child.once("close", () => process.exit(0));
  `;
  const parent = spawnNodeParent(source, {
    executable: launch.executable, args: [...launch.args, ...commandArgs(workspace, ["ls-files", "--cached", "--stage", "-z"])],
    env: gitEnvironment(),
  });
  let helperPid = 0;
  parent.stdout?.on("data", (chunk: Buffer) => { helperPid = Number(chunk.toString().trim()); });
  await waitFor(() => Number.isSafeInteger(helperPid) && helperPid > 0);
  groups.add(helperPid);
  let gitPid = 0;
  await waitFor(async () => {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,comm="]);
    const row = stdout.split("\n").map((line) => line.trim().split(/\s+/u))
      .find((parts) => Number(parts[1]) === helperPid && /(?:^|\/)git$/u.test(parts.slice(3).join(" ")));
    if (!row) return false;
    expect(Number(row[2])).toBe(helperPid);
    gitPid = Number(row[0]);
    return true;
  });
  // Kill only the exact fixture owner. No test cleanup runs before absence is
  // verified: the helper must independently contain its blocked Git group.
  parent.kill("SIGKILL");
  await waitFor(() => !processGroupExists(helperPid));
  groups.delete(helperPid);
  expect(processExists(gitPid)).toBe(false);
}, 10_000);

posixTest("source and compiled helpers ignore workspace dotenv and Bun preload configuration", async () => {
  const workspace = await repository();
  const marker = join(workspace, "preload-ran");
  const preload = join(workspace, "hostile-preload.ts");
  await writeFile(preload, `await Bun.write(${JSON.stringify(marker)}, "executed");\n`);
  await writeFile(join(workspace, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
  await writeFile(join(workspace, ".env"), `GIT_OBJECT_DIRECTORY=${join(workspace, "missing-objects")}\nGIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=core.fsmonitor\nGIT_CONFIG_VALUE_0=${preload}\n`);
  await writeFile(join(workspace, "tracked.txt"), "content\n");
  await git(workspace, ["add", "tracked.txt"]);
  const resources = join(await temporaryDirectory(), "Resources");
  await mkdir(resources);
  await execFileAsync(process.execPath, ["build", "--compile", `--outfile=${join(resources, "chili-sidecar")}`,
    resolve(import.meta.dirname, "entry.ts")], {
    cwd: resolve(import.meta.dirname, "../../../.."), maxBuffer: 1024 * 1024,
  });
  const source = await gitSupervisorLaunch();
  const compiled = await gitSupervisorLaunch({ isPackaged: true, resourcesPath: resources });
  for (const launch of [source, compiled]) {
    const result = await runHelper(workspace, ["ls-files", "--cached", "--stage", "-z"], { launch });
    expect(parseGitResultFrame(result.frame).code).toBe(0);
    expect(result.stdout.toString()).toContain("tracked.txt\0");
    expect(await readFile(marker).then(() => true, () => false)).toBe(false);
  }
}, 30_000);

async function runHelper(workspace: string, operation: readonly string[], options: {
  input?: Buffer; launch?: GitSupervisorLaunch; detached?: boolean; incompleteOwner?: boolean; pauseOutputMs?: number;
} = {}) {
  const launch = options.launch ?? await gitSupervisorLaunch();
  const resultPath = join(await temporaryDirectory(), "result.json");
  const parent = spawnNodeParent(parentSource, {
    executable: launch.executable, args: [...launch.args, ...commandArgs(workspace, operation)], env: gitEnvironment(),
    resultPath, detached: options.detached ?? true, incompleteOwner: options.incompleteOwner ?? false,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  parent.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  parent.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  if (options.pauseOutputMs) {
    parent.stdout?.pause();
    setTimeout(() => parent.stdout?.resume(), options.pauseOutputMs);
  }
  parent.stdin?.on("error", () => undefined);
  parent.stdin?.end(options.input);
  await new Promise<void>((resolveDone, reject) => {
    parent.once("error", reject);
    parent.once("close", (code) => code === 0 ? resolveDone() : reject(new Error(Buffer.concat(stderr).toString())));
  });
  const result = JSON.parse(await readFile(resultPath, "utf8")) as { pid: number; code: number | null; signal: string | null; frame: string };
  if (options.detached !== false) {
    if (processGroupExists(result.pid)) groups.add(result.pid);
    await waitFor(() => !processGroupExists(result.pid));
    groups.delete(result.pid);
  }
  return { code: result.code, frame: Buffer.from(result.frame, "base64"), stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

function spawnNodeParent(source: string, config: object): ChildProcess {
  if (!nodeExecutable) throw new Error("Node is required to test the Electron Git supervisor parent");
  const parent = spawn(nodeExecutable, ["--input-type=module", "-e", source, JSON.stringify(config)], {
    cwd: "/", env: gitEnvironment(), detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  parents.add(parent);
  return parent;
}

function commandArgs(workspace: string, operation: readonly string[]): string[] {
  return ["--no-pager", "--no-replace-objects", `--git-dir=${join(workspace, ".git")}`, `--work-tree=${workspace}`,
    "-c", "core.fsmonitor=false", ...operation];
}

async function repository(): Promise<string> {
  const workspace = await temporaryDirectory();
  await git(workspace, ["init", "-q"]);
  return workspace;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chili-git-supervisor-"));
  directories.push(directory);
  return directory;
}

function git(cwd: string, args: string[]) {
  return execFileAsync("/usr/bin/git", args, { cwd, env: gitEnvironment() });
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("Git supervisor condition did not settle");
}
